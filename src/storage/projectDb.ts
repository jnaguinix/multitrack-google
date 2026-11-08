import { SongProject } from '../types/project';

const DB_NAME = 'LibreTracksWebDB';
const DB_VERSION = 1;
const STORE_PROJECTS = 'projects';
const STORE_AUDIO = 'audioBuffers';

export interface StoredAudioStem {
  key: string; // `${projectId}:${trackId}`
  projectId: string;
  trackId: string;
  arrayBuffer: ArrayBuffer;
  mimeType: string;
  fileName: string;
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
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
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
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
    const tx = db.transaction(STORE_PROJECTS, 'readonly');
    const store = tx.objectStore(STORE_PROJECTS);
    const req = store.getAll();
    req.onsuccess = () => {
      const list = (req.result as SongProject[]) || [];
      list.sort((a, b) => b.updatedAt - a.updatedAt);
      resolve(list);
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

    tx.oncomplete = () => resolve();
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

export async function loadProjectStemsFromDb(projectId: string): Promise<StoredAudioStem[]> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_AUDIO, 'readonly');
    const index = tx.objectStore(STORE_AUDIO).index('byProject');
    const req = index.getAll(IDBKeyRange.only(projectId));
    req.onsuccess = () => resolve((req.result as StoredAudioStem[]) || []);
    req.onerror = () => reject(req.error);
  });
}

export const DEFAULT_DEMO_PROJECTS: SongProject[] = [
  {
    id: 'demo-neon-horizon',
    title: 'Horizonte Boreal (Live Session)',
    artist: 'LibreTracks Ensemble',
    bpm: 120,
    beatsPerBar: 4,
    beatUnit: 4,
    keySignature: 'C Minor',
    totalBars: 24,
    quantizeMode: '1-bar',
    splitRoutingMode: 'stereo',
    clickEnabled: true,
    clickGain: 0.75,
    clickSubdivision: 1,
    guideCuesEnabled: true,
    guideVoiceReadout: true,
    guideGain: 0.85,
    masterGain: 0.95,
    pitchSemitones: 0,
    updatedAt: 1730990000000,
    sections: [
      { id: 'sec-intro', name: 'Intro Conteo', code: 'IN', color: '#06B6D4', startBar: 1, lengthBars: 4, cueName: 'Intro' },
      { id: 'sec-verse1', name: 'Verso 1', code: 'V1', color: '#3B82F6', startBar: 5, lengthBars: 4, cueName: 'Verse One' },
      { id: 'sec-chorus1', name: 'Coro Principal', code: 'CH', color: '#10B981', startBar: 9, lengthBars: 4, cueName: 'Chorus' },
      { id: 'sec-bridge', name: 'Puente (Vamp)', code: 'BR', color: '#F59E0B', startBar: 13, lengthBars: 4, vampByDefault: true, cueName: 'Bridge Vamp' },
      { id: 'sec-chorus2', name: 'Coro Doble', code: 'C2', color: '#8B5CF6', startBar: 17, lengthBars: 4, cueName: 'Final Chorus' },
      { id: 'sec-outro', name: 'Outro Final', code: 'OU', color: '#EC4899', startBar: 21, lengthBars: 4, cueName: 'Outro' },
    ],
    tracks: [
      {
        id: 'trk-drums',
        name: 'Drums & Acoustic Kit',
        role: 'drums',
        color: '#F59E0B',
        gain: 0.92,
        pan: 0,
        muted: false,
        soloed: false,
        bus: 'main',
        peaks: [],
      },
      {
        id: 'trk-bass',
        name: 'Sub & Synth Bass',
        role: 'bass',
        color: '#EF4444',
        gain: 0.88,
        pan: -0.05,
        muted: false,
        soloed: false,
        bus: 'main',
        peaks: [],
      },
      {
        id: 'trk-keys',
        name: 'Warm Analog Keys',
        role: 'keys',
        color: '#06B6D4',
        gain: 0.82,
        pan: -0.35,
        muted: false,
        soloed: false,
        bus: 'main',
        peaks: [],
      },
      {
        id: 'trk-guitar',
        name: 'Clean Delay Arp Guitar',
        role: 'guitar',
        color: '#10B981',
        gain: 0.80,
        pan: 0.40,
        muted: false,
        soloed: false,
        bus: 'main',
        peaks: [],
      },
      {
        id: 'trk-synth',
        name: 'Shimmer Pad & Choir',
        role: 'synth',
        color: '#8B5CF6',
        gain: 0.76,
        pan: 0.15,
        muted: false,
        soloed: false,
        bus: 'main',
        peaks: [],
      },
      {
        id: 'trk-perc',
        name: 'Shaker & Tam-Perc',
        role: 'perc',
        color: '#EC4899',
        gain: 0.68,
        pan: -0.25,
        muted: false,
        soloed: false,
        bus: 'main',
        peaks: [],
      },
    ],
  },
  {
    id: 'demo-sunday-anthem',
    title: 'Catedral de Luz (Arena Set)',
    artist: 'LibreTracks Worship & Stage',
    bpm: 96,
    beatsPerBar: 4,
    beatUnit: 4,
    keySignature: 'G Major',
    totalBars: 20,
    quantizeMode: '1-bar',
    splitRoutingMode: 'stereo',
    clickEnabled: true,
    clickGain: 0.80,
    clickSubdivision: 2,
    guideCuesEnabled: true,
    guideVoiceReadout: true,
    guideGain: 0.85,
    masterGain: 0.95,
    pitchSemitones: 0,
    updatedAt: 1730980000000,
    sections: [
      { id: 'sec2-intro', name: 'Intro Atmos', code: 'IN', color: '#06B6D4', startBar: 1, lengthBars: 4, cueName: 'Intro' },
      { id: 'sec2-verse', name: 'Verso Suave', code: 'VS', color: '#3B82F6', startBar: 5, lengthBars: 4, cueName: 'Verse' },
      { id: 'sec2-chorus', name: 'Coro Abierto', code: 'CH', color: '#10B981', startBar: 9, lengthBars: 4, cueName: 'Chorus' },
      { id: 'sec2-vamp', name: 'Espontáneo (Vamp)', code: 'VP', color: '#F59E0B', startBar: 13, lengthBars: 4, vampByDefault: true, cueName: 'Vamp Section' },
      { id: 'sec2-outro', name: 'Final Crescendo', code: 'OU', color: '#EC4899', startBar: 17, lengthBars: 4, cueName: 'Ending' },
    ],
    tracks: [
      {
        id: 'trk2-drums',
        name: 'Stadium Drums',
        role: 'drums',
        color: '#F59E0B',
        gain: 0.90,
        pan: 0,
        muted: false,
        soloed: false,
        bus: 'main',
        peaks: [],
      },
      {
        id: 'trk2-bass',
        name: 'Moog Taurus Bass',
        role: 'bass',
        color: '#EF4444',
        gain: 0.88,
        pan: 0,
        muted: false,
        soloed: false,
        bus: 'main',
        peaks: [],
      },
      {
        id: 'trk2-keys',
        name: 'Grand Piano & Rhodes',
        role: 'keys',
        color: '#06B6D4',
        gain: 0.85,
        pan: -0.30,
        muted: false,
        soloed: false,
        bus: 'main',
        peaks: [],
      },
      {
        id: 'trk2-guitar',
        name: 'Dotted 8th Swell Guitar',
        role: 'guitar',
        color: '#10B981',
        gain: 0.82,
        pan: 0.35,
        muted: false,
        soloed: false,
        bus: 'main',
        peaks: [],
      },
      {
        id: 'trk2-synth',
        name: 'Warm Ambient Strings',
        role: 'synth',
        color: '#8B5CF6',
        gain: 0.78,
        pan: 0.15,
        muted: false,
        soloed: false,
        bus: 'main',
        peaks: [],
      },
    ],
  },
];
