import { useCallback } from 'react';
import { SongProject } from '../types/project';
import { nativeAudioEngine } from '../audio/nativeAudioEngine';

interface UseOptimizationDeps {
  showToast: (msg: string) => void;
  currentProjectRef: React.MutableRefObject<SongProject | null>;
  setIsGeneratingNativeCache: React.Dispatch<React.SetStateAction<boolean>>;
  setNativeCacheProgress: React.Dispatch<React.SetStateAction<{ percent: number; text: string }>>;
  setMissingNativeCache: React.Dispatch<React.SetStateAction<boolean>>;
}

/**
 * Generación de la caché PCM nativa de una canción (botón «Generar caché nativa»). La copia de
 * audio a OPFS del motor web se retiró: la caché vive en disco, en Rust.
 */
export function useOptimization({
  showToast,
  currentProjectRef,
  setIsGeneratingNativeCache,
  setNativeCacheProgress,
  setMissingNativeCache,
}: UseOptimizationDeps) {
  const handleStartOptimizeProject = useCallback(
    (projectToOptimize: SongProject) => {
      setIsGeneratingNativeCache(true);
      setNativeCacheProgress({ percent: 5, text: 'Iniciando verificación...' });
      nativeAudioEngine
        // Botón «Optimizar» pulsado por el usuario: puede pedirle la carpeta si los archivos originales ya no están.
        .generateNativeCacheForProject(
          projectToOptimize,
          (percent, text) => {
            setNativeCacheProgress({ percent, text });
          },
          { askForFolder: true }
        )
        .then(async (ok) => {
          if (ok) {
            if (currentProjectRef.current?.id === projectToOptimize.id) {
              setMissingNativeCache(false);
              await nativeAudioEngine.loadProject(projectToOptimize);
            }
            showToast(`Caché nativa lista para "${projectToOptimize.title}".`);
          } else {
            showToast(`No se pudo generar la caché nativa para "${projectToOptimize.title}".`);
          }
        })
        .catch((err: any) => {
          showToast(`Error al generar caché nativa: ${err?.message || err}`);
        })
        .finally(() => {
          setIsGeneratingNativeCache(false);
        });
    },
    [showToast]
  );

  return { handleStartOptimizeProject };
}
