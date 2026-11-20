import assert from 'node:assert/strict';
import { DebugMode, summarizeArgs } from '../src/utils/debugMode';
import { FlightRecorder } from '../src/utils/flightRecorder';
import { wrapInvoke } from '../src/utils/invokeTrace';

function memoryStorage() {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
}
const clock = () => { let t = 0; return { now: () => t, advance: (ms: number) => { t += ms; } }; };

async function main() {
  // 1. Apagado no guarda nada ni evalúa el texto.
  {
    const d = new DebugMode(() => 0, memoryStorage(), null);
    let evaluated = false;
    d.trace('comando', () => { evaluated = true; return 'x'; });
    assert.equal(evaluated, false, 'apagado: el texto del evento no se construye');
    assert.equal(d.all().length, 0);
  }
  // 2. Encendido guarda, se recuerda entre arranques y recorta a la capacidad.
  {
    const st = memoryStorage();
    const d = new DebugMode(() => 5, st, null);
    d.setEnabled(true);
    d.trace('transporte', 'play');
    assert.ok(d.all().some((e) => e.detail === 'play'));
    assert.equal(new DebugMode(() => 0, st, null).enabled, true, 'el estado se recuerda');
    for (let i = 0; i < 2500; i++) d.trace('comando', `e${i}`);
    assert.ok(d.all().length <= 2000, 'capacidad acotada');
    assert.equal(d.all().at(-1)?.detail, 'e2499');
  }
  // 3. Las alarmas y errores se guardan aunque esté apagado y llegan a la caja negra.
  {
    const rec = new FlightRecorder(50, () => 0, memoryStorage());
    const d = new DebugMode(() => 0, memoryStorage(), rec);
    d.alarm('prueba', 'algo no cuadra');
    d.error('ctx', new Error('boom'));
    assert.equal(d.alarms(), 1);
    assert.equal(d.all().length, 2);
    assert.ok(rec.all().some((e) => e.kind === 'alarma:prueba'));
    assert.ok(rec.all().some((e) => e.kind === 'error:ctx' && e.detail === 'boom'));
  }
  // 4. Los textos largos y las listas grandes se acortan.
  {
    const d = new DebugMode(() => 0, memoryStorage(), null);
    d.setEnabled(true);
    d.trace('comando', 'a'.repeat(1000));
    assert.ok(d.all().at(-1)!.detail.length < 300);
    assert.ok(summarizeArgs({ ids: Array.from({ length: 50 }, (_, i) => i) }).includes('50 elementos'));
  }
  // 5. wrapInvoke: devuelve el valor, anota lo normal, no anota el sondeo, alarma si es lento y relanza errores.
  {
    const c = clock();
    const d = new DebugMode(c.now, memoryStorage(), null);
    d.setEnabled(true);
    const inv = wrapInvoke(async (cmd) => {
      if (cmd === 'audio_fallo') throw new Error('no');
      if (cmd === 'audio_lento') c.advance(400);
      return cmd === 'audio_get_playback_state' ? 'estado' : 7;
    }, d, c.now);
    assert.equal(await inv('audio_play'), 7);
    assert.equal(await inv('audio_get_playback_state'), 'estado');
    assert.equal(d.all().filter((e) => e.detail.startsWith('audio_get_playback_state')).length, 0, 'el sondeo no se anota');
    assert.ok(d.all().some((e) => e.category === 'transporte' && e.detail.startsWith('audio_play')));
    await assert.rejects(() => inv('audio_fallo'), /no/);
    assert.ok(d.all().some((e) => e.detail.includes('ERROR')));
    await inv('audio_lento');
    assert.equal(d.alarms(), 1, 'un comando lento levanta una alarma');
  }
  // 6. Apagado, wrapInvoke sigue devolviendo y relanzando igual.
  {
    const d = new DebugMode(() => 0, memoryStorage(), null);
    const inv = wrapInvoke(async (cmd) => { if (cmd === 'x') throw new Error('mal'); return 1; }, d, () => 0);
    assert.equal(await inv('ok'), 1);
    await assert.rejects(() => inv('x'), /mal/);
    assert.equal(d.all().length, 0);
  }
  console.log('debugMode.test.ts OK');
}
main().catch((e) => { console.error(e); process.exit(1); });
