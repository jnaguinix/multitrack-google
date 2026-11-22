// Pruebas de la importación nativa sin interfaz: asistente, pistas, reimportación y resultado de la decodificación.
import {
  applyDecodedTracks,
  buildImportedTracks,
  buildWizardFiles,
  buildWizardMeta,
  importedSongBecomesMounted,
  mergeReimportedTracks,
  newImportedSong,
  scannedSections,
} from '../src/utils/nativeImportPlan';
import type { ScannedFolderInfo } from '../src/utils/nativeDialog';
import type { SongProject, TrackChannel } from '../src/types/project';

function assert(condition: boolean, msg: string) {
  if (!condition) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
}

const scanned: ScannedFolderInfo = {
  folderPath: 'C:/multis/Cancion',
  folderName: 'Cancion',
  title: 'Cancion',
  artist: 'Artista Desconocido',
  bpm: 90,
  key: 'D',
  sections: [{ id: '', name: 'Intro', code: null, startSec: 0, endSec: 10 }],
  files: [
    { filePath: 'C:/multis/Cancion/Gtr A.wav', fileName: 'Gtr A.wav', trackName: 'Gtr A', trackId: 'a', estDurationSec: 200, fileSize: 10 },
    { filePath: 'C:/multis/Cancion/Gtr B.wav', fileName: 'Gtr B.wav', trackName: 'Gtr B', trackId: 'b', estDurationSec: 210, fileSize: 11 },
    { filePath: 'C:/multis/Cancion/Ruido.wav', fileName: 'Ruido.wav', trackName: 'Ruido', trackId: 'c', estDurationSec: 5, fileSize: 1 },
    { filePath: 'C:/multis/Cancion/Seq.wav', fileName: 'Seq.wav', trackName: 'Seq', trackId: 'd', estDurationSec: null, fileSize: null },
  ],
};

const track = (over: Partial<TrackChannel>): TrackChannel => ({
  id: 'x', name: 'Bajo', role: 'bass', color: '#000', gain: 1, pan: 0, muted: false, soloed: false, bus: 'main', peaks: [], ...over,
} as TrackChannel);

// ---- Asistente
{
  const files = buildWizardFiles(scanned, null, { 'gtr a.wav': 'guitarra' });
  assert(files.length === 4 && files[0].instrumentId === 'guitarra' && files[0].remembered === true, 'la memoria (solo por nombre exacto) propone el instrumento');
  assert(files[1].instrumentId === null && !files[1].remembered, 'sin memoria queda sin asignar');
  const meta = buildWizardMeta(scanned, null, null);
  assert(meta.artist === '', '«Artista Desconocido» no se toma como dato');
  assert(meta.bpm === 90 && meta.key === 'D' && meta.beatsPerBar === 4, 'tempo y tono leídos de la carpeta');
  const existing = { title: 'Ya estaba', artist: 'Banda', keySignature: 'E', bpm: 70, beatsPerBar: 3, tracks: [track({ name: 'Bajo', fileName: 'gtr a.WAV' })] } as unknown as SongProject;
  const again = buildWizardFiles(scanned, existing, { 'gtr a.wav': 'guitarra' });
  assert(again[0].instrumentId === 'bajo' && again[0].remembered === false, 'al reimportar manda la pista anterior con el mismo archivo');
  const m2 = buildWizardMeta(scanned, existing, null);
  assert(m2.title === 'Ya estaba' && m2.artist === 'Banda' && m2.bpm === 70 && m2.beatsPerBar === 3, 'al reimportar se proponen los datos de la canción');
}

// ---- Pistas a partir del asistente
{
  const wizard = { meta: buildWizardMeta(scanned, null, null), rows: [
    { id: 'a', instrumentId: 'guitarra' },
    { id: 'b', instrumentId: 'guitarra' },
    { id: 'c', instrumentId: null },
    { id: 'd', instrumentId: 'secuencia' },
  ] };
  const plan = buildImportedTracks(scanned, wizard, []);
  assert(plan.initialTracks.map((t) => t.name).join('|') === 'Guitarra 1|Guitarra 2|Secuencia', `numeración y pista ignorada: ${plan.initialTracks.map((t) => t.name)}`);
  assert(plan.maxDurationSec === 210, 'la duración más larga de las pistas importadas');
  assert(plan.initialTracks[2].splitSequence === true && plan.initialTracks[0].splitSequence === undefined, 'solo la Secuencia lleva la marca');
  assert(plan.initialTracks[2].durationSec === undefined && plan.initialTracks[2].fileSize === undefined, 'sin duración ni tamaño conocidos quedan sin definir');
  assert(plan.initialTracks.every((t) => t.bus === 'main'), 'los instrumentos van a Main');

  // Añadir a una canción que ya tiene una Guitarra: la existente pasa a «Guitarra 1».
  const withExisting = buildImportedTracks(
    { ...scanned, files: scanned.files.slice(0, 1) },
    { meta: wizard.meta, rows: [{ id: 'a', instrumentId: 'guitarra' }] },
    [track({ id: 'old', name: 'Guitarra' })]
  );
  assert(withExisting.renamedExisting[0].name === 'Guitarra 1' && withExisting.initialTracks[0].name === 'Guitarra 2', 'la numeración cuenta las pistas existentes');
}

// ---- Secciones, reimportación y canción nueva
{
  const secs = scannedSections(scanned);
  assert(secs[0].id === 'sec-0' && secs[0].code === 'S1' && secs[0].endTimeSec === 10, 'secciones del sidecar con id y código de respaldo');

  const existing = { tracks: [track({ id: 'keep', name: 'Guitarra 1', gain: 0.5, pan: -0.3, muted: true, fileName: 'Gtr A.wav', filePath: 'viejo' })] } as unknown as SongProject;
  const merged = mergeReimportedTracks([track({ id: 'a', name: 'Guitarra 1', fileName: 'Gtr A.wav', filePath: 'nuevo' })], existing);
  assert(merged[0].id === 'keep' && merged[0].gain === 0.5 && merged[0].pan === -0.3 && merged[0].muted === true, 'reimportar conserva el ID y la mezcla');
  assert(merged[0].filePath === 'nuevo', 'y toma la ruta nueva');

  const song = newImportedSong({ id: 's1', meta: buildWizardMeta(scanned, null, null), bpm: 90, beatsPerBar: 4, folderPath: scanned.folderPath, totalBars: 10, durationSec: 210, sections: secs, tracks: [] });
  assert(song.inSetlist === false && song.isTitleCustom === true && song.quantizeMode === 'section-end' && song.keySignature === 'D', 'valores iniciales de una canción nueva');
}

// ---- Resultado de la decodificación
{
  const song = { durationSec: 100, tracks: [track({ id: 'a', durationSec: 90, fileSize: 7 }), track({ id: 'b', durationSec: 80 })] } as unknown as SongProject;
  const out = applyDecodedTracks(song, [{ trackId: 'a', peaks: [0.1], durationSec: 120, targetSampleRate: 48000, channels: 2, frameCount: 5_760_000 }]);
  assert(out.durationSec === 120, 'la duración real más larga');
  assert(out.tracks[0].pcm?.sampleRate === 48000 && out.tracks[0].pcm?.frames === 5_760_000 && out.tracks[0].fileSize === 7, 'datos de la caché PCM en la pista decodificada');
  assert(out.tracks[1].pcm === undefined && out.tracks[1].durationSec === 80, 'la pista no decodificada no cambia');
}

// ---- Importar a la biblioteca no toca la canción montada ni su audio (plan 4.6)
{
  assert(importedSongBecomesMounted({ id: 'nueva', inSetlist: false }, 'sonando') === false, 'una canción nueva de la biblioteca no reemplaza a la que suena');
  assert(importedSongBecomesMounted({ id: 'nueva', inSetlist: true }, 'sonando') === false, 'tampoco una del setlist si ya hay otra montada');
  assert(importedSongBecomesMounted({ id: 'sonando', inSetlist: false }, 'sonando') === true, 'reimportar la montada sí la actualiza (aunque no esté en el setlist)');
  assert(importedSongBecomesMounted({ id: 'a', inSetlist: true }, null) === true, 'sin nada montado, una del setlist se monta');
  assert(importedSongBecomesMounted({ id: 'a', inSetlist: false }, null) === false, 'sin nada montado, una de la biblioteca no se monta sola');
  assert(importedSongBecomesMounted({ id: 'a' }, undefined) === false, 'sin marca de setlist cuenta como biblioteca');
}

console.log('nativeImportPlan: OK');
