/**
 * Importación nativa (carpeta o archivos elegidos con el diálogo del sistema): las partes que no dependen de React
 * ni del motor. Reciben lo escaneado y lo elegido en el asistente y devuelven las pistas, secciones y datos de la
 * canción. Las usa `useNativeImport`; al ser funciones puras se pueden probar sin la interfaz.
 */
import type { SongProject, SongSection, TrackChannel } from '../types/project';
import type { WizardFile, WizardMeta, WizardResult } from '../components/modals/ImportWizardModal';
import type { ScannedFolderInfo } from './nativeDialog';
import { effectiveBus, getInstrument, instrumentIdFromName, numberedNames } from './instrumentCatalog';
import { memoryKey } from './trackMapMemory';
import { MARKER_PALETTE } from './markerPalette';

/** Datos que devuelve el motor por cada pista decodificada (`audio_import_tracks`). */
export interface DecodedTrackMeta {
  trackId: string;
  peaks?: number[];
  durationSec: number;
  targetSampleRate: number;
  channels: number;
  frameCount: number;
}

/**
 * Filas del paso 2 del asistente: el instrumento sale de la pista con el mismo nombre de archivo en la canción que
 * se reimporta o, si no, de la memoria de mapeo (solo por nombre de archivo exacto).
 */
export function buildWizardFiles(
  scanned: ScannedFolderInfo,
  existingCandidate: SongProject | null,
  memory: Record<string, string>
): WizardFile[] {
  return scanned.files.map((f) => {
    const prevTrack = existingCandidate?.tracks.find(
      (pt) => pt.fileName && f.fileName && pt.fileName.toLowerCase() === f.fileName.toLowerCase()
    );
    const prevId = prevTrack ? instrumentIdFromName(prevTrack.name) : null;
    const rememberedId = memory[memoryKey(f.fileName)] ?? null;
    return {
      id: f.trackId,
      fileName: f.fileName,
      durationSec: f.estDurationSec ?? null,
      instrumentId: prevId ?? rememberedId,
      remembered: !prevId && Boolean(rememberedId),
    };
  });
}

/** Paso 1 del asistente: datos de la canción ya conocidos (reimportada, actual o leídos de la carpeta). */
export function buildWizardMeta(
  scanned: ScannedFolderInfo,
  existingCandidate: SongProject | null,
  current: SongProject | null
): WizardMeta {
  return {
    title: existingCandidate?.title || current?.title || scanned.title || '',
    // «Artista Desconocido» es un relleno de la app, no un dato: se deja vacío para que lo escriba el usuario.
    artist:
      [existingCandidate?.artist, current?.artist, scanned.artist].find(
        (a) => a && !/^(Artista Desconocido|Sesión Importada)$/i.test(a)
      ) || '',
    key: existingCandidate?.keySignature || current?.keySignature || scanned.key || 'C Major',
    bpm: existingCandidate?.bpm || current?.bpm || scanned.bpm || 120,
    beatsPerBar: existingCandidate?.beatsPerBar || current?.beatsPerBar || 4,
  };
}

export interface PlannedTracks {
  /** Pistas nuevas, con el nombre del catálogo; las ignoradas en el asistente no aparecen. */
  initialTracks: TrackChannel[];
  /** Las pistas que ya tenía la canción, renumeradas contando también las nuevas. */
  renamedExisting: TrackChannel[];
  /** Duración estimada más larga entre las pistas nuevas (0 si no se sabe). */
  maxDurationSec: number;
}

/**
 * Pistas a partir de lo elegido en el asistente. Al añadir a una canción que ya tiene pistas, la numeración
 * («Guitarra 1», «Guitarra 2»…) cuenta también las existentes.
 */
export function buildImportedTracks(
  scanned: ScannedFolderInfo,
  wizard: WizardResult,
  existingTracks: TrackChannel[]
): PlannedTracks {
  const existingIds = existingTracks.map((tr) => instrumentIdFromName(tr.name));
  const newIds = wizard.rows.map((r) => r.instrumentId);
  const allNames = numberedNames([...existingIds, ...newIds]);
  const newNames = allNames.slice(existingTracks.length);
  const renamedExisting: TrackChannel[] = existingTracks.map((tr, i) =>
    allNames[i] ? { ...tr, name: allNames[i] as string } : tr
  );

  let maxDurationSec = 0;
  const initialTracks: TrackChannel[] = [];
  scanned.files.forEach((file, idx) => {
    const def = getInstrument(wizard.rows[idx].instrumentId);
    const trackName = newNames[idx];
    if (!def || !trackName) return; // pista ignorada en el asistente
    const estDuration = file.estDurationSec || 0;
    if (estDuration > maxDurationSec) {
      maxDurationSec = estDuration;
    }

    initialTracks.push({
      id: file.trackId,
      name: trackName,
      role: def.role,
      color: def.color,
      ...(def.splitSequence ? { splitSequence: true } : {}),
      gain: 1.0,
      pan: 0,
      muted: false,
      soloed: false,
      bus: effectiveBus({ name: trackName, role: def.role }),
      peaks: [],
      isCustomAudio: true,
      fileName: file.fileName,
      filePath: file.filePath,
      fileSize: file.fileSize ?? undefined,
      durationSec: estDuration > 0 ? estDuration : undefined,
    });
  });

  return { initialTracks, renamedExisting, maxDurationSec };
}

/** Secciones leídas del sidecar de la carpeta, con los colores de la paleta. */
export function scannedSections(scanned: ScannedFolderInfo): SongSection[] {
  return scanned.sections.map((s, idx) => ({
    id: s.id || `sec-${idx}`,
    name: s.name,
    code: s.code || `S${idx + 1}`,
    color: MARKER_PALETTE[idx % MARKER_PALETTE.length],
    startTimeSec: s.startSec,
    endTimeSec: s.endSec,
    vampByDefault: false,
    cueName: s.name,
  }));
}

/** Ruta comparable: sin distinguir mayúsculas ni el tipo de barra. */
function normalizedPath(path: string | undefined): string {
  return (path ?? '').replace(/\\/g, '/').toLowerCase();
}

/** Resultado de reimportar: las pistas y a qué ID final corresponde cada ID que dio el escaneo. */
export interface ReimportPlan {
  tracks: TrackChannel[];
  /** ID de la pista en el escaneo -> ID que lleva en la canción. El motor debe decodificar con el segundo. */
  idByScanId: Map<string, string>;
}

/**
 * Reimportar una canción que ya está en la biblioteca: cada pista nueva conserva el ID, la mezcla (volumen, paneo,
 * mute, solo, «Aur.», volumen y mute del click de una secuencia dividida) y lo que falte (ruta, tamaño, duración) de la
 * pista anterior que le corresponde.
 *
 * El emparejamiento va de lo más seguro a lo menos y cada pista anterior se usa una sola vez: 1) misma ruta de archivo,
 * 2) mismo nombre de archivo, 3) mismo ID (solo si el archivo no es otro), 4) mismo nombre de pista entre las que
 * quedaron sin pareja. Antes bastaba con coincidir en cualquiera de las tres cosas y ganaba la primera pista anterior
 * que lo cumpliera: con nombres iguales entre archivos distintos la mezcla se cruzaba, y dos pistas nuevas podían quedar
 * con el mismo ID.
 *
 * Una pista nueva sin pareja que traiga un ID de alguna pista anterior (aunque esa se descarte) recibe uno nuevo: si no,
 * heredaría la caché PCM de otro archivo.
 */
export function planReimportedTracks(initialTracks: TrackChannel[], existing: SongProject): ReimportPlan {
  const previous = existing.tracks;
  const claimed = new Set<number>();
  const matchOf: Array<TrackChannel | null> = initialTracks.map(() => null);

  const pass = (accepts: (prev: TrackChannel, next: TrackChannel) => boolean) => {
    initialTracks.forEach((next, i) => {
      if (matchOf[i]) return;
      const j = previous.findIndex((prev, k) => !claimed.has(k) && accepts(prev, next));
      if (j >= 0) {
        claimed.add(j);
        matchOf[i] = previous[j];
      }
    });
  };
  const otherFile = (prev: TrackChannel, next: TrackChannel) =>
    Boolean(prev.fileName && next.fileName && prev.fileName.toLowerCase() !== next.fileName.toLowerCase());

  pass((prev, next) => Boolean(prev.filePath && next.filePath) && normalizedPath(prev.filePath) === normalizedPath(next.filePath));
  pass((prev, next) => Boolean(prev.fileName && next.fileName) && prev.fileName!.toLowerCase() === next.fileName!.toLowerCase());
  pass((prev, next) => prev.id === next.id && !otherFile(prev, next));
  pass((prev, next) => prev.name.toLowerCase() === next.name.toLowerCase());

  const taken = new Set<string>([...previous.map((p) => p.id), ...initialTracks.map((t) => t.id)]);
  const used = new Set<string>();
  const freshId = (base: string): string => {
    for (let n = 2; ; n++) {
      const candidate = `${base}-n${n}`;
      if (!taken.has(candidate)) {
        taken.add(candidate);
        return candidate;
      }
    }
  };

  const idByScanId = new Map<string, string>();
  const tracks = initialTracks.map((next, i) => {
    const prev = matchOf[i];
    let id = prev ? prev.id : next.id;
    // Sin pareja: no puede llevar el ID de una pista anterior (su caché es de otro archivo). Y ningún ID se repite.
    if ((!prev && previous.some((p) => p.id === id)) || used.has(id)) id = freshId(id);
    used.add(id);
    idByScanId.set(next.id, id);
    if (!prev) return id === next.id ? next : { ...next, id };
    return {
      ...next,
      id,
      gain: prev.gain,
      pan: prev.pan,
      muted: prev.muted,
      soloed: prev.soloed,
      ...(prev.monitor !== undefined ? { monitor: prev.monitor } : {}),
      ...(prev.cueGain !== undefined ? { cueGain: prev.cueGain } : {}),
      ...(prev.cueMuted !== undefined ? { cueMuted: prev.cueMuted } : {}),
      filePath: next.filePath || prev.filePath,
      fileName: next.fileName || prev.fileName,
      fileSize: next.fileSize ?? prev.fileSize,
      durationSec: next.durationSec ?? prev.durationSec,
    };
  });
  return { tracks, idByScanId };
}

/** Las pistas de `planReimportedTracks` (sin el mapa de IDs). */
export function mergeReimportedTracks(initialTracks: TrackChannel[], existing: SongProject): TrackChannel[] {
  return planReimportedTracks(initialTracks, existing).tracks;
}

/**
 * ¿La canción recién importada pasa a ser la de la consola? Solo si ya era la montada (reimportación de la que se está
 * viendo) o si no hay ninguna montada y está en el setlist. Importar otra canción a la biblioteca mientras suena una no
 * puede tocar la montada ni su audio: `prepareProjectShell` cambia la canción del motor y detiene el audio si es otra.
 */
export function importedSongBecomesMounted(
  imported: { id: string; inSetlist?: boolean },
  mountedId: string | null | undefined
): boolean {
  return mountedId ? mountedId === imported.id : Boolean(imported.inSetlist);
}

/** Valores iniciales de una canción importada desde una carpeta nueva. */
export function newImportedSong(args: {
  id: string;
  meta: WizardMeta;
  bpm: number;
  beatsPerBar: number;
  folderPath: string;
  totalBars: number;
  durationSec: number;
  sections: SongSection[];
  tracks: TrackChannel[];
}): SongProject {
  return {
    id: args.id,
    title: args.meta.title,
    artist: args.meta.artist,
    isTitleCustom: true,
    folderPath: args.folderPath,
    folder: 'imported',
    inSetlist: false,
    setlistOrder: undefined,
    bpm: args.bpm,
    beatsPerBar: args.beatsPerBar,
    beatUnit: 4,
    keySignature: args.meta.key,
    totalBars: args.totalBars,
    durationSec: args.durationSec,
    quantizeMode: 'section-end',
    splitRoutingMode: 'stereo',
    clickEnabled: false,
    clickGain: 1.0,
    clickSubdivision: 1,
    masterGain: 1.0,
    cueMasterGain: 1.0,
    pitchSemitones: 0,
    sections: args.sections,
    tracks: args.tracks,
    updatedAt: Date.now(),
  };
}

/** Aplica a las pistas lo que devolvió el motor al decodificar: picos, duración real y datos de la caché PCM. */
export function applyDecodedTracks(
  song: SongProject,
  decoded: DecodedTrackMeta[]
): { tracks: TrackChannel[]; durationSec: number } {
  let durationSec = song.durationSec || 0;
  const tracks = song.tracks.map((t) => {
    const meta = decoded.find((m) => m.trackId === t.id);
    if (meta) {
      if (meta.durationSec > durationSec) {
        durationSec = meta.durationSec;
      }
      return {
        ...t,
        peaks: meta.peaks || t.peaks,
        durationSec: meta.durationSec || t.durationSec,
        fileSize: t.fileSize,
        pcm: {
          sampleRate: meta.targetSampleRate,
          channels: meta.channels,
          frames: meta.frameCount,
          version: 1 as const,
        },
      };
    }
    return t;
  });
  return { tracks, durationSec };
}
