import { SongProject, SongSection, TrackChannel } from '../types/project';
import { deleteProjectPcm } from './opfsStorage';
import {
  collectAudioFromDirectory,
  getRegisteredHandle,
  queryReadPermission,
  requestReadPermission,
  writeProjectSidecarToDirectory,
} from './sourceFiles';

const DB_NAME = 'OmniTracksWebDB';
const DB_VERSION = 1;
const STORE_PROJECTS = 'projects';
const STORE_AUDIO = 'audioBuffers';
const PRESET_MEMORY_STORAGE_KEY = 'omnitracks_folder_presets_v1';
const MAX_SAVED_PRESETS = 200;

/* eslint-disable @typescript-eslint/no-explicit-any */
const projectDirHandleCache = new Map<string, any>();
const sidecarDebounceTimers = new Map<string, ReturnType<typeof setTimeout>>();

export function registerProjectDirHandle(projectId: string, dirHandle: any): void {
  if (projectId && dirHandle) {
    projectDirHandleCache.set(projectId, dirHandle);
  }
}

function normalizePresetToken(text: string): string {
  return (text || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

function computePresetKeys(title: string, fileNames: string[]): {
  titleAndFilesKey: string;
  filesOnlyKey: string;
} {
  const cleanTitle = normalizePresetToken(title);
  const sortedFiles = fileNames
    .map((f) => normalizePresetToken(f))
    .filter(Boolean)
    .sort();
  const filesJoined = sortedFiles.join('|');
  return {
    titleAndFilesKey: `${cleanTitle}::${filesJoined}`,
    filesOnlyKey: filesJoined,
  };
}

interface StoredPresetEntry {
  key: string;
  filesOnlyKey: string;
  title: string;
  updatedAt: number;
  project: SongProject;
}

function loadPresetMemoryList(): StoredPresetEntry[] {
  if (typeof window === 'undefined' || !window.localStorage) return [];
  try {
    const raw = window.localStorage.getItem(PRESET_MEMORY_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as StoredPresetEntry[]) : [];
  } catch {
    return [];
  }
}

function savePresetMemoryList(list: StoredPresetEntry[]): void {
  if (typeof window === 'undefined' || !window.localStorage) return;
  try {
    const trimmed = [...list]
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
      .slice(0, MAX_SAVED_PRESETS);
    window.localStorage.setItem(PRESET_MEMORY_STORAGE_KEY, JSON.stringify(trimmed));
  } catch {
    // Ignore storage quota errors
  }
}

/**
 * Saves a lightweight metadata preset of the song (sections, BPM, key, mixer settings)
 * indexed by its folder/title and stem filenames so it can be recovered even if the
 * browser could not write a sidecar file directly to disk.
 */
export function saveProjectPresetMemory(project: SongProject): void {
  if (!project || !Array.isArray(project.tracks) || project.tracks.length === 0) return;

  const fileNames = project.tracks.map((t) => t.fileName || t.name);
  const { titleAndFilesKey, filesOnlyKey } = computePresetKeys(project.title, fileNames);
  if (!filesOnlyKey) return;

  const compactProject: SongProject = {
    ...project,
    updatedAt: Date.now(),
    tracks: project.tracks.map(({ pcm: _pcm, peaks: _peaks, ...rest }) => ({
      ...rest,
      peaks: [],
    })),
  };

  const list = loadPresetMemoryList();
  const existingIdx = list.findIndex((item) => item.key === titleAndFilesKey);

  // Avoid overwriting a preset that already had sections with an empty-section initial import shell
  if (
    existingIdx >= 0 &&
    list[existingIdx].project.sections.length > 0 &&
    compactProject.sections.length === 0
  ) {
    return;
  }

  const entry: StoredPresetEntry = {
    key: titleAndFilesKey,
    filesOnlyKey,
    title: normalizePresetToken(project.title),
    updatedAt: Date.now(),
    project: compactProject,
  };

  if (existingIdx >= 0) {
    list[existingIdx] = entry;
  } else {
    list.unshift(entry);
  }
  savePresetMemoryList(list);
}

/**
 * Finds a previously saved metadata preset matching the song title and stem file names.
 */
export function findSavedProjectPreset(
  songTitle: string,
  fileNames: string[]
): SongProject | null {
  if (!fileNames || fileNames.length === 0) return null;
  const { titleAndFilesKey, filesOnlyKey } = computePresetKeys(songTitle, fileNames);
  const list = loadPresetMemoryList();
  if (list.length === 0) return null;

  const exact = list.find((item) => item.key === titleAndFilesKey);
  if (exact) return exact.project;

  // Fallback: match by exact title + high overlap of stem filenames
  const cleanTitle = normalizePresetToken(songTitle);
  const byTitle = list.find((item) => item.title === cleanTitle && item.filesOnlyKey === filesOnlyKey);
  if (byTitle) return byTitle.project;

  return null;
}

/**
 * Merges saved project metadata (sections, BPM, key, routing, and per-track mixer settings)
 * into a freshly imported SongProject.
 */
export function mergeSavedProjectMetadata(
  baseProject: SongProject,
  savedRaw: SongProject
): SongProject {
  const saved = normalizeProjectSectionsToTime({
    ...savedRaw,
    durationSec:
      baseProject.durationSec && baseProject.durationSec > 1
        ? baseProject.durationSec
        : savedRaw.durationSec,
  });

  const savedByFileName = new Map<string, TrackChannel>();
  const savedByName = new Map<string, TrackChannel>();
  for (const st of saved.tracks || []) {
    if (st.fileName) {
      savedByFileName.set(st.fileName.trim().toLowerCase(), st);
    }
    if (st.name) {
      savedByName.set(st.name.trim().toLowerCase(), st);
    }
  }

  const mergedTracks: TrackChannel[] = baseProject.tracks.map((trk) => {
    const match =
      (trk.fileName && savedByFileName.get(trk.fileName.trim().toLowerCase())) ||
      savedByName.get(trk.name.trim().toLowerCase());
    if (!match) return trk;

    return {
      ...trk,
      name: match.name || trk.name,
      role: match.role || trk.role,
      color: match.color || trk.color,
      gain: Number.isFinite(match.gain) ? match.gain : trk.gain,
      pan: Number.isFinite(match.pan) ? match.pan : trk.pan,
      muted: typeof match.muted === 'boolean' ? match.muted : trk.muted,
      soloed: typeof match.soloed === 'boolean' ? match.soloed : trk.soloed,
      bus: match.bus || trk.bus,
      peaks:
        trk.peaks && trk.peaks.length > 0
          ? trk.peaks
          : Array.isArray(match.peaks)
          ? match.peaks
          : [],
    };
  });

  const effectiveBpm = saved.bpm || baseProject.bpm || 120;
  const effectiveBeatsPerBar = saved.beatsPerBar || baseProject.beatsPerBar || 4;
  const effectiveDurationSec =
    baseProject.durationSec && baseProject.durationSec > 1
      ? baseProject.durationSec
      : saved.durationSec || 180;
  const secPerBar = (60 / effectiveBpm) * effectiveBeatsPerBar;
  const effectiveTotalBars = Math.max(4, Math.ceil(effectiveDurationSec / secPerBar));

  return normalizeProjectSectionsToTime({
    ...baseProject,
    title: saved.title || baseProject.title,
    artist:
      saved.artist && saved.artist !== 'Sesión Importada'
        ? saved.artist
        : baseProject.artist,
    bpm: effectiveBpm,
    beatsPerBar: effectiveBeatsPerBar,
    beatUnit: saved.beatUnit || baseProject.beatUnit || 4,
    keySignature: saved.keySignature || baseProject.keySignature,
    totalBars: effectiveTotalBars,
    durationSec: effectiveDurationSec,
    quantizeMode: saved.quantizeMode || baseProject.quantizeMode,
    splitRoutingMode: saved.splitRoutingMode || baseProject.splitRoutingMode,
    clickEnabled:
      typeof saved.clickEnabled === 'boolean'
        ? saved.clickEnabled
        : baseProject.clickEnabled,
    clickGain:
      Number.isFinite(saved.clickGain) ? saved.clickGain : baseProject.clickGain,
    clickPan:
      Number.isFinite(saved.clickPan) ? saved.clickPan : baseProject.clickPan ?? 0,
    clickSubdivision: saved.clickSubdivision || baseProject.clickSubdivision,
    guideCuesEnabled:
      typeof saved.guideCuesEnabled === 'boolean'
        ? saved.guideCuesEnabled
        : baseProject.guideCuesEnabled,
    guideVoiceReadout:
      typeof saved.guideVoiceReadout === 'boolean'
        ? saved.guideVoiceReadout
        : baseProject.guideVoiceReadout,
    guideGain:
      Number.isFinite(saved.guideGain) ? saved.guideGain : baseProject.guideGain,
    guidePan:
      Number.isFinite(saved.guidePan) ? saved.guidePan : baseProject.guidePan ?? 0,
    masterGain:
      Number.isFinite(saved.masterGain) ? saved.masterGain : baseProject.masterGain,
    cueMasterGain:
      Number.isFinite(saved.cueMasterGain)
        ? saved.cueMasterGain
        : baseProject.cueMasterGain,
    pitchSemitones:
      typeof saved.pitchSemitones === 'number'
        ? saved.pitchSemitones
        : baseProject.pitchSemitones,
    sections: Array.isArray(saved.sections) ? saved.sections : [],
    tracks: mergedTracks,
  });
}

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

  const normalizedTracks: TrackChannel[] = Array.isArray(project.tracks)
    ? project.tracks.map((trk) => {
        const trimmedName = (trk.name || '').trim();
        const normName = trimmedName
          .normalize('NFD')
          .replace(/[\u0300-\u036f]/g, '')
          .toLowerCase();
        const isGuideName =
          normName === 'cues' ||
          normName === 'cue' ||
          normName === 'guide' ||
          normName === 'guia' ||
          normName.includes('guide') ||
          normName.includes('cue') ||
          normName.includes('guia');
        const nextName =
          normName === 'cues' || normName === 'cue' || normName === 'guide' || normName === 'guia'
            ? 'Guía'
            : trimmedName || trk.name;
        const nextRole =
          trk.role === 'custom' && isGuideName ? 'guide' : trk.role;

        return {
          ...trk,
          name: nextName,
          role: nextRole,
          gain: Number.isFinite(trk.gain) ? trk.gain : 1.0,
          pan: Number.isFinite(trk.pan) ? trk.pan : 0,
        };
      })
    : [];

  const sanitizedProject: SongProject = {
    ...project,
    clickGain: Number.isFinite(project.clickGain) ? project.clickGain : 1.0,
    clickPan: Number.isFinite(project.clickPan) ? project.clickPan : 0,
    guideGain: Number.isFinite(project.guideGain) ? project.guideGain : 1.0,
    guidePan: Number.isFinite(project.guidePan) ? project.guidePan : 0,
    masterGain: Number.isFinite(project.masterGain) ? project.masterGain : 1.0,
    cueMasterGain: Number.isFinite(project.cueMasterGain) ? project.cueMasterGain : 0.708,
    tracks: normalizedTracks,
  };

  if (!Array.isArray(sanitizedProject.sections) || sanitizedProject.sections.length === 0) {
    return {
      ...sanitizedProject,
      durationSec: totalSec,
      sections: [],
    };
  }

  const normalized: SongSection[] = sanitizedProject.sections.map((sec, idx) => {
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

  const resolved = normalized.map((sec, idx) => {
    const start = Math.round(Math.max(0, sec.startTimeSec) * 100) / 100;
    const next = normalized[idx + 1];
    const targetEnd = next
      ? Math.max(start + 0.05, Math.round(next.startTimeSec * 100) / 100)
      : totalSec;
    return {
      ...sec,
      startTimeSec: start,
      endTimeSec: Math.round(Math.max(start + 0.05, targetEnd) * 100) / 100,
    };
  });

  return {
    ...sanitizedProject,
    durationSec: totalSec,
    sections: resolved,
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

async function resolveProjectDirHandle(projectId: string): Promise<any | null> {
  const cached = projectDirHandleCache.get(projectId);
  if (cached) return cached;
  try {
    const raw = await loadRawStemsFromDb(projectId);
    const found = raw.find((s) => s.dirHandle)?.dirHandle;
    if (found) {
      projectDirHandleCache.set(projectId, found);
      return found;
    }
  } catch {
    // ignore
  }
  return null;
}

/**
 * Immediately synchronizes the project's metadata to both the local preset memory and
 * the `omnitracks.project.json` sidecar file inside the song's source folder (if available).
 * Pass `requestPermissionIfNeeded = true` when invoked directly from a user click gesture.
 */
export async function syncProjectSidecarNow(
  project: SongProject,
  requestPermissionIfNeeded = false
): Promise<boolean> {
  saveProjectPresetMemory(project);
  const timer = sidecarDebounceTimers.get(project.id);
  if (timer) {
    clearTimeout(timer);
    sidecarDebounceTimers.delete(project.id);
  }
  const dirHandle = await resolveProjectDirHandle(project.id);
  if (!dirHandle) return false;
  return writeProjectSidecarToDirectory(dirHandle, project, requestPermissionIfNeeded);
}

function scheduleProjectSidecarSync(project: SongProject): void {
  saveProjectPresetMemory(project);
  const prevTimer = sidecarDebounceTimers.get(project.id);
  if (prevTimer) clearTimeout(prevTimer);

  const timer = setTimeout(() => {
    sidecarDebounceTimers.delete(project.id);
    resolveProjectDirHandle(project.id)
      .then((dirHandle) => {
        if (dirHandle) {
          return writeProjectSidecarToDirectory(dirHandle, project, false);
        }
        return false;
      })
      .catch(() => {});
  }, 250);

  sidecarDebounceTimers.set(project.id, timer);
}

export async function saveProjectToDb(project: SongProject): Promise<void> {
  const updatedProject = { ...project, updatedAt: Date.now() };
  scheduleProjectSidecarSync(updatedProject);
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_PROJECTS, 'readwrite');
    const store = tx.objectStore(STORE_PROJECTS);
    store.put(updatedProject);
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
  const pendingTimer = sidecarDebounceTimers.get(projectId);
  if (pendingTimer) {
    clearTimeout(pendingTimer);
    sidecarDebounceTimers.delete(projectId);
  }
  projectDirHandleCache.delete(projectId);

  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction([STORE_PROJECTS, STORE_AUDIO], 'readwrite');
    const projectStore = tx.objectStore(STORE_PROJECTS);
    const getReq = projectStore.get(projectId);
    getReq.onsuccess = () => {
      const existing = getReq.result as SongProject | undefined;
      if (existing) {
        saveProjectPresetMemory(existing);
      }
      projectStore.delete(projectId);
    };

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
  if (stem.dirHandle) {
    registerProjectDirHandle(stem.projectId, stem.dirHandle);
  }
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
  for (const stem of stems) {
    if (stem.dirHandle) {
      registerProjectDirHandle(stem.projectId, stem.dirHandle);
      break;
    }
  }
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
