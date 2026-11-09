import { SongProject, SongSection } from '../types/project';
import { deleteProjectPcm } from './opfsStorage';
import {
  collectAudioFromDirectory,
  getRegisteredHandle,
  queryReadPermission,
  requestReadPermission,
} from './sourceFiles';

const DB_NAME = 'LibreTracksWebDB';
const DB_VERSION = 1;
const STORE_PROJECTS = 'projects';
const STORE_AUDIO = 'audioBuffers';

export interface StoredAudioStem {
  key: string; // `${projectId}:${trackId}`
  projectId: string;
  trackId: string;
  blob?: Blob;
  arrayBuffer?: ArrayBuffer;
  mimeType: string;
  fileName: string;
  /** Reference to the original file on disk (instead of a copied Blob) */
  fileHandle?: any;
  /** Folder the file was imported from (one permission prompt covers all its files) */
  dirHandle?: any;
  /** Set when loading: why a handle-based stem could not be read right now */
  unavailable?: 'permission' | 'missing';
}

let cachedDbPromise: Promise<IDBDatabase> | null = null;

/**
 * Ensures any legacy bar-only sections have valid startTimeSec and endTimeSec in seconds
 */
export function normalizeProjectSectionsToTime(project: SongProject): SongProject {
  const secPerBar = (60 / (project.bpm || 120)) * (project.beatsPerBar || 4);
  const totalSec = Math.max(
    1,
    project.durationSec || (project.totalBars || 24) * secPerBar
  );

  if (!Array.isArray(project.sections) || project.sections.length === 0) {
    return {
      ...project,
      durationSec: totalSec,
      sections: [],
    };
  }

  const normalized: SongSection[] = project.sections.map((sec, idx) => {
    const hasTime =
      typeof sec.startTimeSec === 'number' &&
      typeof sec.endTimeSec === 'number' &&
      sec.endTimeSec > sec.startTimeSec;

    if (hasTime) {
      return sec;
    }

    const startBar = sec.startBar ?? idx * 4 + 1;
    const lengthBars = sec.lengthBars ?? 4;
    const startTimeSec = Math.max(0, (startBar - 1) * secPerBar);
    const endTimeSec = Math.min(totalSec, startTimeSec + lengthBars * secPerBar);

    return {
      ...sec,
      startTimeSec: Number(startTimeSec.toFixed(2)),
      endTimeSec: Number(Math.max(startTimeSec + 1, endTimeSec).toFixed(2)),
    };
  });

  normalized.sort((a, b) => a.startTimeSec - b.startTimeSec);

  return {
    ...project,
    durationSec: totalSec,
    sections: normalized,
  };
}

function openDatabase(): Promise<IDBDatabase> {
  if (cachedDbPromise) return cachedDbPromise;

  cachedDbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_PROJECTS)) {
        db.createObjectStore(STORE_PROJECTS, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(STORE_AUDIO)) {
        const audioStore = db.createObjectStore(STORE_AUDIO, { keyPath: 'key' });
        audioStore.createIndex('byProject', 'projectId', { unique: false });
      }
    };
    request.onsuccess = () => {
      const db = request.result;
      db.onclose = () => {
        cachedDbPromise = null;
      };
      resolve(db);
    };
    request.onerror = () => {
      cachedDbPromise = null;
      reject(request.error);
    };
  });

  return cachedDbPromise;
}

export async function saveProjectToDb(project: SongProject): Promise<void> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_PROJECTS, 'readwrite');
    const store = tx.objectStore(STORE_PROJECTS);
    store.put({ ...project, updatedAt: Date.now() });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function loadAllProjectsFromDb(): Promise<SongProject[]> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_PROJECTS, 'readwrite');
    const store = tx.objectStore(STORE_PROJECTS);
    const req = store.getAll();
    req.onsuccess = () => {
      const rawList = (req.result as SongProject[]) || [];
      const userProjects: SongProject[] = [];

      for (const item of rawList) {
        if (item.id.startsWith('demo-')) {
          store.delete(item.id);
        } else {
          userProjects.push(normalizeProjectSectionsToTime(item));
        }
      }

      userProjects.sort((a, b) => b.updatedAt - a.updatedAt);
      resolve(userProjects);
    };
    req.onerror = () => reject(req.error);
  });
}

export async function deleteProjectFromDb(projectId: string): Promise<void> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction([STORE_PROJECTS, STORE_AUDIO], 'readwrite');
    tx.objectStore(STORE_PROJECTS).delete(projectId);

    const audioStore = tx.objectStore(STORE_AUDIO);
    const index = audioStore.index('byProject');
    const cursorReq = index.openCursor(IDBKeyRange.only(projectId));
    cursorReq.onsuccess = () => {
      const cursor = cursorReq.result;
      if (cursor) {
        cursor.delete();
        cursor.continue();
      }
    };

    tx.oncomplete = () => {
      deleteProjectPcm(projectId).catch((err) =>
        console.warn('[OPFS] Error deleting project PCM files:', err)
      );
      resolve();
    };
    tx.onerror = () => reject(tx.error);
  });
}

export async function saveStemAudioToDb(stem: StoredAudioStem): Promise<void> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_AUDIO, 'readwrite');
    tx.objectStore(STORE_AUDIO).put(stem);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/**
 * Writes all stems of a song in a single atomic IndexedDB transaction using native Blobs
 */
export async function saveStemsBatchToDb(stems: StoredAudioStem[]): Promise<void> {
  if (stems.length === 0) return;
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_AUDIO, 'readwrite');
    const store = tx.objectStore(STORE_AUDIO);
    for (const stem of stems) {
      store.put(stem);
    }
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/**
 * Deletes the original stem Blobs of the given tracks from IndexedDB (e.g. once the
 * OPFS .pcm copy has been verified). Buffer mode needs these Blobs, so only call it
 * when the song will be played from OPFS streaming.
 */
export async function deleteStemsFromDb(projectId: string, trackIds: string[]): Promise<void> {
  if (trackIds.length === 0) return;
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_AUDIO, 'readwrite');
    const store = tx.objectStore(STORE_AUDIO);
    for (const trackId of trackIds) store.delete(`${projectId}:${trackId}`);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function loadRawStemsFromDb(projectId: string): Promise<StoredAudioStem[]> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_AUDIO, 'readonly');
    const index = tx.objectStore(STORE_AUDIO).index('byProject');
    const req = index.getAll(IDBKeyRange.only(projectId));
    req.onsuccess = () => resolve((req.result as StoredAudioStem[]) || []);
    req.onerror = () => reject(req.error);
  });
}

/**
 * Loads a project's stems and resolves handle-based references into File objects
 * (a File is a lazy reference to the disk file, not a copy). Stems whose permission
 * has not been granted yet, or whose file moved, come back with `unavailable` set.
 */
export async function loadProjectStemsFromDb(projectId: string): Promise<StoredAudioStem[]> {
  const raw = await loadRawStemsFromDb(projectId);
  return Promise.all(raw.map(hydrateStem));
}

async function hydrateStem(stem: StoredAudioStem): Promise<StoredAudioStem> {
  if (stem.blob || stem.arrayBuffer || !stem.fileHandle) return stem;
  const perm = await queryReadPermission(stem.fileHandle);
  if (perm !== 'granted') return { ...stem, unavailable: 'permission' };
  try {
    const file: File = await stem.fileHandle.getFile();
    return { ...stem, blob: file };
  } catch (err) {
    const name = (err as { name?: string })?.name;
    return { ...stem, unavailable: name === 'NotFoundError' ? 'missing' : 'permission' };
  }
}

export interface SourceAccessResult {
  /** Stems readable right now (handle-based or copied) */
  available: number;
  /** Stems whose original file is gone / moved (needs relinking) */
  missing: string[];
  /** Stems still blocked by a denied permission */
  denied: string[];
  total: number;
}

/**
 * Makes a project's referenced files readable. Call from a user gesture (click):
 * asks for permission once per source folder, then verifies every file.
 */
export async function requestProjectSourceAccess(projectId: string): Promise<SourceAccessResult> {
  const raw = await loadRawStemsFromDb(projectId);
  const refs = raw.filter((s) => s.fileHandle && !s.blob && !s.arrayBuffer);

  if (refs.length > 0) {
    const askedDirs: any[] = [];
    for (const stem of refs) {
      if ((await queryReadPermission(stem.fileHandle)) === 'granted') continue;
      if (stem.dirHandle && !askedDirs.includes(stem.dirHandle)) {
        askedDirs.push(stem.dirHandle);
        await requestReadPermission(stem.dirHandle);
        if ((await queryReadPermission(stem.fileHandle)) === 'granted') continue;
      }
      await requestReadPermission(stem.fileHandle);
    }
  }

  const hydrated = await Promise.all(raw.map(hydrateStem));
  return {
    available: hydrated.filter((s) => !s.unavailable).length,
    missing: hydrated.filter((s) => s.unavailable === 'missing').map((s) => s.fileName),
    denied: hydrated.filter((s) => s.unavailable === 'permission').map((s) => s.fileName),
    total: hydrated.length,
  };
}

/** True when the project's audio can be read only through handles (no copied Blobs). */
export async function projectHasHandleSources(projectId: string): Promise<boolean> {
  const raw = await loadRawStemsFromDb(projectId);
  return raw.some((s) => s.fileHandle && !s.blob && !s.arrayBuffer);
}

/**
 * Relinks a project's stems to a new folder: matches files by name (case-insensitive,
 * searching subfolders) and replaces the stored handles. Returns how many stems were relinked.
 */
export async function relinkProjectSources(
  projectId: string,
  dirHandle: any
): Promise<{ relinked: number; total: number }> {
  const raw = await loadRawStemsFromDb(projectId);
  const found = await collectAudioFromDirectory(dirHandle);
  const byName = new Map<string, any>();
  for (const f of found) {
    const info = getRegisteredHandle(f);
    if (info) byName.set(f.name.toLowerCase(), info.file);
  }

  const updated: StoredAudioStem[] = [];
  for (const stem of raw) {
    const match = byName.get(stem.fileName.toLowerCase());
    if (!match) continue;
    updated.push({
      ...stem,
      blob: undefined,
      arrayBuffer: undefined,
      fileHandle: match,
      dirHandle,
      unavailable: undefined,
    });
  }
  if (updated.length > 0) await saveStemsBatchToDb(updated);
  return { relinked: updated.length, total: raw.length };
}

export async function extractStemArrayBuffer(stem: StoredAudioStem): Promise<ArrayBuffer | null> {
  if (stem.blob) {
    return await stem.blob.arrayBuffer();
  }
  if (stem.arrayBuffer) {
    return stem.arrayBuffer.slice(0);
  }
  return null;
}

export function createEmptyProjectTemplate(
  title = 'Nueva Canción',
  artist = 'Sesión en Vivo',
  bpm = 120,
  keySignature = 'C Major'
): SongProject {
  return {
    id: `song-${Date.now()}`,
    title,
    artist,
    folder: 'imported',
    inSetlist: false,
    setlistOrder: 0,
    bpm,
    beatsPerBar: 4,
    beatUnit: 4,
    keySignature,
    totalBars: 24,
    durationSec: 48,
    quantizeMode: 'immediate',
    splitRoutingMode: 'stereo',
    clickEnabled: false,
    clickGain: 1.0,
    clickSubdivision: 1,
    guideCuesEnabled: true,
    guideVoiceReadout: true,
    guideGain: 1.0,
    masterGain: 1.0,
    cueMasterGain: 1.0,
    pitchSemitones: 0,
    sections: [],
    tracks: [],
    updatedAt: Date.now(),
  };
}
