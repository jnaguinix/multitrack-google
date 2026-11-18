// Pruebas de la navegación con teclado de los menús (flechas, Inicio/Fin y primera letra).
import { menuIndexByInitial, nextMenuIndex } from '../src/utils/menuNavigation';

function assert(condition: boolean, msg: string) {
  if (!condition) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
}

const none = [false, false, false, false];

// Flechas: avanzan y retroceden dando la vuelta por los extremos.
assert(nextMenuIndex(none, 0, 'ArrowDown') === 1, '↓ pasa a la siguiente');
assert(nextMenuIndex(none, 3, 'ArrowDown') === 0, '↓ en la última vuelve a la primera');
assert(nextMenuIndex(none, 0, 'ArrowUp') === 3, '↑ en la primera va a la última');
assert(nextMenuIndex(none, 2, 'ArrowUp') === 1, '↑ pasa a la anterior');

// Sin foco previo (-1): ↓ entra por la primera y ↑ por la última.
assert(nextMenuIndex(none, -1, 'ArrowDown') === 0, '↓ sin foco: primera');
assert(nextMenuIndex(none, -1, 'ArrowUp') === 3, '↑ sin foco: última');

// Inicio y Fin.
assert(nextMenuIndex(none, 2, 'Home') === 0 && nextMenuIndex(none, 1, 'End') === 3, 'Inicio y Fin');

// Las opciones deshabilitadas se saltan.
const withDisabled = [false, true, true, false];
assert(nextMenuIndex(withDisabled, 0, 'ArrowDown') === 3, '↓ salta las deshabilitadas');
assert(nextMenuIndex(withDisabled, 3, 'ArrowUp') === 0, '↑ salta las deshabilitadas');
assert(nextMenuIndex([true, false, false, true], -1, 'Home') === 1, 'Inicio: primera habilitada');
assert(nextMenuIndex([true, false, false, true], 1, 'End') === 2, 'Fin: última habilitada');

// Casos límite: menú vacío, todo deshabilitado, una sola opción y teclas ajenas.
assert(nextMenuIndex([], -1, 'ArrowDown') === -1, 'menú vacío');
assert(nextMenuIndex([true, true], 0, 'ArrowDown') === -1, 'todo deshabilitado');
assert(nextMenuIndex([false], 0, 'ArrowDown') === 0 && nextMenuIndex([false], 0, 'ArrowUp') === 0, 'una sola opción');
assert(nextMenuIndex(none, 1, 'x') === 1, 'otra tecla no mueve');

// Primera letra: sin mayúsculas ni acentos, y rota entre las que empiezan igual.
const labels = ['Añadir al Setlist', 'Editar metadatos', 'Exportar JSON', 'Eliminar canción'];
assert(menuIndexByInitial(labels, none, -1, 'a') === 0, 'a → Añadir');
assert(menuIndexByInitial(labels, none, -1, 'A') === 0, 'mayúscula');
assert(menuIndexByInitial(labels, none, -1, 'e') === 1, 'e → primera con e');
assert(menuIndexByInitial(labels, none, 1, 'e') === 2, 'e otra vez → siguiente con e');
assert(menuIndexByInitial(labels, none, 3, 'e') === 1, 'y da la vuelta');
assert(menuIndexByInitial(labels, none, -1, 'z') === -1, 'sin coincidencia');
assert(menuIndexByInitial(labels, [false, false, true, false], 1, 'e') === 3, 'salta la deshabilitada');
assert(menuIndexByInitial(['Ñu', 'Nube'], [false, false], -1, 'n') === 0, 'se compara sin diacríticos: «Ñu» cuenta como n');
assert(menuIndexByInitial(labels, none, -1, ' ') === -1 && menuIndexByInitial(labels, none, -1, 'ab') === -1, 'espacio o más de un carácter no cuentan');

console.log('menuNavigation: OK');
