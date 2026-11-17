/**
 * Memoria del asistente de importación: qué instrumento eligió el usuario para un archivo.
 *
 * Es deliberadamente tonta: solo coincide el nombre de archivo EXACTO (sin distinguir mayúsculas). Nunca
 * intenta adivinar a partir de palabras del nombre. El asistente muestra lo recordado ya elegido, con una
 * marca, y el usuario puede cambiarlo.
 */
import { canonicalInstrumentId, getInstrument } from './instrumentCatalog';
import { logAsyncError } from './asyncErrors';

const STORAGE_KEY = 'omnitracks_track_map_v1';

export type TrackMapMemory = Record<string, string>;

export const memoryKey = (fileName: string): string => (fileName || '').trim().toLowerCase();

export function loadTrackMapMemory(storage: Pick<Storage, 'getItem'> | null = safeStorage()): TrackMapMemory {
  if (!storage) return {};
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object') return {};
    const out: TrackMapMemory = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === 'string' && getInstrument(v)) out[k] = canonicalInstrumentId(v) as string;
    }
    return out;
  } catch (err) {
    logAsyncError('leer la memoria de mapeo de pistas')(err);
    return {};
  }
}

/** Guarda las elecciones (`fileName` → instrumento). Las pistas ignoradas (`null`) no se recuerdan. */
export function rememberTrackMapping(
  entries: ReadonlyArray<{ fileName: string; instrumentId: string | null }>,
  storage: Pick<Storage, 'getItem' | 'setItem'> | null = safeStorage()
): void {
  if (!storage) return;
  try {
    const memory = loadTrackMapMemory(storage);
    for (const e of entries) {
      if (e.instrumentId && getInstrument(e.instrumentId) && e.fileName.trim()) {
        memory[memoryKey(e.fileName)] = canonicalInstrumentId(e.instrumentId) as string;
      }
    }
    storage.setItem(STORAGE_KEY, JSON.stringify(memory));
  } catch (err) {
    logAsyncError('guardar la memoria de mapeo de pistas')(err);
  }
}

function safeStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}
