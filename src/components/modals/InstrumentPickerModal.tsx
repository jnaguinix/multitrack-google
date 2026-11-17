import React, { useEffect, useRef } from 'react';
import { X } from 'lucide-react';
import { FIXED_INSTRUMENTS, INSTRUMENTS, type InstrumentDef } from '../../utils/instrumentCatalog';

interface Props {
  /** Nombre actual de la pista (el del catálogo). */
  trackName: string;
  /** Archivo original, para saber qué pista es si hubo una equivocación. */
  fileName?: string;
  /** Instrumento actual del catálogo; `null` si el nombre es anterior al catálogo. */
  currentInstrumentId: string | null;
  onPick: (instrumentId: string) => void;
  onClose: () => void;
}

/** Cambia el instrumento de UNA pista ya importada (por si te equivocaste al elegirlo en el asistente). */
export const InstrumentPickerModal: React.FC<Props> = ({ trackName, fileName, currentInstrumentId, onPick, onClose }) => {
  const currentRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    currentRef.current?.focus();
  }, []);

  const option = (ins: InstrumentDef) => {
    const current = ins.id === currentInstrumentId;
    return (
      <button
        key={ins.id}
        ref={current ? currentRef : undefined}
        type="button"
        onClick={() => onPick(ins.id)}
        aria-pressed={current}
        className={`flex items-center gap-2 px-2.5 py-1.5 rounded-lg border text-left text-sm cursor-pointer transition-colors ${
          current
            ? 'border-studio-accent bg-studio-accent/10 text-studio-accent'
            : 'border-neutral-800 bg-studio-ground text-neutral-200 hover:border-neutral-600'
        }`}
      >
        <span aria-hidden="true" className="w-2 h-2 rounded-full shrink-0" style={{ background: ins.color }} />
        <span className="truncate">{ins.label}</span>
      </button>
    );
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="instrument-picker-title"
      className="fixed inset-0 z-[80] bg-black/70 backdrop-blur-[2px] flex items-center justify-center p-4"
      onClick={onClose}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          onClose();
        }
      }}
    >
      <div
        className="bg-studio-panel border border-neutral-800 rounded-2xl w-full max-w-md max-h-[92dvh] overflow-y-auto p-4 shadow-2xl space-y-3"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <h2 id="instrument-picker-title" className="text-sm font-semibold text-neutral-100">
              Cambiar instrumento
            </h2>
            <p className="text-xs text-studio-muted truncate">
              {trackName}
              {fileName ? ` · ${fileName}` : ''}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Cerrar"
            className="p-1.5 rounded-lg text-neutral-400 hover:text-white hover:bg-neutral-800 cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="grid grid-cols-2 gap-1.5">{INSTRUMENTS.map(option)}</div>
        <div>
          <p className="text-xs text-studio-muted mb-1">Fijos (salen por auriculares)</p>
          <div className="grid grid-cols-2 gap-1.5">{FIXED_INSTRUMENTS.map(option)}</div>
        </div>
      </div>
    </div>
  );
};
