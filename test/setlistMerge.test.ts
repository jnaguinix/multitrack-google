// Plan 6.3: «Montar en consola» no debe sacar la canción del setlist.
import { withLatestSetlistState } from '../src/utils/setlistMerge';
import type { SongProject } from '../src/types/project';

function assert(condition: boolean, msg: string) {
  if (!condition) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
}

const song = (extra: Partial<SongProject>): SongProject => ({ id: 's1', title: 'A', tracks: [], durationSec: 10, ...extra }) as unknown as SongProject;

// La activación empezó con la copia vieja (fuera del setlist); la lista ya la tiene dentro.
{
  const activated = song({ inSetlist: false, setlistOrder: undefined, durationSec: 99 });
  const latest = song({ inSetlist: true, setlistOrder: 3 });
  const out = withLatestSetlistState(activated, latest);
  assert(out.inSetlist === true && out.setlistOrder === 3, 'toma la pertenencia y el orden más recientes');
  assert(out.durationSec === 99, 'conserva lo que montó la activación');
  assert(activated.inSetlist === false, 'no modifica la copia original');
}
// Sin cambios o sin copia reciente: devuelve la misma.
{
  const a = song({ inSetlist: true, setlistOrder: 1 });
  assert(withLatestSetlistState(a, song({ inSetlist: true, setlistOrder: 1 })) === a, 'sin cambios devuelve la misma');
  assert(withLatestSetlistState(a, undefined) === a, 'sin lista reciente devuelve la misma');
  assert(withLatestSetlistState(a, song({ id: 'otra', inSetlist: false })) === a, 'otra canción no se mezcla');
}
console.log('setlistMerge: OK');
