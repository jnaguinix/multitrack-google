import React, { useEffect } from 'react';
import { Bug } from 'lucide-react';
import { useDebugMode } from '../../hooks/useDebugMode';
import { diagnosticFileName, downloadTextFile, fullDiagnosticReport } from '../../utils/debugExport';

/**
 * Aviso fijo de que el modo diagnóstico está encendido (con el número de alarmas) y atajo Ctrl+Mayús+D para
 * encenderlo o apagarlo desde cualquier pantalla. Siempre montado: el atajo vive aquí.
 */
export const DebugBadge: React.FC = () => {
  const debug = useDebugMode();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.shiftKey && !e.altKey && e.code === 'KeyD') {
        e.preventDefault();
        debug.setEnabled(!debug.enabled);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [debug]);

  if (!debug.enabled) return null;
  const alarms = debug.alarms();
  return (
    <div className="fixed bottom-3 left-3 z-[60] flex items-center gap-2 rounded-full border border-amber-700 bg-neutral-950/95 px-3 py-1 text-xs text-amber-200 shadow-lg">
      <Bug size={13} aria-hidden="true" />
      <span>Diagnóstico</span>
      <span className={alarms > 0 ? 'font-bold text-rose-400' : 'text-emerald-400'}>
        {alarms} {alarms === 1 ? 'alarma' : 'alarmas'}
      </span>
      <button
        type="button"
        className="cursor-pointer rounded px-1.5 hover:bg-neutral-800"
        onClick={() => downloadTextFile(diagnosticFileName(), fullDiagnosticReport({ origen: 'aviso de diagnóstico' }))}
        title="Guardar el registro en un archivo"
      >
        Guardar
      </button>
      <button
        type="button"
        className="cursor-pointer rounded px-1.5 hover:bg-neutral-800"
        onClick={() => debug.setEnabled(false)}
        title="Apagar el modo diagnóstico (Ctrl+Mayús+D)"
      >
        Apagar
      </button>
    </div>
  );
};
