import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import {defineConfig} from 'vite';

export default defineConfig(() => {
  return {
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        '@': path.resolve(import.meta.dirname, '.'),
      },
    },
    server: {
      // Con DISABLE_HMR=true se apaga la recarga en caliente y la vigilancia de archivos (herencia de la plantilla
      // original: sirve para que un agente edite sin que la vista previa parpadee). Sin esa variable, todo normal.
      hmr: process.env.DISABLE_HMR !== 'true',
      // Fuera del watcher: la compilación de Rust (`target`, bloquea el .exe y los .pdb mientras enlaza: EBUSY),
      // la salida de `vite build` y la carpeta local de agentes.
      watch:
        process.env.DISABLE_HMR === 'true'
          ? null
          : { ignored: ['**/desktop/src-tauri/target/**', '**/dist/**', '**/.claude/**'] },
    },
  };
});
