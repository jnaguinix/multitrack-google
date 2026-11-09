import React from 'react';
import {
  Play,
  Pause,
  Square,
  Repeat,
  Sliders,
  Flag,
  SkipBack,
  SkipForward,
  X,
} from 'lucide-react';
import {
  QuantizeMode,
  SetlistTransitionMode,
  SongProject,
  TransportState,
} from '../types/project';

interface TransportDeckProps {
  project: SongProject;
  transport: TransportState;
  setlistQueue: SongProject[];
  setlistTransitionMode: SetlistTransitionMode;
  importStatusText: string | null;
  onPlayPause: () => void;
  onStop: () => void;
  onToggleVamp: () => void;
  onPrevSetlistSong: () => void;
  onNextSetlistSong: () => void;
  onChangeSetlistTransitionMode: (mode: SetlistTransitionMode) => void;
  onChangeBpm: (bpm: number) => void;
  onChangePitch: (semitones: number) => void;
  onChangeQuantize: (mode: QuantizeMode) => void;
  onToggleClick: () => void;
  onToggleGuide: () => void;
  onToggleSplitRouting: () => void;
  onAddMarkerAtPlayhead: () => void;
  onOpenSectionEditor: () => void;
  onCancelQueuedJump?: () => void;
}

export function formatTimecode(sec: number): string {
  const safe = Math.max(0, sec || 0);
  const mins = Math.floor(safe / 60);
  const remSec = Math.floor(safe % 60);
  const tenths = Math.floor((safe % 1) * 10);
  return `${String(mins).padStart(2, '0')}:${String(remSec).padStart(2, '0')}.${tenths}`;
}

export function formatMmSs(sec: number): string {
  const safe = Math.max(0, sec || 0);
  const mins = Math.floor(safe / 60);
  const remSec = Math.floor(safe % 60);
  return `${String(mins).padStart(2, '0')}:${String(remSec).padStart(2, '0')}`;
}

export const TransportDeck: React.FC<TransportDeckProps> = ({
  project,
  transport,
  setlistQueue,
  setlistTransitionMode,
  importStatusText,
  onPlayPause,
  onStop,
  onToggleVamp,
  onPrevSetlistSong,
  onNextSetlistSong,
  onChangeSetlistTransitionMode,
  onChangeBpm,
  onChangePitch,
  onChangeQuantize,
  onToggleClick,
  onToggleGuide,
  onToggleSplitRouting,
  onAddMarkerAtPlayhead,
  onOpenSectionEditor,
  onCancelQueuedJump,
}) => {
  const activeSection = project.sections.find((s) => s.id === transport.activeSectionId);
  const queuedSection = project.sections.find((s) => s.id === transport.queuedSectionId);

  const currentSetlistIdx = setlistQueue.findIndex((song) => song.id === project.id);
  const split = project.splitRoutingMode === 'split-mono';
  const notice = transport.mountingProgressText || importStatusText;
  const playLabel = transport.isMountingSong ? 'Cargando…' : transport.isPlaying ? 'Pausar' : 'Reproducir';

  return (
    <section aria-label="Transporte" className="lt-transport">
      <div className="lt-transport-song min-w-0">
        <p className="truncate text-base font-semibold" title={project.title}>{project.title}</p>
        <p className="truncate text-xs text-neutral-400" title={notice || undefined}>
          {notice ||`${project.keySignature} · ${project.bpm} BPM · ${activeSection?.name || 'Sin sección activa'}`}
        </p>
      </div>

      <div className="flex items-center gap-1.5">
        {setlistQueue.length > 0 && (
          <button type="button" onClick={onPrevSetlistSong} disabled={currentSetlistIdx <= 0} className="lt-control lt-icon-control" aria-label="Canción anterior" title="Canción anterior">
            <SkipBack size={15} />
          </button>
        )}
        <button type="button" onClick={onPlayPause} disabled={Boolean(transport.isMountingSong)} className="lt-primary" aria-keyshortcuts="Space" aria-label={playLabel} title={playLabel}>
          {transport.isPlaying ? <Pause size={16} fill="currentColor" /> : <Play size={16} fill="currentColor" />}
          <span className="hidden sm:inline">{playLabel}</span>
        </button>
        <button type="button" onClick={onStop} className="lt-control lt-icon-control" aria-label="Detener" title="Detener y volver al inicio">
          <Square size={12} fill="currentColor" />
        </button>
        {setlistQueue.length > 0 && (
          <button type="button" onClick={onNextSetlistSong} disabled={currentSetlistIdx >= setlistQueue.length - 1} className="lt-control lt-icon-control" aria-label="Siguiente canción" title="Siguiente canción">
            <SkipForward size={15} />
          </button>
        )}
        <button type="button" onClick={onToggleVamp} aria-pressed={transport.isVamping} className="lt-control lt-icon-control" aria-label="Repetir sección" title="Repetir sección (V)" aria-keyshortcuts="V">
          <Repeat size={16} />
        </button>
      </div>

      <div className="lt-transport-readout flex items-center gap-2.5">
        <div className="flex items-baseline gap-1.5 whitespace-nowrap">
          <span className="lt-transport-clock">{formatTimecode(transport.currentTimeSec)}</span>
          <span className="text-xs text-neutral-400">/ {formatMmSs(transport.totalDurationSec)}</span>
        </div>
        <div className="flex items-center gap-0.5 max-sm:hidden" aria-label={`Pulso ${transport.currentBeat} de ${project.beatsPerBar}`}>
          {Array.from({ length: project.beatsPerBar }, (_, index) => (
            <span key={index} className="lt-beat" data-active={transport.isPlaying && transport.currentBeat === index + 1 || undefined} data-downbeat={index === 0 || undefined} />
          ))}
        </div>
        {queuedSection && (
          <div className="flex items-center gap-1 min-w-0 text-xs text-amber-300" title={`Salto en cola a ${queuedSection.name}`}>
            <span className="truncate">→ {queuedSection.code}</span>
            {onCancelQueuedJump && (
              <button type="button" onClick={onCancelQueuedJump} className="p-1 cursor-pointer" aria-label="Cancelar salto en cola">
                <X size={14} />
              </button>
            )}
          </div>
        )}
      </div>

      <div className="lt-transport-tools flex items-center gap-1.5">
        <button type="button" onClick={onAddMarkerAtPlayhead} className="lt-control lt-icon-control" aria-label="Marcar sección aquí" title="Marcar sección aquí">
          <Flag size={16} />
        </button>
        <button type="button" onClick={onOpenSectionEditor} className="lt-control">Secciones</button>
        <button type="button" popoverTarget="playback-settings" className="lt-control lt-icon-control" aria-label="Ajustes de reproducción" title="Ajustes de reproducción">
          <Sliders size={16} />
        </button>
        <section id="playback-settings" popover="auto" className="lt-popover space-y-3" aria-label="Ajustes de reproducción">
          <h2 className="text-sm font-semibold">Ajustes de reproducción</h2>
          {setlistQueue.length > 0 && (
            <label className="lt-field">
              Al terminar la canción
              <select value={setlistTransitionMode} onChange={(event) => onChangeSetlistTransitionMode(event.target.value as SetlistTransitionMode)}>
                <option value="stop">Detener</option>
                <option value="cue-next">Preparar la siguiente</option>
                <option value="auto-play">Reproducir la siguiente</option>
              </select>
            </label>
          )}
          <label className="lt-field">
            Salto de sección
            <select value={project.quantizeMode} onChange={(event) => onChangeQuantize(event.target.value as QuantizeMode)}>
              <option value="immediate">Inmediato</option>
              <option value="1-bar">Al siguiente compás</option>
              <option value="2-bars">Cada dos compases</option>
              <option value="section-end">Al final de la sección</option>
            </select>
          </label>
          <div className="grid grid-cols-2 gap-2">
            <label className="lt-field">
              BPM
              <input type="number" min={50} max={220} value={project.bpm} onChange={(event) => {
                const bpm = Number(event.target.value);
                if (bpm >= 50 && bpm <= 220) onChangeBpm(bpm);
              }} />
            </label>
            <label className="lt-field">
              Tono
              <select value={project.pitchSemitones} onChange={(event) => onChangePitch(Number(event.target.value))}>
                {Array.from({ length: 13 }, (_, index) => index - 6).map((st) => (
                  <option key={st} value={st}>{st > 0 ? '+' : ''}{st} st</option>
                ))}
              </select>
            </label>
          </div>
          <div className="flex flex-wrap gap-1.5">
            <button type="button" onClick={onToggleClick} aria-pressed={project.clickEnabled} className="lt-control">Click</button>
            <button type="button" onClick={onToggleGuide} aria-pressed={project.guideCuesEnabled} className="lt-control">Guía</button>
            <button type="button" onClick={onToggleSplitRouting} aria-pressed={split} className="lt-control" title="Alternar entre estéreo y Split-Mono (L: guía y click · R: pistas)">{split ? 'Split-mono' : 'Estéreo'}</button>
          </div>
        </section>
      </div>
    </section>
  );
};
