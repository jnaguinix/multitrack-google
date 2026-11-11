import { cleanSongTitleAndMetadata } from '../src/audio/smartAnalyzer';

function assert(condition: boolean, message: string) {
  if (!condition) {
    console.error(`FAIL: ${message}`);
    process.exit(1);
  }
}

console.log('=== PRUEBAS UNITARIAS: Limpieza de Títulos y Metadatos ===');

// Caso 1: «Multitrack _ERES BENDITO_ ORIGINAL Jaime Murrel-G major-108bpm-440hz»
const case1 = cleanSongTitleAndMetadata('Multitrack _ERES BENDITO_ ORIGINAL Jaime Murrel-G major-108bpm-440hz');
console.log('Caso 1 resultado:', case1);
assert(case1.title === 'Eres Bendito', `Caso 1 título esperado 'Eres Bendito', obtenido '${case1.title}'`);
assert(case1.artist === 'Jaime Murrel', `Caso 1 artista esperado 'Jaime Murrel', obtenido '${case1.artist}'`);
assert(case1.key === 'G Major', `Caso 1 tono esperado 'G Major', obtenido '${case1.key}'`);
assert(case1.bpm === 108, `Caso 1 BPM esperado 108, obtenido '${case1.bpm}'`);
console.log('✔ Caso 1 PASADO');

// Caso 2: «Dios el mas grande - Juan Carlos A - MT»
const case2 = cleanSongTitleAndMetadata('Dios el mas grande - Juan Carlos A - MT');
console.log('Caso 2 resultado:', case2);
assert(case2.title === 'Dios el mas grande', `Caso 2 título esperado 'Dios el mas grande', obtenido '${case2.title}'`);
assert(case2.artist === 'Juan Carlos A', `Caso 2 artista esperado 'Juan Carlos A', obtenido '${case2.artist}'`);
console.log('✔ Caso 2 PASADO');

// Caso 3: «Dios el mas grande - Juan Carlos A -Bb124»
const case3 = cleanSongTitleAndMetadata('Dios el mas grande - Juan Carlos A -Bb124');
console.log('Caso 3 resultado:', case3);
assert(case3.title === 'Dios el mas grande', `Caso 3 título esperado 'Dios el mas grande', obtenido '${case3.title}'`);
assert(case3.artist === 'Juan Carlos A', `Caso 3 artista esperado 'Juan Carlos A', obtenido '${case3.artist}'`);
assert(case3.key === 'Bb', `Caso 3 tono esperado 'Bb', obtenido '${case3.key}'`);
assert(case3.bpm === 124, `Caso 3 BPM esperado 124, obtenido '${case3.bpm}'`);
console.log('✔ Caso 3 PASADO');

console.log('=== TODAS LAS PRUEBAS DE LIMPIEZA DE TÍTULOS PASARON EXITOSAMENTE ===');
