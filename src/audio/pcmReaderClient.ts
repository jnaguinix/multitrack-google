/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  ChunkDataResponse,
  ChunkErrorResponse,
  ChunkPriority,
  ProjectOpenedResponse,
  WorkerInMessage,
} from './pcmReader.worker';

export interface PcmChunkResult {
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

export interface PcmReaderMetrics {
  totalReads: number;
  totalReadMs: number;
  lastReadMs: number;
  avgReadMs: number;
  p95ReadMs: number;
  maxReadMs: number;
  syncHandlesSupported: boolean;
}

/**
 * Main-thread client for pcmReader.worker.ts.
 *
 * Provides:
 * - Handle pooling via worker
 * - Generation tracking for instant seek cancellation
 * - Priority queuing ('seek' > 'active' > 'next')
 * - Zero-copy Float32 planar audio chunk delivery
 * - Performance metrics (readMs, p95ReadMs, syncHandlesSupported)
 */
export class PcmReaderClient {
  private worker: Worker | null = null;
  private currentGeneration = 1;
  private requestSeq = 0;
  private syncHandlesSupported = false;
  private recentReadTimes: number[] = [];

  private pendingRequests = new Map<
    string,
    {
      resolve: (result: PcmChunkResult) => void;
      reject: (err: Error) => void;
      generation: number;
    }
  >();

  private openProjectResolvers = new Map<
    string,
    (res: { openedTracks: string[]; supportsSyncHandles: boolean }) => void
  >();

  // Performance telemetry
  private metrics: PcmReaderMetrics = {
    totalReads: 0,
    totalReadMs: 0,
    lastReadMs: 0,
    avgReadMs: 0,
    p95ReadMs: 0,
    maxReadMs: 0,
    syncHandlesSupported: false,
  };

  constructor() {
    this.ensureWorker();
  }

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;

    this.worker = new Worker(new URL('./pcmReader.worker.ts', import.meta.url), {
      type: 'module',
    });

    this.worker.onmessage = (e: MessageEvent<any>) => {
      this.handleWorkerMessage(e.data);
    };

    this.worker.onerror = (err) => {
      console.error('[PcmReaderClient] Error fatal en Web Worker de lectura PCM:', err);
    };

    return this.worker;
  }

  private handleWorkerMessage(data: any) {
    if (!data || !data.type) return;

    if (data.type === 'CHUNK_DATA') {
      const res = data as ChunkDataResponse;
      const pending = this.pendingRequests.get(res.requestId);
      if (pending) {
        this.pendingRequests.delete(res.requestId);

        // Update telemetry
        this.metrics.totalReads++;
        this.metrics.totalReadMs += res.readMs;
        this.metrics.lastReadMs = res.readMs;
        this.metrics.avgReadMs = this.metrics.totalReadMs / this.metrics.totalReads;
        this.metrics.maxReadMs = Math.max(this.metrics.maxReadMs, res.readMs);

        this.recentReadTimes.push(res.readMs);
        if (this.recentReadTimes.length > 200) {
          this.recentReadTimes.shift();
        }
        const sorted = [...this.recentReadTimes].sort((a, b) => a - b);
        const p95Idx = Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95));
        this.metrics.p95ReadMs = sorted[p95Idx] || 0;

        if (res.generation >= this.currentGeneration) {
          pending.resolve(res);
        } else {
          // Chunk was for a superseded generation; drop silently
          pending.resolve({
            ...res,
            frameCount: 0,
            leftChannel: new Float32Array(0),
            rightChannel: new Float32Array(0),
          });
        }
      }
    } else if (data.type === 'CHUNK_ERROR') {
      const errRes = data as ChunkErrorResponse;
      const pending = this.pendingRequests.get(errRes.requestId);
      if (pending) {
        this.pendingRequests.delete(errRes.requestId);
        if (errRes.generation >= this.currentGeneration) {
          pending.reject(new Error(errRes.error));
        }
      }
    } else if (data.type === 'PROJECT_OPENED') {
      const opened = data as ProjectOpenedResponse;
      this.syncHandlesSupported = opened.supportsSyncHandles;
      this.metrics.syncHandlesSupported = opened.supportsSyncHandles;
      const resolver = this.openProjectResolvers.get(opened.projectId);
      if (resolver) {
        this.openProjectResolvers.delete(opened.projectId);
        resolver({
          openedTracks: opened.openedTracks,
          supportsSyncHandles: opened.supportsSyncHandles,
        });
      }
    }
  }

  /**
   * Instructs the worker to open access handles for all stems of a project
   */
  public async openProject(
    projectId: string,
    trackIds: string[],
    role: 'active' | 'next' = 'active'
  ): Promise<{ openedTracks: string[]; supportsSyncHandles: boolean }> {
    const worker = this.ensureWorker();
    return new Promise((resolve) => {
      this.openProjectResolvers.set(projectId, resolve);
      const msg: WorkerInMessage = {
        type: 'OPEN_PROJECT',
        projectId,
        trackIds,
        role,
      };
      worker.postMessage(msg);

      // Safety timeout: resolve after 2.5s even if worker took long
      setTimeout(() => {
        if (this.openProjectResolvers.has(projectId)) {
          this.openProjectResolvers.delete(projectId);
          resolve({ openedTracks: trackIds, supportsSyncHandles: this.syncHandlesSupported });
        }
      }, 2500);
    });
  }

  /**
   * Closes handles for a project when it is no longer active or queued
   */
  public closeProject(projectId: string): void {
    if (!this.worker) return;
    const msg: WorkerInMessage = {
      type: 'CLOSE_PROJECT',
      projectId,
    };
    this.worker.postMessage(msg);
  }

  /**
   * Increments the generation counter and cancels pending chunk reads.
   * Call on seek or song switch to prevent obsolete audio from filling current buffers.
   */
  public bumpGeneration(): number {
    this.currentGeneration++;
    if (this.worker) {
      const msg: WorkerInMessage = {
        type: 'CANCEL_GENERATION',
        generation: this.currentGeneration,
      };
      this.worker.postMessage(msg);
    }

    // Immediately resolve or reject pending requests from older generations
    for (const [reqId, pending] of this.pendingRequests.entries()) {
      if (pending.generation < this.currentGeneration) {
        this.pendingRequests.delete(reqId);
        pending.resolve({
          requestId: reqId,
          generation: pending.generation,
          projectId: '',
          trackId: '',
          startFrame: 0,
          frameCount: 0,
          leftChannel: new Float32Array(0),
          rightChannel: new Float32Array(0),
          readMs: 0,
        });
      }
    }

    return this.currentGeneration;
  }

  public getGeneration(): number {
    return this.currentGeneration;
  }

  /**
   * Reads a chunk of PCM audio from OPFS via the worker.
   */
  public readChunk(params: {
    projectId: string;
    trackId: string;
    startFrame: number;
    frameCount: number;
    priority?: ChunkPriority;
    generation?: number;
  }): Promise<PcmChunkResult> {
    const worker = this.ensureWorker();
    const requestId = `chunk-${++this.requestSeq}`;
    const generation = params.generation ?? this.currentGeneration;
    const priority = params.priority ?? 'active';

    return new Promise<PcmChunkResult>((resolve, reject) => {
      this.pendingRequests.set(requestId, {
        resolve,
        reject,
        generation,
      });

      const msg: WorkerInMessage = {
        type: 'READ_CHUNK',
        requestId,
        generation,
        priority,
        projectId: params.projectId,
        trackId: params.trackId,
        startFrame: params.startFrame,
        frameCount: params.frameCount,
      };

      worker.postMessage(msg);
    });
  }

  public getMetrics(): PcmReaderMetrics {
    return { ...this.metrics };
  }

  public terminate(): void {
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
    this.pendingRequests.clear();
    this.openProjectResolvers.clear();
  }
}

// Global singleton instance for the app
export const pcmReaderClient = new PcmReaderClient();

if (typeof window !== 'undefined') {
  (window as unknown as { __pcmReaderClient: PcmReaderClient }).__pcmReaderClient =
    pcmReaderClient;
}
