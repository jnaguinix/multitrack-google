/**
 * Reglas estáticas del repositorio (ensayo, parte 1). Lee los fuentes y falla si se rompe una regla de
 * CLAUDE.md que hasta ahora solo se vigilaba a mano. No compila ni necesita hardware.
 *
 *   npm run verify:rules
 *
 * Reglas (salida 1 si alguna falla):
 *   1. `.catch(() => {})` y variantes mudas (devuelven nada, null o undefined).
 *   2. `catch` vacío o sin ningún aviso (consola, `logAsyncError`, relanzar, estado de error…).
 *   3. BOM al inicio de un archivo de texto (todo es UTF-8 sin BOM).
 *   4. Modales o menús propios: `fixed inset-0`, `role="dialog"`, `<dialog` y `popover` fuera de las piezas
 *      comunes (`Dialog`, `Menu`, `ActionToast`).
 *   5. Mezcla enviada al motor con `invoke` suelto: los controles pasan por `ControlQueue`.
 *   6. Prohibiciones del callback de audio dentro de `BlockMixer::process` (logging, asignaciones,
 *      `lock()` bloqueante). El resto del callback lo cubre la prueba de cero asignaciones.
 *
 * Un `catch` que no debe avisar lo declara con `// catch-ok: <motivo>` dentro del bloque. Las demás
 * excepciones conocidas están en `ALLOW_*` con su motivo: cada una es una deuda con nombre y se
 * borra de la lista al corregirla. Una excepción que ya no hace falta también es un error (la lista no
 * puede acumular polvo).
 *
 * Probado en `test/staticRules.test.ts` (cada regla con un caso que la rompe y uno que no).
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export interface Finding {
  rule: string;
  file: string;
  line: number;
  message: string;
}

// ---------------------------------------------------------------------------------------------
// Análisis de texto
// ---------------------------------------------------------------------------------------------

/**
 * Devuelve dos copias del texto con el mismo largo y las mismas líneas:
 *  - `code`: sin comentarios (los comentarios se vuelven espacios) y con el contenido de las cadenas
 *    intacto;
 *  - `bare`: además con el contenido de las cadenas en blanco, para emparejar llaves sin que una `{`
 *    dentro de un texto las desordene.
 * `rust` activa las reglas de Rust: sin plantillas con `${}` y sin cadenas con comilla simple.
 */
export function stripSource(text: string, rust = false): { code: string; bare: string } {
  const code: string[] = [];
  const bare: string[] = [];
  const n = text.length;
  let i = 0;
  const push = (c: string, b: string) => {
    code.push(c);
    bare.push(b);
  };
  while (i < n) {
    const c = text[i];
    const d = text[i + 1];
    if (c === '/' && d === '/') {
      while (i < n && text[i] !== '\n') {
        push(' ', ' ');
        i++;
      }
      continue;
    }
    if (c === '/' && d === '*') {
      while (i < n && !(text[i] === '*' && text[i + 1] === '/')) {
        const ch = text[i] === '\n' ? '\n' : ' ';
        push(ch, ch);
        i++;
      }
      if (i < n) {
        push(' ', ' ');
        push(' ', ' ');
        i += 2;
      }
      continue;
    }
    const isQuote = c === '"' || (!rust && (c === "'" || c === '`'));
    if (isQuote) {
      push(c, c);
      i++;
      while (i < n && text[i] !== c) {
        if (text[i] === '\\' && i + 1 < n) {
          push(text[i], ' ');
          push(text[i + 1], text[i + 1] === '\n' ? '\n' : ' ');
          i += 2;
          continue;
        }
        if (text[i] === '\n' && c !== '`' && !rust) break; // cadena sin cerrar (una regex, por ejemplo)
        push(text[i], text[i] === '\n' ? '\n' : ' ');
        i++;
      }
      if (i < n && text[i] === c) {
        push(c, c);
        i++;
      }
      continue;
    }
    push(c, c);
    i++;
  }
  return { code: code.join(''), bare: bare.join('') };
}

const lineOf = (text: string, index: number) => text.slice(0, index).split('\n').length;

/** Índice del `}` que cierra la `{` de `open` en `bare`, o -1. */
function matchBrace(bare: string, open: number): number {
  let depth = 0;
  for (let i = open; i < bare.length; i++) {
    if (bare[i] === '{') depth++;
    else if (bare[i] === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

// ---------------------------------------------------------------------------------------------
// Reglas 1 y 2: errores tragados
// ---------------------------------------------------------------------------------------------

/** `.catch(() => {})`, `.catch(() => null)`, `.catch(() => undefined)`, `.catch(() => void 0)`. */
const SILENT_PROMISE_CATCH =
  /\.catch\(\s*(?:async\s*)?(?:\(\s*\w*\s*\)|\w+)?\s*=>\s*(?:\{\s*\}|null|undefined|void\s+0)\s*\)/g;

/** Lo que cuenta como avisar del fallo dentro de un `catch`. */
const NOTICE =
  /console\.|logAsyncError|\bthrow\b|reject\(|alarm\(|\.trace\(|debugMode|toast|notify|showError|onError|report\w*\(|\bset\w*(?:Error|Notice|Warning|Message|Status|Banner|Toast)\w*\(|textContent\s*=|\bshow\w*\(|\bwarn\w*\(|\blog\w*\(|\bfail\w*\(/;

/**
 * Un `catch` que de verdad no debe avisar (una conversión con valor de respaldo, una captura de puntero
 * que algunos controladores rechazan…) lo dice dentro del propio bloque con `// catch-ok: <motivo>`.
 */
export const CATCH_OK = 'catch-ok:';

export function findSilentCatches(text: string, file: string): Finding[] {
  const { code, bare } = stripSource(text);
  const out: Finding[] = [];
  for (const m of code.matchAll(SILENT_PROMISE_CATCH)) {
    out.push({ rule: 'catch-mudo', file, line: lineOf(code, m.index!), message: '`.catch` que no hace nada: usa logAsyncError(contexto) o muestra el fallo' });
  }
  const re = /\bcatch\s*(?:\([^)]*\))?\s*\{/g;
  for (const m of bare.matchAll(re)) {
    const open = m.index! + m[0].length - 1;
    const close = matchBrace(bare, open);
    if (close < 0) continue;
    const body = code.slice(open + 1, close);
    const line = lineOf(code, m.index!);
    if (text.slice(open + 1, close).includes(CATCH_OK)) continue;
    if (body.trim() === '') {
      out.push({ rule: 'catch-vacio', file, line, message: '`catch` vacío: el error se pierde' });
    } else if (!NOTICE.test(body)) {
      out.push({ rule: 'catch-sin-aviso', file, line, message: '`catch` que no registra ni muestra el fallo' });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Regla 3: BOM
// ---------------------------------------------------------------------------------------------
export function hasBom(bytes: Uint8Array): boolean {
  return bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
}

// ---------------------------------------------------------------------------------------------
// Regla 4: ventanas y menús propios
// ---------------------------------------------------------------------------------------------
const MODAL_PATTERNS: Array<{ re: RegExp; what: string }> = [
  { re: /fixed\s+inset-0/g, what: '`fixed inset-0` (capa modal propia)' },
  { re: /role=["']dialog["']/g, what: '`role="dialog"` propio' },
  { re: /<dialog\b/g, what: '`<dialog>` propio' },
  { re: /\bpopover\b\s*(?:=|\{|\s|>)/g, what: '`popover` propio' },
];

export function findOwnModals(text: string, file: string): Finding[] {
  // Se mira el texto con cadenas intactas (las clases de Tailwind son cadenas) pero sin comentarios.
  const { code } = stripSource(text);
  const out: Finding[] = [];
  for (const { re, what } of MODAL_PATTERNS) {
    for (const m of code.matchAll(re)) {
      out.push({ rule: 'modal-propio', file, line: lineOf(code, m.index!), message: `${what}: usa Dialog o PopoverMenu (src/components/ui)` });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Regla 5: controles de la mezcla con `invoke` suelto
// ---------------------------------------------------------------------------------------------
const MIX_COMMANDS = ['audio_set_track_controls', 'audio_set_master_gains', 'audio_set_metronome', 'audio_set_pad', 'audio_set_pitch', 'audio_update_project_config'];

export function findLooseMixInvokes(text: string, file: string): Finding[] {
  const { code } = stripSource(text);
  const out: Finding[] = [];
  const re = new RegExp(`invoke\\s*(?:<[^>]*>)?\\(\\s*['"\`](${MIX_COMMANDS.join('|')})['"\`]`, 'g');
  for (const m of code.matchAll(re)) {
    out.push({ rule: 'invoke-suelto', file, line: lineOf(code, m.index!), message: `\`invoke('${m[1]}')\` suelto: los controles de la mezcla pasan por ControlQueue (controlSync.ts)` });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Regla 6: el callback de audio
// ---------------------------------------------------------------------------------------------
const CALLBACK_FORBIDDEN: Array<{ re: RegExp; what: string }> = [
  { re: /\b(?:e?println|print|eprint|dbg|trace|debug|info|warn|error)!/g, what: 'logging o impresión' },
  { re: /\b(?:tracing|log)::/g, what: 'logging' },
  { re: /\bvec!/g, what: 'asignación (`vec!`)' },
  { re: /\bformat!/g, what: 'asignación (`format!`)' },
  { re: /\.clone\(\)/g, what: '`clone()` (puede asignar)' },
  { re: /\b(?:Vec|String|Box|Rc)::(?:new|with_capacity|from)\b/g, what: 'asignación' },
  { re: /\.(?:to_string|to_owned|to_vec|into_boxed_slice)\(\)/g, what: 'asignación' },
  { re: /\.collect\b/g, what: '`collect` (asigna)' },
  { re: /\.lock\(\)/g, what: '`lock()` bloqueante (solo `try_lock`)' },
  { re: /\.(?:read|write)\(\)\s*\.\s*unwrap/g, what: 'bloqueo de RwLock' },
];

/** Busca lo prohibido en el cuerpo de la función `fnName` (la primera que se encuentre). */
export function findCallbackViolations(text: string, file: string, fnName = 'process'): Finding[] {
  const { code, bare } = stripSource(text, true);
  const head = new RegExp(`\\bfn\\s+${fnName}\\b[^{;]*\\{`);
  const m = head.exec(bare);
  if (!m) return [{ rule: 'callback', file, line: 1, message: `no se encontró \`fn ${fnName}\`: la regla del callback no puede vigilar nada` }];
  const open = m.index + m[0].length - 1;
  const close = matchBrace(bare, open);
  if (close < 0) return [];
  // Sin el contenido de las cadenas: un texto que diga «vec!» no es una asignación.
  const body = bare.slice(open, close);
  const out: Finding[] = [];
  for (const { re, what } of CALLBACK_FORBIDDEN) {
    for (const hit of body.matchAll(re)) {
      out.push({ rule: 'callback', file, line: lineOf(code, open + hit.index!), message: `${what} dentro de \`${fnName}\` (hilo de audio): ${hit[0]}` });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Excepciones conocidas (cada una con su motivo)
// ---------------------------------------------------------------------------------------------
const ALLOW_MODAL: Record<string, string> = {
  'src/components/ui/Dialog.tsx': 'es la pieza común',
  'src/components/ui/Menu.tsx': 'es la pieza común',
  'src/components/AppDialogs.tsx': 'ActionToast: popover="manual" para quedar sobre los <dialog>',
  'src/components/TransportDeck.tsx': 'panel «Ajustes de reproducción» con popover propio (lleva controles, no es una lista de opciones); sin decidir si pasa a PopoverMenu',
};
const ALLOW_BOM: Record<string, string> = {};

// ---------------------------------------------------------------------------------------------
// Recorrido del repositorio
// ---------------------------------------------------------------------------------------------
const ROOT = path.resolve(process.cwd());

/**
 * Archivos del repositorio: los agregados a git Y los nuevos sin agregar (respetando .gitignore). Antes solo se
 * leían los agregados, así que un archivo nuevo se saltaba las reglas hasta commitearlo y el incumplimiento
 * aparecía ya fusionado (pasó con `bridgeLoop.ts`). `.claude/` es configuración local del asistente, no del producto.
 */
function trackedFiles(): string[] {
  const args = ['ls-files', '-z', '--cached', '--others', '--exclude-standard'];
  const out = execFileSync('git', args, { cwd: ROOT, maxBuffer: 64 * 1024 * 1024 }).toString('utf-8');
  return out
    .split('\0')
    .filter(Boolean)
    .filter((f) => !f.startsWith('dist/') && !f.startsWith('.claude/') && fs.existsSync(path.join(ROOT, f)));
}

const TEXT_EXT = /\.(ts|tsx|js|mjs|rs|ps1|json|md|css|html|toml|yml|yaml|txt)$/;
const UI_DIRS = ['src/', 'desktop/frontend/', 'desktop/web/'];
const isUiSource = (f: string) => UI_DIRS.some((d) => f.startsWith(d)) && /\.(ts|tsx|js)$/.test(f) && !f.startsWith('src/preview/');

export function runAll(): { findings: Finding[]; unusedAllowances: string[] } {
  const files = trackedFiles();
  const findings: Finding[] = [];
  const used = new Set<string>();
  for (const f of files) {
    const abs = path.join(ROOT, f);
    if (TEXT_EXT.test(f)) {
      const bytes = fs.readFileSync(abs);
      if (hasBom(bytes)) {
        if (ALLOW_BOM[f]) used.add(`BOM:${f}`);
        else findings.push({ rule: 'bom', file: f, line: 1, message: 'el archivo empieza con BOM (todo va en UTF-8 sin BOM)' });
      }
    }
    if (isUiSource(f)) {
      const text = fs.readFileSync(abs, 'utf-8').replace(/\r\n/g, '\n');
      findings.push(...findSilentCatches(text, f));
      if (ALLOW_MODAL[f]) {
        if (findOwnModals(text, f).length > 0) used.add(`MODAL:${f}`);
      } else {
        findings.push(...findOwnModals(text, f));
      }
      findings.push(...findLooseMixInvokes(text, f));
    }
  }
  const cb = 'desktop/src-tauri/src/audio/playback/callback.rs';
  findings.push(...findCallbackViolations(fs.readFileSync(path.join(ROOT, cb), 'utf-8').replace(/\r\n/g, '\n'), cb));

  const unusedAllowances = [
    ...Object.keys(ALLOW_MODAL).map((f) => `MODAL:${f}`),
    ...Object.keys(ALLOW_BOM).map((f) => `BOM:${f}`),
  ].filter((k) => !used.has(k));
  return { findings, unusedAllowances };
}

function main() {
  const { findings, unusedAllowances } = runAll();
  for (const f of findings) console.error(`[${f.rule}] ${f.file}:${f.line}  ${f.message}`);
  for (const a of unusedAllowances) console.error(`[excepcion-sobrante] ${a}: ya no hace falta, bórrala de ALLOW_* en scripts/verify-rules.ts`);
  if (findings.length > 0 || unusedAllowances.length > 0) {
    console.error(`\nverify-rules: ${findings.length} incumplimiento(s), ${unusedAllowances.length} excepción(es) sobrante(s).`);
    process.exit(1);
  }
  console.log('verify-rules: OK');
}

if (process.argv[1] && /verify-rules\.ts$/.test(process.argv[1].replace(/\\/g, '/'))) main();
