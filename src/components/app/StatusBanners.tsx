import React from 'react';
import { AlertTriangle } from 'lucide-react';
import { nativeAudioEngine } from '../../audio/nativeAudioEngine';
import type { NativeCacheProgress } from '../../hooks/useNativeCacheBanner';
import type { SongProject } from '../../types/project';

/** Aviso: la interfaz de audio se desconectó en caliente (la posición se conserva). */
export const DeviceDisconnectedBanner: React.FC<{ currentTimeSec: number }> = ({ currentTimeSec }) => (
  <div className="bg-rose-950/95 border-b border-rose-800 text-rose-200 px-4 py-2 flex items-center justify-between text-xs z-50 shadow-lg">
    <div className="flex items-center gap-2">
      <AlertTriangle className="w-4 h-4 text-rose-400 shrink-0" />
      <span>
        <strong>Dispositivo de audio desconectado.</strong> La reproducción se ha pausado y la posición se conserva en{' '}
        <strong className="font-mono text-white">
          {Math.floor(currentTimeSec / 60)}:{String(Math.floor(currentTimeSec % 60)).padStart(2, '0')}.{Math.floor((currentTimeSec % 1) * 10)}
        </strong>. Conéctalo de nuevo y pulsa Reabrir.
      </span>
    </div>
    <button
      type="button"
      onClick={() => void nativeAudioEngine.reopenDevice()}
      className="px-3 py-1 bg-rose-600 hover:bg-rose-500 text-white rounded font-medium cursor-pointer transition-colors shrink-0"
    >
      Reabrir dispositivo
    </button>
  </div>
);

interface MissingCacheBannerProps {
  project: SongProject | null;
  isGenerating: boolean;
  progress: NativeCacheProgress;
  onGenerate: () => void;
}

/** Aviso: la canción actual no tiene caché PCM nativa a la frecuencia del dispositivo. */
export const MissingCacheBanner: React.FC<MissingCacheBannerProps> = ({ project, isGenerating, progress, onGenerate }) => {
  // Avance REAL por pista (evento audio://import-progress), no los saltos 5/15/100 %.
  const liveProgress = project ? nativeAudioEngine.formatImportProgress(project.id) : null;
  const isBusy = isGenerating || Boolean(liveProgress);
  return (
    <div className="bg-amber-950/90 border-b border-amber-800/80 text-amber-200 px-4 py-2 flex items-center justify-between text-xs z-50 shadow-md">
      <div className="flex items-center gap-2">
        <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0" />
        <span>
          La canción actual <strong>"{project?.title}"</strong> no dispone de caché PCM nativa para este dispositivo.
          {liveProgress
            ? ` (${liveProgress})`
            : isGenerating
            ? ` (${progress.percent}% - ${progress.text})`
            : ''}
        </span>
      </div>
      <button
        type="button"
        disabled={isBusy}
        onClick={onGenerate}
        className="px-3 py-1 bg-amber-500 hover:bg-amber-400 text-black font-semibold rounded cursor-pointer transition-colors disabled:opacity-50 shrink-0"
      >
        {isBusy ? 'Generando...' : 'Generar caché nativa'}
      </button>
    </div>
  );
};
