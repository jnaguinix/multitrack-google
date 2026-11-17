import React from 'react';
import { FolderOpen, Music, Upload } from 'lucide-react';

/** Capa que aparece al arrastrar una canción del repertorio o archivos de audio sobre el área de trabajo. */
export const DropOverlay: React.FC<{ mode: 'files' | 'repertoire-song' }> = ({ mode }) => (
  <div className="absolute inset-0 z-50 bg-studio-ground/90 border-2 border-dashed border-studio-line flex items-center justify-center p-8 pointer-events-none">
    <div className="bg-studio-panel border border-neutral-700 rounded-2xl p-8 text-center shadow-2xl max-w-md">
      {mode === 'repertoire-song' ? (
        <>
          <Music className="w-12 h-12 text-studio-ink mx-auto mb-3" />
          <h2 className="text-xl font-bold text-neutral-100">
            Suelta aquí para montar la canción en consola
          </h2>
          <p className="text-xs text-neutral-400 mt-1">
            Se cargará en el Setlist y en el DAW inmediatamente.
          </p>
        </>
      ) : (
        <>
          <Upload className="w-12 h-12 text-studio-ink mx-auto mb-3" />
          <h2 className="text-xl font-bold text-neutral-100">
            Suelta tus Stems o Carpeta Aquí
          </h2>
          <p className="text-xs text-neutral-400 mt-1">
            Se guardará como una sola canción en tu repertorio con su duración real en minutos y segundos.
          </p>
        </>
      )}
    </div>
  </div>
);

/** Arreglo sin canción abierta. */
export const ArrangerEmpty: React.FC<{ onGoToSetlist: () => void; onOpenImport: () => void }> = ({ onGoToSetlist, onOpenImport }) => (
  <div className="flex-1 flex flex-col items-center justify-center p-5 text-center">
    <FolderOpen className="w-12 h-12 text-studio-ink mb-3 opacity-80" />
    <h2 className="text-lg font-bold text-neutral-100">
      Arreglo
    </h2>
    <p className="text-xs text-neutral-400 max-w-md mt-1 mb-5">
      Abre una canción desde el Setlist o importa pistas para ver su forma de onda.
    </p>
    <div className="flex flex-wrap justify-center gap-2">
      <button type="button" onClick={onGoToSetlist} className="lt-control">
        Ir al Setlist
      </button>
      <button type="button" onClick={onOpenImport} className="lt-primary">
        Importar pistas
      </button>
    </div>
  </div>
);

/** Mezcla sin canción abierta. */
export const MixerEmpty: React.FC<{ onGoToSetlist: () => void }> = ({ onGoToSetlist }) => (
  <div className="flex-1 flex flex-col items-center justify-center p-5 text-center">
    <Music className="w-10 h-10 text-studio-ink mb-3 opacity-80" />
    <h2 className="text-base font-bold text-neutral-100">
      Mezcla
    </h2>
    <p className="text-xs text-neutral-400 max-w-md mt-1">
      Abre una canción desde el Setlist para mezclar sus pistas.
    </p>
    <button type="button" onClick={onGoToSetlist} className="lt-control mt-3">
      Ir al Setlist
    </button>
  </div>
);
