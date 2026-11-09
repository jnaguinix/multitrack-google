/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Dedicated Web Worker for OPFS PCM reading.
 *
 * Characteristics:
 * - Uses FileSystemSyncAccessHandle (synchronous, zero UI-thread contention).
 * - Transparent fallback to fileHandle.getFile().slice().arrayBuffer() if sync handles are unavailable.
 * - Keeps an open pool of access handles per project to avoid file open/close latency.
 * - Priority queue: 'seek' (0) > 'active' (1) > 'next' (2).
 * - Generation tracking: drops obsolete chunk requests immediately on seek or song switch.
 * - Quantization conversion: Int16 interleaved stereo -> planar Float32 (left & right).
 * - Zero-copy transfer: transfers Float32Array buffers back to the main thread.
 * - Performance metrics: measures read + conversion time per chunk (readMs).
 */

export type ChunkPriority = 'seek' | 'active' | 'next';

export interface ReadChunkRequest {
  type: 'READ_CHUNK';
  requestId: string;
  generation: number;
  priority: ChunkPriority;
  projectId: string;
  trackId: string;
  startFrame: number;
  frameCount: number;
  /** 1 = mono Int16, 2 = interleaved stereo Int16 (default 2) */
  channels?: 1 | 2;
}

export interface OpenProjectRequest {
  type: 'OPEN_PROJECT';
  projectId: string;
  trackIds: string[];
  role: 'active' | 'next';
}

export interface CloseProjectRequest {
  type: 'CLOSE_PROJECT';
  projectId: string;
}

export interface CancelGenerationRequest {
  type: 'CANCEL_GENERATION';
  generation: number;
}

export type WorkerInMessage =
  | ReadChunkRequest
  | OpenProjectRequest
  | CloseProjectRequest
  | CancelGenerationRequest;

export interface ChunkDataResponse {
  type: 'CHUNK_DATA';
  requestId: string;
  generation: number;
  projectId: string;
  trackId: string;
  startFrame: number;
  frameCount: number;
  leftChannel: Float32Array;
  rightChannel: Float32Array;
  readMs: number;
}

export interface ChunkErrorResponse {
  type: 'CHUNK_ERROR';
  requestId: string;
  generation: number;
  projectId: string;
  trackId: string;
  error: string;
}

export interface ProjectOpenedResponse {
  type: 'PROJECT_OPENED';
  projectId: string;
  openedTracks: string[];
  supportsSyncHandles: boolean;
}

interface TrackHandleEntry {
  projectId: string;
  trackId: string;
  fileHandle: FileSystemFileHandle;
  syncHandle: any | null; // FileSystemSyncAccessHandle
}

const OPFS_ROOT_DIR = 'pcm';

// Cache of open access handles by key: `${projectId}:${trackId}`
const handlePool = new Map<string, TrackHandleEntry>();

// Priority queue for pending chunk reads
const requestQueue: ReadChunkRequest[] = [];
let isProcessingQueue = false;
let currentActiveGeneration = 0;

const PRIORITY_ORDER: Record<ChunkPriority, number> = {
  seek: 0,
  active: 1,
  next: 2,
};

async function getPcmDirectory(projectId: string): Promise<FileSystemDirectoryHandle | null> {
  try {
    if (typeof navigator === 'undefined' || !navigator.storage || !navigator.storage.getDirectory) {
      return null;
    }
    const root = await navigator.storage.getDirectory();
    const pcmRoot = await root.getDirectoryHandle(OPFS_ROOT_DIR, { create: false });
    return await pcmRoot.getDirectoryHandle(projectId, { create: false });
  } catch {
    return null;
  }
}

async function openTrackHandle(
  projectId: string,
  trackId: string
): Promise<TrackHandleEntry | null> {
  const key = `${projectId}:${trackId}`;
  const existing = handlePool.get(key);
  if (existing) return existing;

  const projDir = await getPcmDirectory(projectId);
  if (!projDir) return null;

  try {
    const fileHandle = await projDir.getFileHandle(`${trackId}.pcm`, { create: false });
    let syncHandle: any = null;

    // Try synchronous access handle (supported in dedicated Web Workers)
    // @ts-expect-error createSyncAccessHandle is standard in dedicated workers
    if (typeof fileHandle.createSyncAccessHandle === 'function') {
      try {
        // @ts-expect-error createSyncAccessHandle is standard in dedicated workers
        syncHandle = await fileHandle.createSyncAccessHandle();
      } catch (err) {
        console.warn(`[PcmReaderWorker] No se pudo abrir syncHandle para ${key}:`, err);
        syncHandle = null;
      }
    }

    const entry: TrackHandleEntry = {
      projectId,
      trackId,
      fileHandle,
      syncHandle,
    };

    handlePool.set(key, entry);
    return entry;
  } catch (err) {
    console.warn(`[PcmReaderWorker] Archivo no encontrado para ${key}:`, err);
    return null;
  }
}

function closeProjectHandles(projectId: string) {
  const keysToRemove: string[] = [];
  for (const [key, entry] of handlePool.entries()) {
    if (entry.projectId === projectId) {
      if (entry.syncHandle && typeof entry.syncHandle.close === 'function') {
        try {
          entry.syncHandle.close();
        } catch {
          // ignore
        }
      }
      keysToRemove.push(key);
    }
  }
  for (const k of keysToRemove) {
    handlePool.delete(k);
  }
}

async function handleOpenProject(msg: OpenProjectRequest) {
  const openedTracks: string[] = [];
  let supportsSyncHandles = false;

  for (const trackId of msg.trackIds) {
    const entry = await openTrackHandle(msg.projectId, trackId);
    if (entry) {
      openedTracks.push(trackId);
      if (entry.syncHandle) {
        supportsSyncHandles = true;
      }
    }
  }

  const response: ProjectOpenedResponse = {
    type: 'PROJECT_OPENED',
    projectId: msg.projectId,
    openedTracks,
    supportsSyncHandles,
  };
  self.postMessage(response);
}

function enqueueRequest(req: ReadChunkRequest) {
  if (req.generation < currentActiveGeneration) {
    return; // Drop stale request immediately
  }

  // Insert maintaining priority order: seek (0) < active (1) < next (2)
  const reqPri = PRIORITY_ORDER[req.priority];
  let insertIdx = requestQueue.length;

  for (let i = 0; i < requestQueue.length; i++) {
    if (reqPri < PRIORITY_ORDER[requestQueue[i].priority]) {
      insertIdx = i;
      break;
    }
  }

  requestQueue.splice(insertIdx, 0, req);
  scheduleProcessQueue();
}

function scheduleProcessQueue() {
  if (isProcessingQueue) return;
  isProcessingQueue = true;
  setTimeout(processQueue, 0);
}

async function processQueue() {
  while (requestQueue.length > 0) {
    const req = requestQueue.shift()!;

    // Check if request is obsolete due to a newer generation
    if (req.generation < currentActiveGeneration) {
      continue;
    }

    await executeChunkRead(req);
  }
  isProcessingQueue = false;
}

// Reusable Int16 read buffer to avoid allocating intermediate arrays
let sharedInt16Buffer: Int16Array | null = null;

function getSharedInt16Buffer(sampleCount: number): Int16Array {
  if (!sharedInt16Buffer || sharedInt16Buffer.length < sampleCount) {
    // Round up to power of 2 or next 64k samples
    const size = Math.max(131072, Math.pow(2, Math.ceil(Math.log2(sampleCount))));
    sharedInt16Buffer = new Int16Array(size);
  }
  return sharedInt16Buffer;
}

async function executeChunkRead(req: ReadChunkRequest) {
  const t0 = performance.now();
  const key = `${req.projectId}:${req.trackId}`;

  let entry = handlePool.get(key);
  if (!entry) {
    entry = (await openTrackHandle(req.projectId, req.trackId)) || undefined;
  }

  if (!entry) {
    const errRes: ChunkErrorResponse = {
      type: 'CHUNK_ERROR',
      requestId: req.requestId,
      generation: req.generation,
      projectId: req.projectId,
      trackId: req.trackId,
      error: `Pista "${req.trackId}" no encontrada en OPFS`,
    };
    self.postMessage(errRes);
    return;
  }

  const requestedFrames = req.frameCount;
  const channels = req.channels === 1 ? 1 : 2;
  const bytesPerFrame = channels * 2; // Int16 per channel
  const requestedBytes = requestedFrames * bytesPerFrame;
  const byteOffset = req.startFrame * bytesPerFrame;

  let actualBytesRead = 0;
  const targetInt16 = getSharedInt16Buffer(requestedFrames * channels);

  try {
    if (entry.syncHandle) {
      // Fast path: Synchronous Access Handle read (0 ms UI wait)
      const readSubView = new Uint8Array(
        targetInt16.buffer,
        targetInt16.byteOffset,
        requestedBytes
      );
      actualBytesRead = entry.syncHandle.read(readSubView, { at: byteOffset });
    } else {
      // Fallback path: asynchronous file.slice().arrayBuffer()
      const file = await entry.fileHandle.getFile();
      const slice = file.slice(byteOffset, byteOffset + requestedBytes);
      const arrBuf = await slice.arrayBuffer();
      const readInt16 = new Int16Array(arrBuf);
      targetInt16.set(readInt16, 0);
      actualBytesRead = arrBuf.byteLength;
    }
  } catch (err: any) {
    const errRes: ChunkErrorResponse = {
      type: 'CHUNK_ERROR',
      requestId: req.requestId,
      generation: req.generation,
      projectId: req.projectId,
      trackId: req.trackId,
      error: err?.message || 'Error leyendo chunk desde OPFS',
    };
    self.postMessage(errRes);
    return;
  }

  const actualFramesRead = Math.floor(actualBytesRead / bytesPerFrame);

  // Convert interleaved Int16 [L0, R0, L1, R1, ...] into planar Float32
  // Mono files return an empty rightChannel (the consumer builds a 1-channel AudioBuffer)
  const leftChannel = new Float32Array(actualFramesRead);
  const rightChannel = new Float32Array(channels === 2 ? actualFramesRead : 0);
  const inv32768 = 1.0 / 32768.0;

  if (channels === 1) {
    for (let i = 0; i < actualFramesRead; i++) {
      const l = targetInt16[i];
      leftChannel[i] = l < 0 ? l * inv32768 : l / 32767.0;
    }
  } else {
    for (let i = 0; i < actualFramesRead; i++) {
      const l = targetInt16[i * 2];
      const r = targetInt16[i * 2 + 1];
      leftChannel[i] = l < 0 ? l * inv32768 : l / 32767.0;
      rightChannel[i] = r < 0 ? r * inv32768 : r / 32767.0;
    }
  }

  const readMs = performance.now() - t0;

  // Drop response if generation became stale while reading
  if (req.generation < currentActiveGeneration) {
    return;
  }

  const response: ChunkDataResponse = {
    type: 'CHUNK_DATA',
    requestId: req.requestId,
    generation: req.generation,
    projectId: req.projectId,
    trackId: req.trackId,
    startFrame: req.startFrame,
    frameCount: actualFramesRead,
    leftChannel,
    rightChannel,
    readMs,
  };

  // Transfer Float32Array buffers with zero copy
  (self as unknown as Worker).postMessage(response, [
    leftChannel.buffer,
    rightChannel.buffer,
  ]);
}

self.onmessage = function (e: MessageEvent<WorkerInMessage>) {
  const msg = e.data;
  if (!msg) return;

  switch (msg.type) {
    case 'OPEN_PROJECT':
      handleOpenProject(msg).catch((err) => {
        console.error('[PcmReaderWorker] Error opening project:', err);
      });
      break;

    case 'CLOSE_PROJECT':
      closeProjectHandles(msg.projectId);
      self.postMessage({ type: 'PROJECT_CLOSED', projectId: msg.projectId });
      break;

    case 'CANCEL_GENERATION':
      currentActiveGeneration = Math.max(currentActiveGeneration, msg.generation);
      // Remove all queued requests with generation < currentActiveGeneration
      for (let i = requestQueue.length - 1; i >= 0; i--) {
        if (requestQueue[i].generation < currentActiveGeneration) {
          requestQueue.splice(i, 1);
        }
      }
      break;

    case 'READ_CHUNK':
      enqueueRequest(msg);
      break;

    default:
      break;
  }
};
