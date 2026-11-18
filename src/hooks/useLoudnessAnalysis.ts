import { useEffect } from 'react';
import type { SongLoudness, SongProject } from '../types/project';
import { withLoudness } from '../utils/loudness';
import { logAsyncError } from '../utils/asyncErrors';

interface Deps {
  isDesktopApp: boolean;
  /** Identifica el conjunto de canciones del setlist: al cambiar se pide al motor que mida las que falten. */
  setlistKey: string;
  setProjects: React.Dispatch<React.SetStateAction<SongProject[]>>;
  setCurrentProject: React.Dispatch<React.SetStateAction<SongProject | null>>;
}

interface LoudnessEventPayload {
  projectId: string;
  loudness?: SongLoudness | null;
  error?: string | null;
}

/**
 * Sonoridad de las canciones (solo escritorio). La mide el motor en segundo plano, sin que la interfaz haga nada:
 * al generar la caché de una canción, y aquí al abrir la app o al cambiar el setlist se le pide que mida las que
 * falten (lo que ya está medido y al día se omite). El motor guarda el resultado en la biblioteca y avisa por
 * `audio://loudness`; la interfaz solo lo refleja en su copia de la canción (no hay que guardar nada desde aquí).
 */
export function useLoudnessAnalysis({ isDesktopApp, setlistKey, setProjects, setCurrentProject }: Deps) {
  useEffect(() => {
    if (!isDesktopApp) return;
    const listen = (window as any).__TAURI__?.event?.listen;
    if (!listen) return;
    let unlisten: (() => void) | null = null;
    let disposed = false;

    listen('audio://loudness', (event: { payload?: LoudnessEventPayload }) => {
      const payload = event?.payload;
      if (!payload) return;
      if (payload.error) {
        console.warn(`[Sonoridad] No se pudo medir '${payload.projectId}': ${payload.error}`);
        return;
      }
      if (!payload.loudness) return;
      const { projectId, loudness } = payload;
      setProjects((prev) => prev.map((p) => withLoudness(p, projectId, loudness)));
      setCurrentProject((prev) => (prev ? withLoudness(prev, projectId, loudness) : prev));
    })
      .then((stop: () => void) => {
        if (disposed) stop();
        else unlisten = stop;
      })
      .catch(logAsyncError('escuchar la sonoridad medida por el motor'));

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [isDesktopApp, setProjects, setCurrentProject]);

  useEffect(() => {
    if (!isDesktopApp || !setlistKey) return;
    const invoke = (window as any).__TAURI__?.core?.invoke;
    if (!invoke) return;
    // Con un pequeño retraso: al abrir la app y al añadir canciones hay otras cosas (caché, precarga) que van primero.
    const timer = window.setTimeout(() => {
      invoke('audio_analyze_loudness', {}).catch(logAsyncError('pedir al motor que mida la sonoridad'));
    }, 2500);
    return () => window.clearTimeout(timer);
  }, [isDesktopApp, setlistKey]);
}
