/**
 * Validación estática del contrato entre la interfaz (TypeScript) y el motor (Rust). No gasta tokens ni
 * necesita compilar: lee los fuentes y compara.
 *
 *   npm run verify:ipc
 *
 * Errores (salida 1):
 *   - una llamada a `invoke('x')` cuyo comando no existe en Rust;
 *   - argumentos que Rust no tiene (un typo en un `Option` se ignora en silencio) o que faltan;
 *   - campos de un objeto en línea que no existen en la struct que espera Rust;
 *   - un comando sin registrar en los tres sitios (`generate_handler!`, `build.rs`, `capabilities`).
 * Avisos (no fallan): un valor para un entero de Rust que no se ve claramente entero; argumentos o
 * llamadas que no se pueden analizar de forma estática (variables, `...spread`).
 *
 * Este tipo de desajuste ya ocurrió: el pan viajaba como -1..+1 y Rust esperaba un entero -100..100, y
 * el comando entero de la pista se rechazaba sin ningún aviso visible.
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(process.cwd());
const errors: string[] = [];
const warnings: string[] = [];

// ---------------------------------------------------------------------------------------------
// Utilidades
// ---------------------------------------------------------------------------------------------
function walk(dir: string, exts: string[], skip: (p: string) => boolean = () => false, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (skip(p)) continue;
    if (e.isDirectory()) walk(p, exts, skip, out);
    else if (exts.some((x) => e.name.endsWith(x))) out.push(p);
  }
  return out;
}

const rel = (p: string) => path.relative(ROOT, p).replace(/\\/g, '/');
const read = (p: string) => fs.readFileSync(p, 'utf-8').replace(/\r\n/g, '\n');
const camel = (s: string) => s.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());
const lineOf = (text: string, index: number) => text.slice(0, index).split('\n').length;

/** Parte `s` por las comas de nivel 0 (ignora las que están dentro de <>, (), [] y {}). */
function splitTopLevel(s: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let cur = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if ('<([{'.includes(c)) depth++;
    else if ('>)]}'.includes(c) && !(c === '>' && s[i - 1] === '-')) depth--;
    if (c === ',' && depth === 0) {
      parts.push(cur);
      cur = '';
    } else cur += c;
  }
  if (cur.trim()) parts.push(cur);
  return parts.map((p) => p.trim()).filter(Boolean);
}

/** Devuelve el índice del cierre que corresponde al `open` de la posición `start` (ignora cadenas). */
function matchClose(text: string, start: number, strings = true): number {
  const open = text[start];
  const close = ({ '(': ')', '{': '}', '[': ']', '<': '>' } as Record<string, string>)[open];
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (strings && (c === "'" || c === '"' || c === '`')) {
      const q = c;
      i++;
      while (i < text.length && text[i] !== q) {
        if (text[i] === '\\') i++;
        i++;
      }
      continue;
    }
    if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && text[i + 1] === '*') {
      i = text.indexOf('*/', i + 2);
      if (i < 0) return -1;
      i++;
      continue;
    }
    if (c === open) depth++;
    else if (c === close) {
      if (open === '<' && text[i - 1] === '=') continue; // flecha =>
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

// ---------------------------------------------------------------------------------------------
// Rust: comandos y structs
// ---------------------------------------------------------------------------------------------
interface RustParam {
  name: string; // snake_case
  key: string; // camelCase
  type: string;
  optional: boolean;
  integer: boolean;
}
interface RustCommand {
  name: string;
  params: RustParam[];
  file: string;
}
interface RustStruct {
  camelCase: boolean;
  fields: { name: string; key: string; optional: boolean }[];
}

const INJECTED = /^(?:tauri::)?(?:State|AppHandle|Window|WebviewWindow|Webview)\b|^(?:tauri::ipc::)?Request\b/;
const INT_TYPE = /^(?:Option<\s*)?(?:u8|u16|u32|u64|usize|i8|i16|i32|i64|isize)\s*>?$/;

const rustFiles = walk(path.join(ROOT, 'desktop/src-tauri/src'), ['.rs']);
const commands = new Map<string, RustCommand>();
const structs = new Map<string, RustStruct>();

for (const file of rustFiles) {
  const text = read(file);

  const cmdRe = /#\[tauri::command\][^\n]*\n(?:\s*#\[[^\]]*\]\s*\n)*\s*(?:pub\s+)?(?:async\s+)?fn\s+(\w+)\s*(?:<[^>]*>)?\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = cmdRe.exec(text))) {
    const open = m.index + m[0].length - 1;
    const close = matchClose(text, open, false);
    const params: RustParam[] = [];
    for (const raw of splitTopLevel(text.slice(open + 1, close))) {
      const idx = raw.indexOf(':');
      if (idx < 0) continue;
      const name = raw.slice(0, idx).replace(/^mut\s+/, '').trim();
      const type = raw.slice(idx + 1).trim();
      if (INJECTED.test(type)) continue;
      params.push({
        name,
        key: camel(name),
        type,
        optional: /^Option\s*</.test(type),
        integer: INT_TYPE.test(type),
      });
    }
    commands.set(m[1], { name: m[1], params, file: rel(file) });
  }

  const structRe = /((?:#\[[^\]]*\]\s*)*)pub\s+struct\s+(\w+)\s*\{/g;
  while ((m = structRe.exec(text))) {
    const attrs = m[1];
    const open = m.index + m[0].length - 1;
    const close = matchClose(text, open, false);
    const camelCase = /rename_all\s*=\s*"camelCase"/.test(attrs);
    const fields: RustStruct['fields'] = [];
    for (const raw of splitTopLevel(text.slice(open + 1, close))) {
      const clean = raw.replace(/\/\/[^\n]*/g, '').replace(/#\[[^\]]*\]/g, (a) => (/default|skip_serializing_if/.test(a) ? ' #opt ' : '')).trim();
      const hasOpt = clean.includes('#opt');
      const fm = /^(?:pub(?:\([^)]*\))?\s+)?(\w+)\s*:\s*([\s\S]+)$/.exec(clean.replace('#opt', '').trim());
      if (!fm) continue;
      const renamed = /rename\s*=\s*"(\w+)"/.exec(raw);
      const name = fm[1];
      fields.push({
        name,
        key: renamed ? renamed[1] : camelCase ? camel(name) : name,
        optional: /^Option\s*</.test(fm[2].trim()) || hasOpt,
      });
    }
    structs.set(m[2], { camelCase, fields });
  }
}

// ---------------------------------------------------------------------------------------------
// TypeScript: llamadas a invoke
// ---------------------------------------------------------------------------------------------
interface Arg {
  key: string;
  value: string; // texto de la expresión; '' si es shorthand
  shorthand: boolean;
}
interface Call {
  cmd: string;
  file: string;
  line: number;
  args: Arg[] | null; // null: sin segundo argumento
  hasSpread: boolean;
  raw: boolean; // segundo argumento que no es un objeto en línea
}

function parseObjectLiteral(body: string): { args: Arg[]; spread: boolean } {
  const args: Arg[] = [];
  let spread = false;
  for (const part of splitTopLevel(body)) {
    const p = part.replace(/\/\/[^\n]*/g, '').trim();
    if (!p) continue;
    if (p.startsWith('...')) {
      spread = true;
      continue;
    }
    const kv = /^(?:'([^']+)'|"([^"]+)"|(\w+))\s*:\s*([\s\S]+)$/.exec(p);
    if (kv) args.push({ key: kv[1] ?? kv[2] ?? kv[3], value: kv[4].trim(), shorthand: false });
    else if (/^\w+$/.test(p)) args.push({ key: p, value: p, shorthand: true });
    else warnings.push(`no se pudo analizar la propiedad «${p.slice(0, 40)}»`);
  }
  return { args, spread };
}

const tsFiles = [
  ...walk(path.join(ROOT, 'src'), ['.ts', '.tsx'], (p) => /[\\/]preview[\\/]/.test(p)),
  ...walk(path.join(ROOT, 'desktop/frontend'), ['.ts', '.tsx'], (p) => /previewInvoke/.test(p)),
];

const calls: Call[] = [];
for (const file of tsFiles) {
  const text = read(file);
  const re = /\binvoke\s*(<)?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    let i = m.index + m[0].length;
    if (m[1]) {
      const c = matchClose(text, i - 1);
      if (c < 0) continue;
      i = c + 1;
    }
    while (/\s/.test(text[i])) i++;
    if (text[i] !== '(') continue; // `invoke` sin llamar (tipo, parámetro…)
    const close = matchClose(text, i);
    if (close < 0) continue;
    const inner = text.slice(i + 1, close);
    const parts = splitTopLevel(inner);
    const first = /^['"]([^'"]+)['"]$/.exec(parts[0] ?? '');
    const where = `${rel(file)}:${lineOf(text, m.index)}`;
    if (!first) {
      // p. ej. la firma `invoke: <T>(cmd: string, ...)` o una llamada con nombre dinámico
      if (/^(?:cmd|command|name)\b/.test(parts[0] ?? '')) continue;
      warnings.push(`${where}: invoke con nombre de comando no literal («${(parts[0] ?? '').slice(0, 40)}»), no analizable`);
      continue;
    }
    const cmd = first[1];
    if (cmd.startsWith('plugin:')) continue;
    let args: Arg[] | null = null;
    let hasSpread = false;
    let raw = false;
    if (parts.length > 1) {
      // el último argumento con forma de objeto en línea son los argumentos del comando
      // (el tercer argumento de `invoke` son las opciones, p. ej. `headers`: no son argumentos del comando)
      const objPart = parts[1].startsWith('{') ? parts[1] : null;
      if (objPart) {
        const parsed = parseObjectLiteral(objPart.slice(1, matchClose(objPart, 0)));
        args = parsed.args;
        hasSpread = parsed.spread;
      } else raw = true;
    }
    calls.push({ cmd, file: rel(file), line: lineOf(text, m.index), args, hasSpread, raw });
  }
}

// ---------------------------------------------------------------------------------------------
// Comparación
// ---------------------------------------------------------------------------------------------
/**
 * Parámetros enteros de Rust cuyo valor revisamos a mano y sabemos que la interfaz siempre envía entero.
 * Cualquier otro entero cuyo valor no se vea claramente entero es un ERROR: así un pan decimal (-1..+1)
 * hacia un `i32` no puede volver a entrar sin que alguien lo revise.
 */
const REVIEWED_INTEGER = new Set([
  'audio_set_pitch.semitones', // <select> de -6 a +6
  'audio_configure_song.beatsPerBar', // compás del proyecto (entero) con `|| 4`
  'audio_load_project.beatsPerBar',
  'audio_import_track_bytes.targetSampleRate', // frecuencia de un dispositivo
  'audio_import_folder.targetSampleRate',
  'audio_test_tone.channel', // índice de canal
  'remote_kick.deviceId', // id numérico asignado por el servidor LAN
]);
const INTEGRAL_VALUE = /^-?\d+$|Math\.(?:round|floor|ceil|trunc)\(|panToEngine\(|\.length\b|\|\s*0\b|parseInt\(|\bNumber\.isInteger/;

function checkStruct(call: Call, param: RustParam, valueText: string) {
  const typeName = param.type.replace(/^Option\s*<\s*/, '').replace(/\s*>$/, '').trim();
  const st = structs.get(typeName);
  if (!st || !valueText.startsWith('{')) return;
  const close = matchClose(valueText, 0);
  const { args, spread } = parseObjectLiteral(valueText.slice(1, close));
  const known = new Set(st.fields.map((f) => f.key));
  for (const a of args) {
    if (!known.has(a.key)) {
      errors.push(`${call.file}:${call.line}: ${call.cmd}.${param.key}: el campo «${a.key}» no existe en ${typeName} (campos: ${[...known].join(', ')})`);
    }
  }
  if (!spread) {
    for (const f of st.fields) {
      if (!f.optional && !args.some((a) => a.key === f.key)) {
        errors.push(`${call.file}:${call.line}: ${call.cmd}.${param.key}: falta el campo obligatorio «${f.key}» de ${typeName}`);
      }
    }
  }
}

const usedCommands = new Set<string>();
for (const call of calls) {
  const cmd = commands.get(call.cmd);
  const where = `${call.file}:${call.line}`;
  if (!cmd) {
    errors.push(`${where}: el comando «${call.cmd}» no existe en Rust`);
    continue;
  }
  usedCommands.add(call.cmd);
  if (call.raw) continue; // p. ej. audio_import_track_bytes_raw: cuerpo binario y cabeceras
  const given = call.args ?? [];
  const keys = new Set(cmd.params.map((p) => p.key));

  for (const a of given) {
    if (!keys.has(a.key)) {
      errors.push(`${where}: ${call.cmd}: el argumento «${a.key}» no existe en Rust (esperados: ${[...keys].join(', ') || 'ninguno'})`);
    }
  }
  if (!call.hasSpread) {
    for (const p of cmd.params) {
      if (!p.optional && !given.some((a) => a.key === p.key)) {
        errors.push(`${where}: ${call.cmd}: falta el argumento obligatorio «${p.key}» (${p.type})`);
      }
    }
  } else {
    warnings.push(`${where}: ${call.cmd}: usa ...spread, no se comprueban los argumentos que faltan`);
  }
  for (const a of given) {
    const p = cmd.params.find((x) => x.key === a.key);
    if (!p) continue;
    if (p.integer && a.value !== 'null' && a.value !== 'undefined' && !INTEGRAL_VALUE.test(a.value)) {
      if (!REVIEWED_INTEGER.has(`${call.cmd}.${p.key}`)) {
        errors.push(
          `${where}: ${call.cmd}.${p.key} es ${p.type} en Rust y «${a.value.slice(0, 50)}» no se ve entero: conviértelo (p. ej. Math.round) o, si ya lo revisaste, añádelo a REVIEWED_INTEGER`
        );
      }
    }
    checkStruct(call, p, a.value);
  }
}

for (const name of commands.keys()) {
  if (!usedCommands.has(name) && !name.startsWith('remote_') && !name.startsWith('desktop_update')) {
    warnings.push(`el comando «${name}» (${commands.get(name)!.file}) no lo llama ninguna interfaz`);
  }
}

// ---------------------------------------------------------------------------------------------
// Registro triple: generate_handler!, build.rs y capabilities
// ---------------------------------------------------------------------------------------------
{
  const main = read(path.join(ROOT, 'desktop/src-tauri/src/main.rs'));
  const gh = /generate_handler!\s*\[([\s\S]*?)\]/.exec(main);
  const inHandler = new Set(
    (gh?.[1] ?? '').split(',').map((s) => s.trim().split('::').pop()!).filter(Boolean)
  );
  const build = read(path.join(ROOT, 'desktop/src-tauri/build.rs'));
  const inBuild = new Set([...build.matchAll(/"([a-z_]+)"/g)].map((x) => x[1]).filter((n) => n !== 'shell'));
  const cap = JSON.parse(read(path.join(ROOT, 'desktop/src-tauri/capabilities/desktop-remote.json'))) as { permissions: string[] };
  const inCaps = new Set(cap.permissions.filter((p) => p.startsWith('allow-')).map((p) => p.slice(6).replace(/-/g, '_')));

  for (const name of commands.keys()) {
    const miss: string[] = [];
    if (!inHandler.has(name)) miss.push('generate_handler! (main.rs)');
    if (!inBuild.has(name)) miss.push('.commands (build.rs)');
    if (!inCaps.has(name)) miss.push('permissions (desktop-remote.json)');
    if (miss.length) errors.push(`el comando «${name}» no está registrado en: ${miss.join(', ')}`);
  }
  for (const [label, set] of [['generate_handler!', inHandler], ['build.rs', inBuild], ['capabilities', inCaps]] as const) {
    for (const n of set) {
      if (!commands.has(n)) errors.push(`${label} registra «${n}», que no es un comando #[tauri::command] de Rust`);
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Respuestas: cada propiedad que la interfaz lee de una respuesta de Rust debe existir en la struct
// ---------------------------------------------------------------------------------------------
const RESPONSE_TYPES: { file: string; iface: string; rust: string }[] = [
  { file: 'src/audio/nativeAudioEngine.ts', iface: 'NativePlaybackSnapshot', rust: 'PlaybackStateSnapshot' },
  { file: 'desktop/frontend/DesktopAudioSettings.tsx', iface: 'PlaybackStateSnapshot', rust: 'PlaybackStateSnapshot' },
  { file: 'desktop/frontend/DesktopAudioSettings.tsx', iface: 'AudioStreamStatsSnapshot', rust: 'AudioStreamStatsSnapshot' },
  { file: 'desktop/frontend/DesktopAudioSettings.tsx', iface: 'AudioDeviceInfo', rust: 'AudioDeviceInfo' },
  { file: 'desktop/frontend/DesktopAudioSettings.tsx', iface: 'AudioSettings', rust: 'AudioSettings' },
];
for (const r of RESPONSE_TYPES) {
  const text = read(path.join(ROOT, r.file));
  const m = new RegExp(`interface\\s+${r.iface}\\s*\\{`).exec(text);
  const st = structs.get(r.rust);
  if (!m || !st) {
    errors.push(`respuestas: no se encontró ${!m ? `la interfaz ${r.iface} en ${r.file}` : `la struct ${r.rust} en Rust`}`);
    continue;
  }
  const open = m.index + m[0].length - 1;
  const body = text.slice(open + 1, matchClose(text, open));
  const known = new Set(st.fields.map((f) => f.key));
  for (const pm of body.matchAll(/^\s{2}(\w+)\??\s*:/gm)) {
    if (!known.has(pm[1])) {
      errors.push(`${r.file}: ${r.iface}.${pm[1]} no existe en la struct ${r.rust} de Rust (campos: ${[...known].join(', ')}): siempre llegaría vacío`);
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Informe
// ---------------------------------------------------------------------------------------------
console.log(`verify:ipc — ${commands.size} comandos en Rust, ${calls.length} llamadas invoke analizadas en ${tsFiles.length} archivos.`);
const uniq = (a: string[]) => [...new Set(a)];
for (const w of uniq(warnings)) console.log(`  AVISO  ${w}`);
for (const e of uniq(errors)) console.log(`  ERROR  ${e}`);
if (errors.length) {
  console.error(`verify:ipc: ${uniq(errors).length} error(es).`);
  process.exit(1);
}
console.log(`verify:ipc: OK (${uniq(warnings).length} aviso(s)).`);
