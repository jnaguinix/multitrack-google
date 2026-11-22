// Un fallo persistente de guardado (carpeta de la canción sin conexión…) avisa una vez, no en cada guardado.
import { FailureTracker } from '../src/storage/failureTracker';
import { notifyUser, onUserNotice } from '../src/utils/userNotices';

function assert(condition: boolean, msg: string) {
  if (!condition) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
}

const t = new FailureTracker();
assert(t.report('a', null) === false, 'un guardado correcto no avisa');
assert(t.report('a', 'carpeta ausente') === true, 'el primer fallo avisa');
assert(t.report('a', 'carpeta ausente') === false, 'el mismo fallo repetido no vuelve a avisar');
assert(t.report('a', 'carpeta ausente') === false, '…ni la tercera vez');
assert(t.report('a', 'solo lectura') === true, 'otro motivo sí avisa');
assert(t.report('b', 'carpeta ausente') === true, 'otra canción tiene su propio aviso');
assert(t.report('a', undefined) === false, 'volver a guardar bien no avisa');
assert(t.report('a', 'solo lectura') === true, 'si falla de nuevo después de funcionar, avisa otra vez');
assert(t.report('b', '') === false, 'cadena vacía = sin error');

// El canal de avisos entrega a quien se suscribe y deja de hacerlo al cancelar.
const recibidos: string[] = [];
const cancelar = onUserNotice((m) => recibidos.push(m));
notifyUser('uno');
cancelar();
const aviso = console.warn;
let enConsola = 0;
console.warn = () => {
  enConsola += 1;
};
notifyUser('dos');
console.warn = aviso;
assert(recibidos.length === 1 && recibidos[0] === 'uno', 'el suscriptor recibe el aviso');
assert(enConsola === 1, 'sin suscriptores el aviso queda en la consola');

console.log('failureTracker: OK');
