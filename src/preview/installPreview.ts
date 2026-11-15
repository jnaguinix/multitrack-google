import { createPreviewBackend } from './previewBackend';

/**
 * Vista previa en el navegador: si la app corre con `npm run dev` fuera de Tauri, instala un `window.__TAURI__`
 * simulado (canciones de ejemplo, transporte y medidores animados, sin sonido) para poder ver y medir la
 * interfaz sin compilar el .exe. Añade `?sinvista` a la dirección para desactivarlo.
 *
 * Debe importarse el PRIMERO en main.tsx: el motor lee `window.__TAURI__` al cargarse.
 */
if (
  import.meta.env.DEV &&
  typeof window !== 'undefined' &&
  !(window as any).__TAURI__ &&
  !window.location.search.includes('sinvista')
) {
  const backend = createPreviewBackend();
  (window as any).__TAURI__ = {
    core: { invoke: backend.invoke },
    event: { listen: backend.listen },
  };
  console.info('[Vista previa] Motor simulado activo: canciones de ejemplo, sin audio. Usa ?sinvista para desactivarlo.');
}
