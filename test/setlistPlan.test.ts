// Pruebas de la lógica del plan del servicio: transición por canción y plantillas de sección.

import { resolveTransition, TRANSITION_LABELS } from '../src/utils/setlistTransition';
import { insertTemplateSection, SECTION_TEMPLATES } from '../src/utils/sectionTemplates';
import type { SongSection } from '../src/types/project';

function assert(condition: boolean, msg: string) {
  if (!condition) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
}

console.log('=== PRUEBAS: plan del servicio (transición por canción y plantillas) ===');

// 1. La opción propia gana al ajuste general; sin opción propia manda el general.
assert(resolveTransition({ transitionToNext: 'stop' }, 'auto-play') === 'stop', 'la opción propia gana');
assert(resolveTransition({ transitionToNext: undefined }, 'cue-next') === 'cue-next', 'sin opción propia, el general');
assert(resolveTransition(null, 'auto-play') === 'auto-play', 'sin canción, el general');
assert(resolveTransition({ transitionToNext: 'basura' as any }, 'stop') === 'stop', 'un valor inválido se ignora');
assert(Object.keys(TRANSITION_LABELS).length === 3, 'tres etiquetas de transición');
console.log('OK 1: transición por canción con respaldo en el ajuste general');

// 2. Plantillas: códigos únicos para el mismo tipo de sección y colores por tipo.
const codes = SECTION_TEMPLATES.map((t) => t.code);
assert(new Set(codes).size === codes.length, 'los códigos de las plantillas son únicos');
assert(SECTION_TEMPLATES.find((t) => t.key === 'chorus')!.code === 'C', 'el coro es C');
console.log('OK 2: plantillas con código único');

// 3. Insertar en una canción vacía: una sección que ocupa toda la canción.
const T = (key: string) => SECTION_TEMPLATES.find((t) => t.key === key)!;
let secs: SongSection[] = [];
secs = insertTemplateSection(secs, T('intro'), 0, 240, 'a');
assert(secs.length === 1 && secs[0].startTimeSec === 0 && secs[0].endTimeSec === 240, 'primera sección cubre la canción');

// 4. Insertar más: orden por inicio y finales encadenados.
secs = insertTemplateSection(secs, T('chorus'), 100, 240, 'b');
secs = insertTemplateSection(secs, T('verse-1'), 30.004, 240, 'c');
assert(secs.map((s) => s.code).join(',') === 'I,V1,C', `orden por tiempo (fue ${secs.map((s) => s.code).join(',')})`);
assert(secs[0].endTimeSec === 30 && secs[1].endTimeSec === 100 && secs[2].endTimeSec === 240, 'los finales se encadenan');
console.log('OK 3-4: orden por tiempo y finales encadenados');

// 5. Misma posición: sustituye, no duplica.
secs = insertTemplateSection(secs, T('bridge'), 100.02, 240, 'd');
assert(secs.length === 3 && secs[2].code === 'P', 'misma posición sustituye la sección');
// 6. Límites: negativo y pasado del final.
secs = insertTemplateSection(secs, T('outro'), 9999, 240, 'e');
assert(secs[secs.length - 1].startTimeSec <= 239.5, 'no empieza fuera de la canción');
secs = insertTemplateSection(secs, T('count-in'), -5, 240, 'f');
assert(secs[0].startTimeSec === 0 && secs[0].code === 'Ci', 'no empieza antes de 0');
assert(secs.every((s) => s.endTimeSec > s.startTimeSec), 'ninguna sección con duración cero');
console.log('OK 5-6: sustitución y límites');

console.log('\nTODAS LAS PRUEBAS PASARON');
process.exit(0);
