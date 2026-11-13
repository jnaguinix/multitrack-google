import React, { useMemo, useState } from 'react';
import {
  ChevronLeft,
  ChevronRight,
  ChevronsRight,
  Check,
  GripHorizontal,
  MoreHorizontal,
  Pause,
  Play,
  Plus,
  Square,
  Trash2,
  Zap,
  CircleMinus,
} from 'lucide-react';
import { SetlistTransitionMode, SongProject } from '../types/project';
import { getSongWaveformPeaks } from '../utils/songWaveform';
import { resolveTransition, TRANSITION_LABELS } from '../utils/setlistTransition';
import { formatMmSs } from './TransportDeck';

export interface SongTileStatus {
  text: string;
  tone: 'ready' | 'busy' | 'idle';
  title: string;
}

interface SetlistStripProps {
  songs: SongProject[];
  currentId: string | null;
  isPlaying: boolean;
  isMounting: boolean;
  mountingText?: string;
  globalMode: SetlistTransitionMode;
  isEditing: boolean;
  startOffsets: number[];
  statusOf: (song: SongProject) => SongTileStatus;
  canOptimize: (song: SongProject) => boolean;
  onSelect: (song: SongProject) => void;
  onPlay: (song: SongProject) => void;
  onMount: (song: SongProject) => void;
  onMove: (songId: string, direction: 'up' | 'down') => void;
  onRemove: (songId: string) => void;
  onOptimize: (song: SongProject) => void;
  onReorder: (fromIndex: number, toIndex: number) => void;
  onDropLibrarySong: (songId: string) => void;
  onAddSong: () => void;
  onSetTransition: (songId: string, mode: SetlistTransitionMode | undefined) => void;
}

const BARS = 22;

function songDuration(song: SongProject): number {
  return song.durationSec || ((song.totalBars || 24) * 4 * 60) / (song.bpm || 120);
}

/** Miniatura de la forma de onda de una ficha (solo cambia si cambian las pistas). */
const TileWave: React.FC<{ song: SongProject; active: boolean }> = ({ song, active }) => {
  const bars = useMemo(() => {
    const peaks = getSongWaveformPeaks(song, songDuration(song));
    if (peaks.length === 0) return Array.from({ length: BARS }, () => 0.12);
    return Array.from({ length: BARS }, (_, i) => {
      const a = Math.floor((i * peaks.length) / BARS);
      const b = Math.max(a + 1, Math.floor(((i + 1) * peaks.length) / BARS));
      let max = 0;
      for (let k = a; k < b; k++) max = Math.max(max, peaks[k]);
      return Math.max(0.08, Math.min(1, max));
    });
    // Las pistas (y su silencio o solo) cambian la forma; el resto no.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [song.id, song.tracks.length, song.durationSec]);
  return (
    <div className="lt-tile-wave" data-active={active || undefined} aria-hidden="true">
      {bars.map((h, i) => (
        <i key={i} style={{ height: `${Math.round(h * 100)}%` }} />
      ))}
    </div>
  );
};

function closePopover(event: React.MouseEvent<HTMLButtonElement>) {
  event.currentTarget.closest<HTMLElement>('[popover]')?.hidePopover();
}

const TRANSITION_OPTIONS: SetlistTransitionMode[] = ['stop', 'cue-next', 'auto-play'];

function TransitionIcon({ mode }: { mode: SetlistTransitionMode }) {
  if (mode === 'stop') return <Square size={11} fill="currentColor" />;
  if (mode === 'auto-play') return <ChevronsRight size={15} />;
  return <ChevronRight size={15} />;
}

/** Fila de fichas del setlist con la flecha de transición entre cada pareja de canciones. */
export const SetlistStrip: React.FC<SetlistStripProps> = ({
  songs,
  currentId,
  isPlaying,
  isMounting,
  mountingText,
  globalMode,
  isEditing,
  startOffsets,
  statusOf,
  canOptimize,
  onSelect,
  onPlay,
  onMount,
  onMove,
  onRemove,
  onOptimize,
  onReorder,
  onDropLibrarySong,
  onAddSong,
  onSetTransition,
}) => {
  const [dragOverIdx, setDragOverIdx] = useState<number | null>(null);

  return (
    <div className="lt-strip-row" role="group" aria-label="Canciones del setlist">
      {songs.map((song, idx) => {
        const isCurrent = currentId === song.id;
        const isPlayingThis = isCurrent && isPlaying;
        const status = statusOf(song);
        const mode = resolveTransition(song, globalMode);
        const hasOwnTransition = Boolean(song.transitionToNext);
        const durSec = songDuration(song);

        return (
          <React.Fragment key={song.id}>
            <div
              className="lt-tile"
              data-current={isCurrent || undefined}
              data-dragging={dragOverIdx === idx || undefined}
              draggable
              onDragStart={(e) => {
                e.dataTransfer.setData('application/x-omnitracks-setlist-index', String(idx));
                e.dataTransfer.setData('application/x-omnitracks-song-id', song.id);
              }}
              onDragOver={(e) => {
                e.preventDefault();
                setDragOverIdx(idx);
              }}
              onDragLeave={() => setDragOverIdx(null)}
              onDrop={(e) => {
                e.preventDefault();
                e.stopPropagation();
                setDragOverIdx(null);
                const from = e.dataTransfer.getData('application/x-omnitracks-setlist-index');
                const droppedId = e.dataTransfer.getData('application/x-omnitracks-song-id');
                if (from !== '') {
                  const fromIdx = Number(from);
                  if (!Number.isNaN(fromIdx) && fromIdx !== idx) onReorder(fromIdx, idx);
                } else if (droppedId) {
                  onDropLibrarySong(droppedId);
                }
              }}
              onClick={() => {
                if (!isCurrent) onSelect(song);
              }}
              title={`${song.title}${status.title ? ' · ' + status.title : ''}\nEmpieza en ${formatMmSs(startOffsets[idx] ?? 0)}`}
            >
              <div className="lt-tile-top">
                <span className="lt-tile-num">
                  <GripHorizontal className="w-3.5 h-3.5 cursor-grab" aria-hidden="true" />
                  {idx + 1}
                </span>
                <span className="lt-tile-dur">{formatMmSs(durSec)}</span>
              </div>

              <TileWave song={song} active={isCurrent} />

              <strong className="lt-tile-title">{song.title}</strong>

              <div className="lt-tile-meta">
                <span>
                  {song.keySignature}
                  {song.pitchSemitones !== 0 && (
                    <em title="Transpuesta respecto al original">
                      {song.pitchSemitones > 0 ? '+' : ''}
                      {song.pitchSemitones}
                    </em>
                  )}{' '}
                  · {song.bpm}
                </span>
                <span className="lt-tile-status" data-tone={status.tone} title={status.title}>
                  {status.text}
                </span>
              </div>

              <div className="lt-tile-actions">
                <button
                  type="button"
                  disabled={Boolean(isCurrent && isMounting)}
                  onClick={(e) => {
                    e.stopPropagation();
                    onPlay(song);
                  }}
                  className="lt-control lt-tile-btn"
                  aria-label={isPlayingThis ? 'Pausar canción' : 'Reproducir canción'}
                  title={
                    isCurrent && isMounting
                      ? mountingText || 'Cargando pistas...'
                      : isPlayingThis
                      ? 'Pausar canción'
                      : isCurrent
                      ? 'Reproducir desde la posición actual'
                      : 'Montar en consola y reproducir'
                  }
                >
                  {isPlayingThis ? <Pause className="w-3 h-3 fill-current" /> : <Play className="w-3 h-3 fill-current" />}
                </button>
                <button
                  type="button"
                  onClick={(e) => e.stopPropagation()}
                  popoverTarget={`tile-menu-${idx}`}
                  aria-label={`Acciones de ${song.title}`}
                  className="lt-control lt-tile-btn"
                >
                  <MoreHorizontal className="w-3.5 h-3.5" />
                </button>
              </div>

              {isEditing && (
                <button
                  type="button"
                  className="lt-tile-remove"
                  aria-label={`Quitar ${song.title} del setlist`}
                  title="Quitar del setlist"
                  onClick={(e) => {
                    e.stopPropagation();
                    onRemove(song.id);
                  }}
                >
                  <CircleMinus size={20} />
                </button>
              )}

              <div id={`tile-menu-${idx}`} popover="auto" onClick={(e) => e.stopPropagation()} className="lt-popover space-y-1">
                <button
                  type="button"
                  onClick={(e) => {
                    onMount(song);
                    closePopover(e);
                  }}
                  className="w-full px-2.5 py-1.5 text-left rounded-lg hover:bg-neutral-800 text-studio-ink font-semibold cursor-pointer"
                >
                  Montar en consola (00:00)
                </button>
                {canOptimize(song) && (
                  <button
                    type="button"
                    onClick={(e) => {
                      onOptimize(song);
                      closePopover(e);
                    }}
                    className="w-full px-2.5 py-1.5 text-left rounded-lg hover:bg-neutral-800 text-amber-300 flex items-center gap-1.5 cursor-pointer font-medium"
                  >
                    <Zap className="w-3.5 h-3.5 text-amber-400" /> Optimizar (OPFS)
                  </button>
                )}
                <button
                  type="button"
                  disabled={idx === 0}
                  onClick={(e) => {
                    onMove(song.id, 'up');
                    closePopover(e);
                  }}
                  className="w-full px-2.5 py-1.5 text-left rounded-lg hover:bg-neutral-800 text-neutral-200 flex items-center gap-1.5 disabled:opacity-30 cursor-pointer"
                >
                  <ChevronLeft className="w-3.5 h-3.5" /> Mover antes
                </button>
                <button
                  type="button"
                  disabled={idx === songs.length - 1}
                  onClick={(e) => {
                    onMove(song.id, 'down');
                    closePopover(e);
                  }}
                  className="w-full px-2.5 py-1.5 text-left rounded-lg hover:bg-neutral-800 text-neutral-200 flex items-center gap-1.5 disabled:opacity-30 cursor-pointer"
                >
                  <ChevronRight className="w-3.5 h-3.5" /> Mover después
                </button>
                <button
                  type="button"
                  onClick={(e) => {
                    onRemove(song.id);
                    closePopover(e);
                  }}
                  className="w-full px-2.5 py-1.5 text-left rounded-lg hover:bg-red-500/20 text-red-400 flex items-center gap-1.5 cursor-pointer"
                >
                  <Trash2 className="w-3.5 h-3.5" /> Quitar del setlist
                </button>
              </div>
            </div>

            {idx < songs.length - 1 && (
              <div className="lt-link">
                <button
                  type="button"
                  popoverTarget={`transition-${idx}`}
                  className="lt-link-btn"
                  data-own={hasOwnTransition || undefined}
                  aria-label={`Al terminar ${song.title}: ${TRANSITION_LABELS[mode]}`}
                  title={`Al terminar «${song.title}»: ${TRANSITION_LABELS[mode]}${hasOwnTransition ? '' : ' (ajuste general)'}`}
                >
                  <TransitionIcon mode={mode} />
                </button>
                <div id={`transition-${idx}`} popover="auto" className="lt-popover space-y-1">
                  <div className="px-2.5 py-1 text-xs text-studio-muted font-semibold">
                    Al terminar «{song.title}»
                  </div>
                  {TRANSITION_OPTIONS.map((opt) => (
                    <button
                      key={opt}
                      type="button"
                      onClick={(e) => {
                        onSetTransition(song.id, opt);
                        closePopover(e);
                      }}
                      className="w-full px-2.5 py-1.5 text-left rounded-lg hover:bg-neutral-800 text-neutral-100 flex items-center gap-2 cursor-pointer"
                    >
                      <span className="w-4">{song.transitionToNext === opt && <Check size={14} />}</span>
                      {TRANSITION_LABELS[opt]}
                    </button>
                  ))}
                  <button
                    type="button"
                    onClick={(e) => {
                      onSetTransition(song.id, undefined);
                      closePopover(e);
                    }}
                    className="w-full px-2.5 py-1.5 text-left rounded-lg hover:bg-neutral-800 text-neutral-300 flex items-center gap-2 cursor-pointer border-t border-studio-line"
                  >
                    <span className="w-4">{!hasOwnTransition && <Check size={14} />}</span>
                    Ajuste general ({TRANSITION_LABELS[globalMode]})
                  </button>
                </div>
              </div>
            )}
          </React.Fragment>
        );
      })}

      <button type="button" className="lt-tile lt-tile-add" onClick={onAddSong}>
        <Plus size={22} aria-hidden="true" />
        <span>Añadir canción</span>
      </button>
    </div>
  );
};
