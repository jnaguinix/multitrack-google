import './preview/installPreview';
import './utils/invokeTraceInstall';
import { Profiler } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.tsx';
import '@fontsource-variable/inter/opsz.css';
import './index.css';

// Solo en desarrollo: cuenta los renderizados y su duración (window.__render) para medir el coste de la
// interfaz con el Profiler de React. En producción este envoltorio se descarta.
function recordRender(_id: string, _phase: string, actualDuration: number): void {
  const w = window as unknown as { __render?: { commits: number; totalMs: number; maxMs: number } };
  const s = (w.__render ??= { commits: 0, totalMs: 0, maxMs: 0 });
  s.commits += 1;
  s.totalMs += actualDuration;
  if (actualDuration > s.maxMs) s.maxMs = actualDuration;
}

const app = <App />;
createRoot(document.getElementById('root')!).render(
  import.meta.env.DEV ? (
    <Profiler id="app" onRender={recordRender}>
      {app}
    </Profiler>
  ) : (
    app
  )
);
