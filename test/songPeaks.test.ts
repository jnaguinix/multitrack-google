// Pruebas de los picos que la interfaz pide al motor al añadir una canción al setlist.
import { songLacksPeaks, withSongPeaks } from '../src/utils/songPeaks';
import type { SongProject, TrackChannel } from '../src/types/project';

function assert(condition: boolean, msg: string) {
  if (!condition) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
}

const track = (id: string, peaks: number[]): TrackChannel =>
  ({ id, name: id, role: 'bass', color: '#000', gain: 1, pan: 0, muted: false, soloed: false, bus: 'main', peaks }) as TrackChannel;
const song = (tracks: TrackChannel[]): SongProject => ({ id: 's', tracks }) as unknown as SongProject;

// Sin picos en alguna pista: hay que pedirlos.
assert(songLacksPeaks(song([track('a', [0.1]), track('b', [])])), 'una pista sin picos basta para pedirlos');
assert(!songLacksPeaks(song([track('a', [0.1]), track('b', [0.2])])), 'con todos los picos no se piden');
assert(songLacksPeaks(song([track('a', undefined as unknown as number[])])), 'picos ausentes cuentan como vacíos');

// Se rellenan solo las pistas vacías y nunca se pisan las que ya traen picos.
{
  const original = song([track('a', [0.9]), track('b', []), track('c', [])]);
  const out = withSongPeaks(original, { a: [0.1, 0.2], b: [0.3, 0.4] });
  assert(out.tracks[0].peaks.join() === '0.9', 'los picos que ya estaban no se pisan');
  assert(out.tracks[1].peaks.join() === '0.3,0.4', 'la pista vacía recibe sus picos');
  assert(out.tracks[2].peaks.length === 0, 'una pista sin picos guardados sigue vacía');
  assert(original.tracks[1].peaks.length === 0, 'el original no se modifica');
}

// Sin nada que añadir se devuelve el mismo objeto (no se renderiza de más).
{
  const original = song([track('a', [0.9]), track('b', [])]);
  assert(withSongPeaks(original, {}) === original, 'sin picos pedidos: el mismo objeto');
  assert(withSongPeaks(original, { b: [] }) === original, 'picos vacíos: el mismo objeto');
  assert(withSongPeaks(original, { zzz: [1] }) === original, 'picos de otra pista: el mismo objeto');
}

console.log('songPeaks: OK');
