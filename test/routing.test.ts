// Pruebas de las reglas de ruteo de la interfaz (copia de las de `audio/routing.rs`, que sigue siendo la autoridad).
import { proposeRouting, toggleSource, validateRouting, type RoutingConfig } from '../desktop/frontend/routing';

function assert(condition: boolean, msg: string) {
  if (!condition) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
}
const names = (c: RoutingConfig, i: number) => c.outputs[i].sources.map((e) => e.source).join('+');

// Propuesta según los canales independientes del dispositivo
const c2 = proposeRouting(2);
assert(names(c2, 0) === 'musicMono' && names(c2, 1) === 'click+guide', '2 salidas: música mono y click+guía');
const c3 = proposeRouting(3);
assert(names(c3, 0) === 'musicL' && names(c3, 1) === 'musicR' && names(c3, 2) === 'click+guide', '3 salidas: música L/R y click+guía');
const c6 = proposeRouting(6);
assert(names(c6, 2) === 'click' && names(c6, 3) === 'guide', '4 o más: click y guía separados');
assert(c6.outputs[4].sources.length === 0 && c6.outputs[5].sources.length === 0, 'las salidas extra quedan libres');
for (const n of [2, 3, 4, 6, 8]) assert(validateRouting(proposeRouting(n), n).length === 0, `la propuesta de ${n} salidas es válida`);

// Una sola salida mezclaría el click con la música: exige confirmación
assert(validateRouting(proposeRouting(1), 1).length > 0, '1 salida: inválida hasta confirmar');
assert(validateRouting({ ...proposeRouting(1), allowMixed: true }, 1).length === 0, '1 salida confirmada: válida');

// Click o guía sin destino, y música mezclada con click
const sinGuia = { ...proposeRouting(4), outputs: proposeRouting(4).outputs.map((o, i) => (i === 3 ? { sources: [] } : o)) };
assert(validateRouting(sinGuia, 4).some((m) => m.includes('guía')), 'guía sin salida');
const mezcla = toggleSource(proposeRouting(4), 0, 'click');
assert(validateRouting(mezcla, 4).some((m) => m.includes('salida 1')), 'click mezclado con música en la salida 1');
assert(mezcla.custom, 'editar a mano marca el ruteo como personalizado');

// Otra cantidad de canales nunca es válida (no se recorta ni se rellena en silencio)
assert(validateRouting(proposeRouting(4), 2).length === 1, 'un ruteo de 4 salidas no vale para un dispositivo de 2');
assert(validateRouting(proposeRouting(2), 0).length === 1, 'sin salidas');

// toggleSource no modifica el original
const base = proposeRouting(3);
toggleSource(base, 2, 'musicMono');
assert(names(base, 2) === 'click+guide', 'toggleSource devuelve una copia');

console.log('routing: OK');
