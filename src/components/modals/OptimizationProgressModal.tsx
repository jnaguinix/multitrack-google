import React from 'react';
import { X, Zap } from 'lucide-react';
import { PcmOptimizationProgress } from '../../storage/pcmOptimizer';

interface OptimizationProgressModalProps {
  isOpen: boolean;
  songTitle: string;
  progress: PcmOptimizationProgress | null;
  onCancel: () => void;
  /** Hides the dialog; the job keeps running in the background */
  onHide?: () => void;
}

export const OptimizationProgressModal: React.FC<OptimizationProgressModalProps> = ({
  isOpen,
  songTitle,
  progress,
  onCancel,
  onHide,
}) => {
  if (!isOpen) return null;

  const percent = progress?.percent ?? 0;
  const isComplete = progress?.phase === 'complete';
  const isCancelled = progress?.phase === 'cancelled';

  return (
    <div className="fixed inset-0 z-50 bg-neutral-950/80 flex items-center justify-center p-4">
      <div className="bg-studio-panel border border-neutral-700 rounded-2xl w-full max-w-md shadow-2xl p-6 space-y-5 animate-in fade-in zoom-in-95 duration-150">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="p-2 rounded-xl bg-studio-strip text-studio-ink">
              <Zap className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-base font-bold text-neutral-100">
                Optimizar para Streaming OPFS
              </h2>
              <p className="text-xs text-neutral-400 truncate max-w-xs">{songTitle}</p>
            </div>
          </div>
          {!isComplete && !isCancelled && (
            <button
              type="button"
              onClick={onHide ?? onCancel}
              title={onHide ? 'Ocultar (sigue en segundo plano)' : 'Cancelar'}
              className="text-neutral-400 hover:text-neutral-200 cursor-pointer"
            >
              <X className="w-4 h-4" />
            </button>
          )}
        </div>

        {/* Status description */}
        <div className="bg-studio-ground border border-neutral-800 rounded-xl p-3.5 space-y-2">
          <div className="flex items-center justify-between text-xs">
            <span className="text-neutral-300 font-semibold truncate max-w-[240px]">
              {progress?.phase === 'checking'
                ? 'Verificando almacenamiento...'
                : progress?.phase === 'converting'
                ? `Pista ${progress.currentTrackIndex}/${progress.totalTracks}: ${progress.trackName}`
                : progress?.phase === 'saving'
                ? 'Guardando configuración...'
                : progress?.phase === 'complete'
                ? '¡Listo! Audio optimizado en OPFS'
                : 'Cancelando...'}
            </span>
            <span className="text-studio-ink font-bold">{percent}%</span>
          </div>

          {/* Progress bar */}
          <div className="w-full h-2.5 bg-neutral-800 rounded-full overflow-hidden">
            <div
              className={`h-full transition-colors duration-200 rounded-full ${
                isComplete
                  ? 'bg-emerald-400'
                  : isCancelled
                  ? 'bg-red-400'
                  : 'bg-studio-accent'              }`}
              style={{ width: `${percent}%` }}
            />
          </div>
        </div>

        <p className="text-xs text-neutral-400 leading-relaxed">
          Guarda cada pista una sola vez en el disco del navegador (OPFS) para reproducirla en streaming sin ocupar RAM. Se procesan varias pistas en paralelo; puedes cerrar esta ventana y seguirá en segundo plano.</p>

        {/* Actions */}
        <div className="flex items-center justify-end gap-2 pt-1">
          {!isComplete && (
            <button
              type="button"
              onClick={onCancel}
              className="px-4 py-2 rounded-lg bg-neutral-800 hover:bg-neutral-700 text-xs font-semibold text-neutral-300 cursor-pointer transition-colors"
            >
              Cancelar
            </button>
          )}
        </div>
      </div>
    </div>
  );
};
