import React from 'react';
import { MultitrackMixer, type MultitrackMixerProps } from '../MultitrackMixer';
import type { SongProject, TransportState } from '../../types/project';
import { Dialog, DialogHeader } from '../ui/Dialog';

/** Acciones de la consola, iguales en Mezcla, en el Setlist y en la consola flotante del Arreglo. */
export type MixerHandlers = Omit<MultitrackMixerProps, 'project' | 'transport' | 'docked' | 'onEditTracks'>;

interface Props {
  project: SongProject;
  transport: TransportState;
  mixer: MixerHandlers;
  onClose: () => void;
}

/** Consola flotante del Arreglo (clic fuera o Escape para cerrar). */
export const DockedMixerDialog: React.FC<Props> = ({ project, transport, mixer, onClose }) => (
  <Dialog label="Consola mixer flotante" onClose={onClose} size="fill" placement="bottom" dismissOnBackdrop>
    <DialogHeader
      title={`Consola Mixer — ${project.title}`}
      description="Doble clic en fader = 0.0 dB · Doble clic en knob = Centrar (C) · Clic fuera o Escape para cerrar"
      actions={
        <button type="button" onClick={mixer.onResetMixer} className="lt-control">
          Restablecer 0 dB
        </button>
      }
      onClose={onClose}
    />
    <div className="overflow-y-auto">
      <MultitrackMixer project={project} transport={transport} docked={true} {...mixer} />
    </div>
  </Dialog>
);
