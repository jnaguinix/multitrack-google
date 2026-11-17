import React from 'react';
import { MultitrackMixer, type MultitrackMixerProps } from '../MultitrackMixer';
import type { SongProject, TransportState } from '../../types/project';

/** Acciones de la consola, iguales en Mezcla, en el Setlist y en la consola flotante del Arreglo. */
export type MixerHandlers = Omit<MultitrackMixerProps, 'project' | 'transport' | 'docked' | 'onEditTracks'>;

interface Props {
  project: SongProject;
  transport: TransportState;
  mixer: MixerHandlers;
  onClose: () => void;
}

/** Consola flotante del Arreglo (clic fuera para cerrar). */
export const DockedMixerDialog: React.FC<Props> = ({ project, transport, mixer, onClose }) => (
  <div onClick={onClose} className="fixed inset-0 z-50 bg-black/60 flex items-end justify-center p-3 sm:p-5">
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Consola Mixer Flotante"
      onClick={(e) => e.stopPropagation()}
      className="w-full max-w-[1440px] bg-studio-panel border-2 border-studio-line rounded-2xl shadow-[0_24px_70px_rgba(0,0,0,0.9)] overflow-hidden flex flex-col max-h-[86vh]"
    >
      <div className="px-5 py-3 bg-studio-panel border-b border-studio-line flex items-center justify-between gap-4 shrink-0">
        <div>
          <h2 className="text-base font-bold text-white">
            Consola Mixer — {project.title}
          </h2>
          <p className="text-xs text-neutral-400">
            Doble clic en fader = 0.0 dB · Doble clic en knob = Centrar (C) · Clic fuera para cerrar
          </p>
        </div>
        <div className="flex items-center gap-2.5">
          <button
            type="button"
            onClick={mixer.onResetMixer}
            className="h-9 px-3.5 rounded-lg bg-studio-strip hover:bg-neutral-800 border border-studio-line text-xs font-semibold text-neutral-200 cursor-pointer"
          >
            Restablecer 0 dB
          </button>
          <button type="button" onClick={onClose} className="lt-control">
            Cerrar mezcla
          </button>
        </div>
      </div>
      <div className="overflow-y-auto">
        <MultitrackMixer project={project} transport={transport} docked={true} {...mixer} />
      </div>
    </div>
  </div>
);
