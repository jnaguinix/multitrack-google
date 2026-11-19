// Pruebas de qué canción se monta cuando el DAW queda vacío.
import { pickSongToMount } from '../src/utils/songToMount';
import type { SongProject } from '../src/types/project';

function assert(condition: boolean, msg: string) {
  if (!condition) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
}

const song = (id: string, extra: Partial<SongProject> = {}): SongProject => ({ id, ...extra }) as unknown as SongProject;

assert(pickSongToMount([], []) === null, 'sin canciones no hay nada que montar');

// El setlist manda: se monta su primera canción aunque haya otras más usadas.
{
  const a = song('a', { lastUsedAt: 500 });
  const b = song('b', { inSetlist: true, setlistOrder: 0 });
  const c = song('c', { inSetlist: true, setlistOrder: 1 });
  assert(pickSongToMount([a, b, c], [b, c])?.id === 'b', 'se monta la primera del setlist');
}

// Sin setlist: la usada más recientemente.
{
  const a = song('a', { lastUsedAt: 100 });
  const b = song('b', { lastUsedAt: 900 });
  const c = song('c');
  assert(pickSongToMount([a, b, c], [])?.id === 'b', 'sin setlist se monta la más reciente');
}

// Ninguna usada nunca: la primera de la lista (la última importada).
{
  const a = song('a');
  const b = song('b');
  assert(pickSongToMount([a, b], [])?.id === 'a', 'sin uso previo se monta la primera de la lista');
}

// Una sola canción siempre se monta.
assert(pickSongToMount([song('solo')], [])?.id === 'solo', 'una única canción se monta');

console.log('songToMount: OK');
