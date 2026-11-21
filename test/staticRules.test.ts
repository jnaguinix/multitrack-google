// Cada regla de scripts/verify-rules.ts detecta lo que debe y deja pasar lo legítimo.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  findSilentCatches,
  findOwnModals,
  findLooseMixInvokes,
  findCallbackViolations,
  hasBom,
  stripSource,
  runAll,
} from '../scripts/verify-rules';

const rules = (list: Array<{ rule: string }>) => list.map((f) => f.rule);

// --- 1. `.catch` mudo --------------------------------------------------------------------------
assert.deepEqual(rules(findSilentCatches('p.catch(() => {});', 'a.ts')), ['catch-mudo']);
assert.deepEqual(rules(findSilentCatches('p.catch((e) => null)', 'a.ts')), ['catch-mudo']);
assert.deepEqual(rules(findSilentCatches('p.catch(() => undefined)', 'a.ts')), ['catch-mudo']);
assert.deepEqual(findSilentCatches('p.catch(logAsyncError("x"))', 'a.ts'), [], 'logAsyncError es un aviso');
assert.deepEqual(findSilentCatches('p.catch((e) => { console.warn(e); return null; })', 'a.ts'), [], 'registrar y devolver null está bien');
assert.deepEqual(findSilentCatches('// p.catch(() => {})\nconst x = 1;', 'a.ts'), [], 'un comentario no cuenta');

// --- 2. `catch` vacío o sin aviso ---------------------------------------------------------------
assert.deepEqual(rules(findSilentCatches('try { f(); } catch {}', 'a.ts')), ['catch-vacio']);
assert.deepEqual(rules(findSilentCatches('try { f(); } catch (e) { /* nada */ }', 'a.ts')), ['catch-vacio'], 'solo un comentario = vacío');
assert.deepEqual(rules(findSilentCatches('try { f(); } catch (e) { return null; }', 'a.ts')), ['catch-sin-aviso']);
assert.deepEqual(findSilentCatches('try { f(); } catch (e) { console.error(e); }', 'a.ts'), []);
assert.deepEqual(findSilentCatches('try { f(); } catch (e) { setError(String(e)); }', 'a.ts'), [], 'setError es un aviso');
assert.deepEqual(findSilentCatches('try { f(); } catch (e) { setNotice(msg(e)); }', 'a.ts'), [], 'setNotice es un aviso');
assert.deepEqual(findSilentCatches('try { f(); } catch (e) { throw e; }', 'a.ts'), [], 'relanzar es un aviso');
assert.deepEqual(findSilentCatches('try { f(); } catch { // catch-ok: motivo\n  return 1; }', 'a.ts'), [], 'catch-ok declara el motivo');
// Una llave dentro de un texto no desordena el emparejamiento.
assert.deepEqual(findSilentCatches('try { f(); } catch (e) { console.error("}{", e); }', 'a.ts'), []);
// Un `catch` dentro de un texto o comentario no es un `catch`.
assert.deepEqual(findSilentCatches('const s = "catch { }"; // catch {}', 'a.ts'), []);

// --- 3. BOM -------------------------------------------------------------------------------------
assert.equal(hasBom(new Uint8Array([0xef, 0xbb, 0xbf, 0x61])), true);
assert.equal(hasBom(new Uint8Array([0x61, 0x62, 0x63])), false);
assert.equal(hasBom(new Uint8Array([])), false);

// --- 4. ventanas y menús propios ---------------------------------------------------------------
assert.deepEqual(rules(findOwnModals('<div className="fixed inset-0 bg-black/60">', 'a.tsx')), ['modal-propio']);
assert.deepEqual(rules(findOwnModals('<div role="dialog" aria-modal>', 'a.tsx')), ['modal-propio']);
assert.deepEqual(rules(findOwnModals('<dialog ref={r}>', 'a.tsx')), ['modal-propio']);
assert.deepEqual(rules(findOwnModals('<section popover="auto">', 'a.tsx')), ['modal-propio']);
assert.deepEqual(findOwnModals('<Dialog open onClose={c}><DialogBody/></Dialog>', 'a.tsx'), []);
assert.deepEqual(findOwnModals('<PopoverMenu id="m" label="x"><MenuItem/></PopoverMenu>', 'a.tsx'), []);
assert.deepEqual(findOwnModals('// fixed inset-0 era el modal viejo\nconst a = 1;', 'a.tsx'), [], 'un comentario no cuenta');

// --- 5. controles de la mezcla con invoke suelto ------------------------------------------------
assert.deepEqual(rules(findLooseMixInvokes("await invoke('audio_set_track_controls', { trackId })", 'a.ts')), ['invoke-suelto']);
assert.deepEqual(rules(findLooseMixInvokes('invoke<void>("audio_set_pitch", { semitones: 1 })', 'a.ts')), ['invoke-suelto']);
assert.deepEqual(findLooseMixInvokes("controlSync.enqueue({ key: 'master', cmd: 'audio_set_master_gains', args })", 'a.ts'), [], 'encolar por ControlQueue es lo correcto');
assert.deepEqual(findLooseMixInvokes("invoke('audio_play')", 'a.ts'), [], 'Play no es un control de mezcla');

// --- 6. callback de audio -----------------------------------------------------------------------
const rs = (body: string) => `impl X {\n    pub fn new() -> Self { let v = vec![0.0; 8]; Self }\n    pub fn process(&mut self, data: &mut [f32]) {\n${body}\n    }\n}\n`;
assert.deepEqual(findCallbackViolations(rs('let a = 1;'), 'c.rs'), [], 'new() puede asignar; process() limpio pasa');
assert.deepEqual(rules(findCallbackViolations(rs('println!("x");'), 'c.rs')), ['callback']);
assert.deepEqual(rules(findCallbackViolations(rs('let v = vec![0.0; 4];'), 'c.rs')), ['callback']);
assert.deepEqual(rules(findCallbackViolations(rs('let g = self.m.lock().unwrap();'), 'c.rs')), ['callback']);
assert.deepEqual(findCallbackViolations(rs('if let Ok(g) = self.m.try_lock() { let _ = g; }'), 'c.rs'), [], 'try_lock está permitido');
assert.deepEqual(rules(findCallbackViolations(rs('let s = x.clone();'), 'c.rs')), ['callback']);
assert.deepEqual(findCallbackViolations(rs('// println!("viejo");\nlet a = 1;'), 'c.rs'), [], 'un comentario no cuenta');
assert.deepEqual(findCallbackViolations(rs('let t = "vec![ y println!";'), 'c.rs'), [], 'un texto no cuenta');
assert.equal(findCallbackViolations('fn otra() {}', 'c.rs').length, 1, 'si no existe process, la regla avisa en vez de callar');

// El callback real: inyectarle un println! en process() tiene que romper la regla.
const real = fs.readFileSync('desktop/src-tauri/src/audio/playback/callback.rs', 'utf-8').replace(/\r\n/g, '\n');
assert.deepEqual(findCallbackViolations(real, 'callback.rs'), [], 'el callback real cumple');
const inyectado = real.replace(/(pub fn process\([^{]*\{)/, '$1\n        println!("hola");');
assert.notEqual(inyectado, real);
assert.deepEqual(rules(findCallbackViolations(inyectado, 'callback.rs')), ['callback'], 'un println! inyectado en process se detecta');

// --- stripSource conserva el largo y las líneas ----------------------------------------------
const sample = 'a // c\nb /* x\ny */ "s{}"\n`t${1}`\n';
const { code, bare } = stripSource(sample);
assert.equal(code.length, sample.length);
assert.equal(bare.length, sample.length);
assert.equal(code.split('\n').length, sample.split('\n').length);
assert.ok(!bare.includes('{}'), 'el contenido de las cadenas se blanquea en bare');

// --- Un archivo NUEVO sin agregar a git también se revisa (antes solo se leían los agregados) ------------------
{
  const nuevo = path.join('src', '__regla_archivo_nuevo.ts');
  fs.writeFileSync(nuevo, ['export async function f() {', '  try { await g(); } catch (e) { }', '}', ''].join('\n'));
  try {
    const { findings: halladas } = runAll();
    assert.ok(
      halladas.some((h) => h.file === 'src/__regla_archivo_nuevo.ts'),
      'un archivo nuevo sin agregar a git con un catch vacío debe incumplir la regla',
    );
  } finally {
    fs.rmSync(nuevo, { force: true });
  }
}

// --- El repositorio entero cumple, y las excepciones siguen haciendo falta ------------------------
const { findings, unusedAllowances } = runAll();
assert.deepEqual(findings, [], `el repositorio incumple reglas: ${JSON.stringify(findings, null, 1)}`);
assert.deepEqual(unusedAllowances, [], `excepciones sobrantes: ${unusedAllowances.join(', ')}`);

console.log('staticRules.test.ts OK');
