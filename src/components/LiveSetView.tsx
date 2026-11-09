/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { Pause, Play, Repeat, SkipBack, SkipForward, Square, X } from 'lucide-react';
import {
  QuantizeMode,
  SetlistTransitionMode,
  SongProject,
  SongSection,
  TransportState,
} from '../types/project';
import { audioEngine } from '../audio/audioEngine';

/**
 * LIVE SET — the performance page.
 * Everything is prepared beforehand (Setlist / DAW / Mixer); here we only play, pause,
 * pick what comes next and jump between sections. No mixer, no editing.
 */

interface LiveSetViewProps {
  project: SongProject | null;
  transport: TransportState;
  setlistQueue: SongProject[];
  setlistTransitionMode: SetlistTransitionMode;
  preparingIds: Set<string>;
  onPlayPause: () => void;
  onStop: () => void;
  onPrevSong: () => void;
  onNextSong: () => void;
  onLoadSong: (songId: string) => void;
  onSetAsNext: (songId: string) => void;
  onJumpSection: (sectionId: string) => void;
  onCancelQueuedJump: () => void;
  onToggleVamp: () => void;
  onChangeQuantize: (mode: QuantizeMode) => void;
  onChangeTransitionMode: (mode: SetlistTransitionMode) => void;
  onGoToSetlist: () => void;
}

const QUANTIZE_OPTIONS: { value: QuantizeMode; label: string; hint: string }[] = [
  { value: 'immediate', label: 'Inmediato', hint: 'Salta en cuanto lo pides' },
  { value: '1-bar', label: 'Al compás', hint: 'Salta al inicio del siguiente compás' },
  { value: 'section-end', label: 'Al final de la sección', hint: 'Termina la sección actual y luego salta' },
];

const TRANSITION_OPTIONS: { value: SetlistTransitionMode; label: string }[] = [
  { value: 'stop', label: 'Parar' },
  { value: 'cue-next', label: 'Dejar lista la siguiente' },
  { value: 'auto-play', label: 'Seguir con la siguiente' },
];

function mmss(totalSec: number): string {
  const s = Math.max(0, Math.floor(totalSec || 0));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

function clockParts(totalSec: number): { main: string; tenths: string } {
  const safe = Math.max(0, totalSec || 0);
  return { main: mmss(safe), tenths: String(Math.floor((safe * 10) % 10)) };
}

type SongStatus = 'ready' | 'preparing' | 'pending';

function songStatus(song: SongProject, preparingIds: Set<string>): SongStatus {
  if (preparingIds.has(song.id)) return 'preparing';
  if (audioEngine.isProjectPcmReady(song)) return 'ready';
  if (audioEngine.getSongRamCacheInfo(song).isReady) return 'ready';
  return 'pending';
}

const STATUS_LABEL: Record<SongStatus, string> = {
  ready: 'Lista',
  preparing: 'Preparando',
  pending: 'Sin preparar',
};

export const LiveSetView: React.FC<LiveSetViewProps> = ({
  project,
  transport,
  setlistQueue,
  setlistTransitionMode,
  preparingIds,
  onPlayPause,
  onStop,
  onPrevSong,
  onNextSong,
  onLoadSong,
  onSetAsNext,
  onJumpSection,
  onCancelQueuedJump,
  onToggleVamp,
  onChangeQuantize,
  onChangeTransitionMode,
  onGoToSetlist,
}) => {
  const currentIdx = project ? setlistQueue.findIndex((s) => s.id === project.id) : -1;
  const nextSong =
    currentIdx >= 0 ? setlistQueue[currentIdx + 1] ?? null : setlistQueue[0] ?? null;
  const prevSong = currentIdx > 0 ? setlistQueue[currentIdx - 1] : null;

  if (setlistQueue.length === 0 && !project) {
    return (
      <div className="lt-live flex-1 flex flex-col items-center justify-center p-8 text-center">
        <h2 className="text-xl font-semibold text-[var(--lt-text)]">
          Tu setlist está vacío
        </h2>
        <p className="text-sm text-[var(--lt-mut)] mt-2 max-w-sm">
          Prepara las canciones del show en la página Setlist y vuelve aquí para tocarlas.
        </p>
        <button type="button" onClick={onGoToSetlist} className="lt-live-btn mt-5">
          Ir al Setlist
        </button>
      </div>
    );
  }

  const sections: SongSection[] = project ? [...project.sections].sort((a, b) => a.startTimeSec - b.startTimeSec) : [];
  const total = Math.max(1, transport.totalDurationSec || project?.durationSec || 1);
  const now = Math.min(total, Math.max(0, transport.currentTimeSec));
  const remaining = total - now;
  const playheadPct = (now / total) * 100;
  const clock = clockParts(now);
  const queuedSection = sections.find((s) => s.id === transport.queuedSectionId) || null;
  const activeSection = sections.find((s) => s.id === transport.activeSectionId) || null;
  const isPaused = !transport.isPlaying && now > 0.05;
  const playLabel = transport.isMountingSong
    ? 'Cargando…'
    : transport.isPlaying
    ? 'Pausar'
    : isPaused
    ? 'Continuar'
    : 'Reproducir';

  const handleSongClick = (song: SongProject) => {
    if (song.id === project?.id) return;
    if (transport.isPlaying) onSetAsNext(song.id);
    else onLoadSong(song.id);
  };

  return (
    <div className="lt-live flex-1 flex min-h-0 overflow-hidden">
      {/* ===================== PERFORMANCE AREA ===================== */}
      <section aria-label="Canción en curso" className="flex-1 min-w-0 flex flex-col">
        {/* Now playing + clock */}
        <header className="px-5 xl:px-7 pt-4 xl:pt-5 pb-3 flex items-end justify-between gap-6">
          <div className="min-w-0">
            <h1 className="lt-live-title truncate" title={project?.title}>
              {project ? project.title : 'Elige una canción del setlist'}
            </h1>
            {project && (
              <p className="text-sm text-[var(--lt-mut)] mt-1">
                {project.keySignature}, {project.bpm} BPM
                {activeSection ? (
                  <>
                    {', ahora en '}
                    <span className="text-[var(--lt-text)]">{activeSection.name}</span>
                  </>
                ) : null}
              </p>
            )}
          </div>

          {project && (
            <div className="text-right shrink-0" aria-live="off">
              <div className="lt-live-clock">
                {clock.main}
                <span className="lt-live-clock-tenths">.{clock.tenths}</span>
              </div>
              <div className="text-sm text-[var(--lt-mut)] tabular-nums">
                quedan {mmss(remaining)} de {mmss(total)}
              </div>
            </div>
          )}
        </header>

        {/* Song map: the signature element */}
        {project && (
          <div className="px-5 xl:px-7">
            <div
              className="lt-live-map"
              role="group"
              aria-label="Mapa de la canción. Haz clic en una sección para saltar a ella."
            >
              {sections.length > 0 ? (
                sections.map((sec) => {
                  const left = (sec.startTimeSec / total) * 100;
                  const width = Math.max(0.6, ((sec.endTimeSec - sec.startTimeSec) / total) * 100);
                  const isActive = sec.id === transport.activeSectionId;
                  const isQueued = sec.id === transport.queuedSectionId;
                  return (
                    <button
                      key={sec.id}
                      type="button"
                      onClick={() => onJumpSection(sec.id)}
                      title={`${sec.name} (${mmss(sec.startTimeSec)}): saltar aquí`}
                      className="lt-live-block"
                      data-active={isActive || undefined}
                      data-queued={isQueued || undefined}
                      style={
                        {
                          left: `${left}%`,
                          width: `${width}%`,
                          '--sec': sec.color || '#2fd0c8',
                        } as React.CSSProperties
                      }
                    >
                      <span className="lt-live-block-name">{sec.name}</span>
                    </button>
                  );
                })
              ) : (
                <div className="absolute inset-0 flex items-center px-4 text-sm text-[var(--lt-mut)]">
                  Esta canción no tiene secciones. Márcalas en el DAW para poder saltar entre ellas.
                </div>
              )}
              <div className="lt-live-playhead" style={{ left: `${playheadPct}%` }} aria-hidden="true" />
            </div>
          </div>
        )}

        {/* Jump controls: when to jump + pending jump */}
        {project && sections.length > 0 && (
          <div className="px-5 xl:px-7 pt-3 flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <span className="text-sm text-[var(--lt-mut)]">Saltar</span>
              <div className="lt-live-seg" role="radiogroup" aria-label="Cuándo saltar de sección">
                {QUANTIZE_OPTIONS.map((opt) => (
                  <button
                    key={opt.value}
                    type="button"
                    role="radio"
                    aria-checked={project?.quantizeMode === opt.value}
                    title={opt.hint}
                    onClick={() => onChangeQuantize(opt.value)}
                    disabled={!project}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>
            {queuedSection && (
              <span className="lt-live-queued">
                Saltando a {queuedSection.name}
                <button
                  type="button"
                  onClick={onCancelQueuedJump}
                  className="lt-live-queued-x"
                  aria-label="Cancelar el salto"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </span>
            )}
          </div>
        )}

        {/* Section pads */}
        <div className="flex-1 min-h-0 overflow-y-auto px-5 xl:px-7 py-3">
          {project && sections.length > 0 && (
            <div className="lt-live-pads">
              {sections.map((sec, idx) => {
                const isActive = sec.id === transport.activeSectionId;
                const isQueued = sec.id === transport.queuedSectionId;
                return (
                  <button
                    key={sec.id}
                    type="button"
                    onClick={() => onJumpSection(sec.id)}
                    className="lt-live-pad"
                    data-active={isActive || undefined}
                    data-queued={isQueued || undefined}
                    style={{ '--sec': sec.color || '#2fd0c8' } as React.CSSProperties}
                    aria-pressed={isActive}
                    aria-keyshortcuts={idx < 9 ? String(idx + 1) : undefined}
                  >
                    <span className="lt-live-pad-name">{sec.name}</span>
                    <span className="lt-live-pad-meta">
                      {mmss(sec.startTimeSec)}
                      {idx < 9 && <kbd className="lt-live-kbd">{idx + 1}</kbd>}
                    </span>
                    {isQueued && <span className="lt-live-pad-flag">En cola</span>}
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {/* Transport bar */}
        <footer className="lt-live-transport">
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onPrevSong}
              disabled={!prevSong}
              className="lt-live-btn"
              title={prevSong ? `Cargar "${prevSong.title}"` : 'No hay canción anterior'}
            >
              <SkipBack className="w-4 h-4" />
              <span className="hidden lg:inline">Anterior</span>
            </button>

            <button
              type="button"
              onClick={onPlayPause}
              disabled={!project}
              className="lt-live-play"
              data-playing={transport.isPlaying || undefined}
              data-loading={transport.isMountingSong || undefined}
              aria-keyshortcuts="Space"
            >
              {transport.isPlaying ? (
                <Pause className="w-6 h-6 fill-current" />
              ) : (
                <Play className="w-6 h-6 fill-current" />
              )}
              <span>{playLabel}</span>
            </button>

            <button type="button" onClick={onStop} disabled={!project} className="lt-live-btn" title="Parar y volver al inicio">
              <Square className="w-4 h-4 fill-current" />
              <span className="hidden lg:inline">Parar</span>
            </button>

            <button
              type="button"
              onClick={onToggleVamp}
              disabled={!project}
              className="lt-live-btn"
              data-on={transport.isVamping || undefined}
              aria-pressed={transport.isVamping}
              aria-keyshortcuts="V"
              title="Repetir la sección actual hasta que la sueltes"
            >
              <Repeat className="w-4 h-4" />
              <span>{transport.isVamping ? 'Repitiendo' : 'Repetir sección'}</span>
            </button>
          </div>

          <div className="flex items-center gap-3 min-w-0">
            <button
              type="button"
              onClick={onNextSong}
              disabled={!nextSong}
              className="lt-live-btn lt-live-next"
              title={nextSong ? `Cargar "${nextSong.title}"` : 'Es la última canción del setlist'}
            >
              <span className="truncate max-w-[160px] xl:max-w-[220px]">
                {nextSong ? nextSong.title : 'Fin del setlist'}
              </span>
              <SkipForward className="w-4 h-4 shrink-0" />
            </button>
          </div>
        </footer>
      </section>

      {/* ===================== SETLIST RAIL ===================== */}
      <aside aria-label="Setlist del show" className="lt-live-rail">
        <div className="px-4 pt-4 pb-2 flex items-baseline justify-between">
          <h2 className="text-base font-semibold text-[var(--lt-text)]">Setlist</h2>
          <span className="text-xs text-[var(--lt-mut)] tabular-nums">
            {currentIdx >= 0 ? `${currentIdx + 1} de ${setlistQueue.length}` : `${setlistQueue.length} canciones`}
          </span>
        </div>

        <ol className="flex-1 min-h-0 overflow-y-auto px-2 pb-2 space-y-1">
          {setlistQueue.map((song, idx) => {
            const isCurrent = song.id === project?.id;
            const isNext = nextSong?.id === song.id;
            const status = songStatus(song, preparingIds);
            const dur = song.durationSec || 0;
            return (
              <li key={song.id}>
                <button
                  type="button"
                  onClick={() => handleSongClick(song)}
                  className="lt-live-song"
                  data-current={isCurrent || undefined}
                  data-next={isNext || undefined}
                  aria-current={isCurrent ? 'true' : undefined}
                  title={
                    isCurrent
                      ? 'Canción cargada'
                      : transport.isPlaying
                      ? 'Poner como la siguiente canción'
                      : 'Cargar esta canción'
                  }
                >
                  <span className="lt-live-song-idx tabular-nums">{idx + 1}</span>
                  <span className="min-w-0 flex-1 text-left">
                    <span className="block truncate lt-live-song-title">{song.title}</span>
                    <span className="block text-xs text-[var(--lt-mut)] tabular-nums">
                      {isCurrent ? (transport.isPlaying ? 'Sonando' : 'Cargada') : isNext ? 'Siguiente' :`${song.bpm} BPM`}
                      {dur > 0 ? `, ${mmss(dur)}` : ''}
                    </span>
                  </span>
                  <span className="lt-live-status" data-status={status} title={STATUS_LABEL[status]}>
                    <span className="sr-only">{STATUS_LABEL[status]}</span>
                  </span>
                </button>
              </li>
            );
          })}
        </ol>

        <div className="px-4 py-3 border-t border-[var(--lt-line)]">
          <label htmlFor="live-transition" className="block text-xs text-[var(--lt-mut)] mb-1.5">
            Cuando termine la canción
          </label>
          <select
            id="live-transition"
            value={setlistTransitionMode}
            onChange={(e) => onChangeTransitionMode(e.target.value as SetlistTransitionMode)}
            className="lt-live-select"
          >
            {TRANSITION_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
          <p className="text-xs text-[var(--lt-mut)] mt-2 leading-relaxed">
            Mientras suena una canción, haz clic en otra para ponerla como siguiente.
          </p>
        </div>
      </aside>
    </div>
  );
};
