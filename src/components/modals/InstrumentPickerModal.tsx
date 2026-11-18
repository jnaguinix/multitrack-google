import React from 'react';
import { FIXED_INSTRUMENTS, INSTRUMENTS, type InstrumentDef } from '../../utils/instrumentCatalog';
import { Dialog, DialogBody, DialogHeader } from '../ui/Dialog';

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
  const option = (ins: InstrumentDef) => {
    const current = ins.id === currentInstrumentId;
    return (
      <button
        key={ins.id}
        type="button"
        // El foco empieza en el instrumento actual, para cambiarlo con las flechas del teclado.
        data-autofocus={current || undefined}
        onClick={() => onPick(ins.id)}
        aria-pressed={current}
        className="lt-instrument"
      >
        <span aria-hidden="true" className="lt-instrument-dot" style={{ background: ins.color }} />
        <span className="lt-instrument-text">
          <span>{ins.label}</span>
          {ins.hint && <span>{ins.hint}</span>}
        </span>
      </button>
    );
  };

  return (
    <Dialog label="Cambiar instrumento" onClose={onClose} size="sm" dismissOnBackdrop>
      <DialogHeader title="Cambiar instrumento" description={`${trackName}${fileName ? ` · ${fileName}` : ''}`} onClose={onClose} />
      <DialogBody>
        <div className="lt-instruments">{INSTRUMENTS.map(option)}</div>
        <p className="lt-dialog-note-small">Fijos (salen por auriculares)</p>
        <div className="lt-instruments">{FIXED_INSTRUMENTS.map(option)}</div>
      </DialogBody>
    </Dialog>
  );
};
