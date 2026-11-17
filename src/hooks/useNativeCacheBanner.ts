import { useCallback, useEffect, useState } from 'react';
import { nativeAudioEngine } from '../audio/nativeAudioEngine';
import type { SongProject } from '../types/project';

export interface NativeCacheProgress {
  percent: number;
  text: string;
}

interface Deps {
  currentProject: SongProject | null;
  isDesktopApp: boolean;
  showToast: (msg: string) => void;
}

/**
 * Estado de los avisos del motor nativo en la barra superior: dispositivo de audio desconectado y canción sin
 * caché PCM para este dispositivo (con el botón «Generar caché nativa»).
 */
export function useNativeCacheBanner({ currentProject, isDesktopApp, showToast }: Deps) {
  const [isDeviceDisconnected, setIsDeviceDisconnected] = useState(false);
  const [missingNativeCache, setMissingNativeCache] = useState(false);
  const [isGeneratingNativeCache, setIsGeneratingNativeCache] = useState(false);
  const [nativeCacheProgress, setNativeCacheProgress] = useState<NativeCacheProgress>({ percent: 0, text: '' });

  useEffect(() => {
    if (isDesktopApp) {
      nativeAudioEngine.setOnDeviceDisconnected((disconnected) => {
        setIsDeviceDisconnected(disconnected);
      });
    }
  }, [isDesktopApp]);

  useEffect(() => {
    if (isDesktopApp && currentProject && currentProject.tracks.length > 0) {
      if (nativeAudioEngine.isProjectImporting(currentProject.id)) {
        setMissingNativeCache(false);
        return;
      }
      nativeAudioEngine.checkProjectCacheStatus(currentProject).then((st) => {
        if (!nativeAudioEngine.isProjectImporting(currentProject.id)) {
          setMissingNativeCache(!st.isReady);
        }
      });
    } else {
      setMissingNativeCache(false);
    }
  }, [currentProject?.id, isDesktopApp]);

  /** Botón «Generar caché nativa» del aviso. */
  const generateMissingCache = useCallback(
    async (project: SongProject | null) => {
      if (!project) return;
      if (nativeAudioEngine.isProjectImporting(project.id)) {
        showToast(`"${project.title}": la caché ya se está generando.`);
        return;
      }
      setIsGeneratingNativeCache(true);
      setNativeCacheProgress({ percent: 5, text: 'Iniciando verificación...' });
      try {
        const ok = await nativeAudioEngine.generateNativeCacheForProject(project, (percent, text) => {
          setNativeCacheProgress({ percent, text });
        });
        if (ok) {
          setMissingNativeCache(false);
          await nativeAudioEngine.loadProject(project);
          showToast(`Caché nativa lista para "${project.title}".`);
        } else {
          showToast(`No se pudo generar la caché nativa para "${project.title}".`);
        }
      } catch (err: any) {
        console.error('[Banner] Error generando caché nativa:', err);
        showToast(`Error al generar caché nativa: ${err?.message || err}`);
      } finally {
        setIsGeneratingNativeCache(false);
      }
    },
    [showToast]
  );

  return {
    isDeviceDisconnected,
    missingNativeCache,
    setMissingNativeCache,
    isGeneratingNativeCache,
    setIsGeneratingNativeCache,
    nativeCacheProgress,
    setNativeCacheProgress,
    generateMissingCache,
  };
}
