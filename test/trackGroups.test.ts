// Plan 6.11 (AG2 H17): un fader de Click o Guía gobierna todas las pistas de ese tipo.
import { groupToggleTargets } from '../src/utils/trackGroups';
import type { TrackChannel } from '../src/types/project';

function assert(condition: boolean, msg: string) {
  if (!condition) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
}
const t = (id: string, muted: boolean, soloed = false) => ({ id, muted, soloed }) as unknown as TrackChannel;

assert(groupToggleTargets([], 'muted').length === 0, 'grupo vacío: nada que tocar');
assert(groupToggleTargets([t('a', false), t('b', false)], 'muted').join() === 'a,b', 'todas sin mute: se silencian las dos');
assert(groupToggleTargets([t('a', true), t('b', true)], 'muted').join() === 'a,b', 'todas en mute: se activan las dos');
assert(groupToggleTargets([t('a', true), t('b', false)], 'muted').join() === 'a', 'mezcladas: se unifica con la mostrada (la primera)');
assert(groupToggleTargets([t('a', false, true), t('b', false, false)], 'soloed').join() === 'a', 'el solo sigue la misma regla');
console.log('trackGroups: OK');
