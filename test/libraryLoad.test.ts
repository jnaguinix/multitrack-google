// Un error al leer la biblioteca NO es «biblioteca vacía»: debe llegar como error, no como lista sin canciones.
import { loadAllProjectsFromDb } from '../src/storage/projectDb';
import { describeLoadError, tryLoadLibrary } from '../src/storage/libraryLoader';

function assert(condition: boolean, msg: string) {
  if (!condition) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
}

// Escritorio simulado: `library_load` devuelve lo que se le indique.
function setDesktop(libraryLoad: () => Promise<unknown>) {
  (globalThis as any).window = {
    __TAURI__: {
      core: {
        invoke: async (command: string) => {
          assert(command === 'library_load', `solo se espera library_load, no ${command}`);
          return libraryLoad();
        },
      },
    },
  };
}

const consoleError = console.error;
const silencioso = () => {
  console.error = () => {};
};
const normal = () => {
  console.error = consoleError;
};

// 1. Archivo corrupto sin respaldo (error de Rust, llega como texto): la carga falla, no devuelve [].
setDesktop(async () => {
  throw 'Archivo library.json corrupto y sin backup válido: expected value at line 1 column 1';
});
silencioso();
let lanzo: unknown = null;
try {
  const lista = await loadAllProjectsFromDb();
  lanzo = `devolvió ${JSON.stringify(lista)}`;
} catch (error) {
  lanzo = error;
}
normal();
assert(lanzo instanceof Error, `un fallo de lectura debe lanzar, no devolver una lista: ${String(lanzo)}`);
assert(String((lanzo as Error).message).includes('corrupto'), `conserva el motivo: ${(lanzo as Error).message}`);

// 2. Una biblioteca realmente vacía sí es una lista vacía.
setDesktop(async () => ({ version: 1, updatedAt: 1, activeSetlist: [], songs: [] }));
const vacia = await loadAllProjectsFromDb();
assert(Array.isArray(vacia) && vacia.length === 0, 'biblioteca vacía = lista vacía');

// 3. Un archivo sin la lista de canciones no es una biblioteca vacía: es un error.
setDesktop(async () => ({ version: 1, updatedAt: 1, activeSetlist: [] }));
let malformada: unknown = null;
try {
  malformada = await loadAllProjectsFromDb();
} catch (error) {
  malformada = error;
}
assert(malformada instanceof Error, 'sin `songs` es un error, no una biblioteca vacía');

// 4. Con canciones, las devuelve.
const cancion = {
  id: 'song-1', title: 'Una', artist: 'A', bpm: 120, keySignature: 'C', updatedAt: 5, tracks: [], sections: [],
};
setDesktop(async () => ({ version: 1, updatedAt: 1, activeSetlist: ['song-1'], songs: [cancion] }));
const una = await loadAllProjectsFromDb();
assert(una.length === 1 && una[0].id === 'song-1' && una[0].inSetlist === true, 'devuelve la canción y su marca de setlist');

// 5. El envoltorio que usa la interfaz separa «vacía» de «no se pudo leer».
const ok = await tryLoadLibrary(async () => []);
assert(ok.ok && ok.projects.length === 0, 'vacía: ok con lista vacía');
const fallo = await tryLoadLibrary(async () => {
  throw 'Error leyendo library.json: acceso denegado';
});
assert(!fallo.ok && fallo.message.includes('acceso denegado'), 'error: ok=false con el motivo');
assert(describeLoadError(new Error('x')) === 'x' && describeLoadError('y') === 'y' && describeLoadError(null) === 'error desconocido', 'describeLoadError');

delete (globalThis as any).window;
console.log('libraryLoad: OK');
