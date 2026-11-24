/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useMemo, useRef } from 'react';
import { Pause, Play, Repeat, SkipBack, SkipForward, Square, X } from 'lucide-react';
import {
  QuantizeMode,
  SetlistTransitionMode,
  SongProject,
  SongSection,
  TransportState,
} from '../types/project';
import { audioEngine } from '../audio/audioEngine';
import { nativeAudioEngine } from '../audio/nativeAudioEngine';
import { isDesktopApp } from '../utils/nativeDialog';
import { drawSectionWaveBars, getSongWaveformPeaks } from '../utils/songWaveform';
import { isPadOnlySong, noteIndexToLabel, parseKeyToNoteIndex, subdivisionBadge } from '../utils/padSong';
import { PadStagePanel } from './PadStagePanel';

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
  /** Los saltos de sección están bloqueados por defecto para evitar un clic accidental en directo. */
  jumpsEnabled: boolean;
  onToggleJumps: (enabled: boolean) => void;
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

function songStatus(song: SongProject): SongStatus {
  if (isPadOnlySong(song)) return 'ready';
  // Escritorio: el estado sale de la caché PCM nativa, no del motor web (OPFS).
  if (isDesktopApp()) {
    if (nativeAudioEngine.isProjectImporting(song.id)) return 'preparing';
    return nativeAudioEngine.isNativeCacheReady(song.id) === true ? 'ready' : 'pending';
  }
  if (audioEngine.isProjectPcmReady(song)) return 'ready';
  if (audioEngine.getSongRamCacheInfo(song).isReady) return 'ready';
  return 'pending';
}

const STATUS_LABEL: Record<SongStatus, string> = {
  ready: 'Lista',
  preparing: 'Preparando',
  pending: 'Sin preparar',
};

/**
 * Onda del mapa de la canción, dibujada con la misma función que el mapa del Setlist: cada barra con el color de su
 * sección. Va debajo de los bloques de sección (que la tiñen con su color y llevan el nombre y los tiempos).
 */
const LiveWaveform = React.memo(function LiveWaveform({ project, duration }: { project: SongProject; duration: number }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const peaks = useMemo(() => getSongWaveformPeaks(project, duration), [project, duration]);
  const sections = useMemo(() => [...project.sections].sort((a, b) => a.startTimeSec - b.startTimeSec), [project.sections]);
  const hasPeaks = peaks.some((peak) => peak > 0);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    const draw = () => {
      const { clientWidth: width, clientHeight: height } = canvas;
      if (!width || !height) return;
      const dpr = window.devicePixelRatio || 1;
      if (canvas.width !== Math.round(width * dpr)) canvas.width = Math.round(width * dpr);
      if (canvas.height !== Math.round(height * dpr)) canvas.height = Math.round(height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, width, height);
      // Arriba van el nombre de la sección y abajo su duración: la onda ocupa la franja del medio.
      const top = Math.min(56, Math.max(30, height * 0.2));
      const bottom = height - Math.min(44, Math.max(24, height * 0.15));
      drawSectionWaveBars(ctx, { width, height, peaks, sections, totalDurationSec: duration, top, bottom });
    };
    draw();
    const observer = new ResizeObserver(draw);
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [peaks, sections, duration, hasPeaks]);

  return hasPeaks ? <canvas ref={canvasRef} className="lt-live-waveform" aria-hidden="true" /> : null;
});

export const LiveSetView: React.FC<LiveSetViewProps> = ({
  project,
  transport,
  setlistQueue,
  setlistTransitionMode,
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
  jumpsEnabled,
  onToggleJumps,
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

  const padOnly = isPadOnlySong(project);
  const sections: SongSection[] = project && !padOnly ? [...project.sections].sort((a, b) => a.startTimeSec - b.startTimeSec) : [];
  const total = Math.max(1, transport.totalDurationSec || project?.durationSec || 1);
  const now = Math.min(total, Math.max(0, transport.currentTimeSec));
  const remaining = total - now;
  // El tiempo restante nunca puede superar el total que se muestra (el total se trunca a segundos y lo restante se redondea hacia arriba).
  const remainingShown = Math.min(Math.ceil(remaining), Math.floor(total));
  const hasRealArtist = Boolean(project?.artist) && !/^artista\s+desconocid[oa]$/i.test(project!.artist.trim());
  const playheadPct = (now / total) * 100;
  const clock = clockParts(now);
  const queuedSection = sections.find((s) => s.id === transport.queuedSectionId) || null;
  const activeIndex = sections.findIndex((section) => section.id === transport.activeSectionId);
  const activeSection = sections[activeIndex];
  const nextSection = activeSection ? sections[activeIndex + 1] : sections.find((section) => section.startTimeSec > now);
  const hasShortSections = sections.some((section) => section.endTimeSec - section.startTimeSec < total * 0.08);
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
      <section aria-label="Canción en curso" className="lt-live-performance">
        <div className="lt-live-stage">
          <header className="lt-live-header">
            <div className="min-w-0">
              <h1 className="lt-live-title" title={project?.title}>
                {project ? project.title : 'Elige una canción del setlist'}
              </h1>
              {project && (
                <p className="lt-live-song-details">
                  {hasRealArtist && <span>{project.artist}</span>}
                  <strong>{padOnly ? noteIndexToLabel(parseKeyToNoteIndex(project.keySignature)) : project.keySignature}</strong>
                  <span>
                    {project.bpm} BPM
                    {padOnly ? ` · ${subdivisionBadge(project.clickSubdivision)}` : ''}
                  </span>
                  <span>
                    {padOnly
                      ? 'Modo continuo · Pad + Click'
                      : `${sections.length} ${sections.length === 1 ? 'sección' : 'secciones'}`}
                  </span>
                </p>
              )}
            </div>

            {project && (
              <div className="lt-live-clock-group" aria-live="off">
                <div className="lt-live-clock">
                  {clock.main}<span className="lt-live-clock-tenths">.{clock.tenths}</span>
                </div>
                <p className="lt-live-secondary">
                  {padOnly ? 'Modo continuo · Sin fin automático' : `Quedan ${mmss(remainingShown)} de ${mmss(total)}`}
                </p>
              </div>
            )}
          </header>

          {project && padOnly && (
            <PadStagePanel mode="live" project={project} transport={transport} />
          )}

          {project && !padOnly && (
            <>
              <div className="lt-live-map" role="group" aria-label="Mapa de la canción. Selecciona una sección para saltar.">
                <LiveWaveform project={project} duration={total} />
                {sections.length > 0 ? sections.map((section) => {
                  const start = Math.max(0, Math.min(total, section.startTimeSec));
                  const end = Math.max(start, Math.min(total, section.endTimeSec));
                  if (end === start) return null;
                  const isActive = section.id === transport.activeSectionId;
                  const isQueued = section.id === transport.queuedSectionId;
                  const shortcut = project.sections.indexOf(section) + 1;
                  const duration = mmss(end - start);
                  return (
                    <button
                      key={section.id}
                      type="button"
                      className="lt-live-block"
                      data-active={isActive || undefined}
                      data-queued={isQueued || undefined}
                      aria-pressed={isActive}
                      disabled={!jumpsEnabled}
                      aria-keyshortcuts={jumpsEnabled && shortcut <= 9 ? String(shortcut) : undefined}
                      aria-label={section.name + ', ' + duration + (isQueued ? ', en cola' : '')}
                      title={section.name + ' · ' + mmss(start) + '–' + mmss(end)}
                      onClick={() => onJumpSection(section.id)}
                      style={{
                        left: (start / total) * 100 + '%',
                        width: ((end - start) / total) * 100 + '%',
                        '--sec': section.color || 'var(--lt-accent)',
                      } as React.CSSProperties}
                    >
                      <span className="lt-live-block-name">{section.name}</span>
                      <span className="lt-live-block-meta" aria-hidden="true">
                        <span>{duration}</span>
                        {shortcut <= 9 && <kbd className="lt-live-kbd">{shortcut}</kbd>}
                      </span>
                    </button>
                  );
                }) : (
                  <p className="lt-live-no-sections">Añade secciones en Arreglo para saltar desde este mapa.</p>
                )}
                <div
                  className="lt-live-playhead"
                  style={{ left: 'min(' + playheadPct + '%, calc(100% - 2px))' }}
                  aria-hidden="true"
                />
              </div>

              {sections.length > 0 && (
                <div className="lt-live-cues">
                  <div className="min-w-0">
                    <p className="lt-live-secondary">Sección actual</p>
                    <h2>{activeSection?.name ?? 'Sin sección activa'}</h2>
                    <p className="lt-live-secondary lt-live-section-detail">
                      {activeSection && <>Quedan <strong>{mmss(Math.ceil(Math.max(0, Math.min(total, activeSection.endTimeSec) - now)))}</strong> en esta sección</>}
                      {activeSection && nextSection && <span aria-hidden="true"> · </span>}
                      {nextSection && <>Sigue <strong>{nextSection.name}</strong></>}
                    </p>
                    {queuedSection && (
                      <span className="lt-live-queued">
                        <span className="min-w-0 truncate">Salto a {queuedSection.name}</span>
                        <button type="button" onClick={onCancelQueuedJump} className="lt-live-queued-x shrink-0" aria-label="Cancelar el salto">
                          <X size={14} />
                        </button>
                      </span>
                    )}
                  </div>
                  <div className="lt-live-jump">
                    <div className="lt-live-jump-head">
                      <p className="lt-live-secondary" id="live-jump-label">Al saltar de sección</p>
                      <button
                        type="button"
                        role="switch"
                        aria-checked={jumpsEnabled}
                        aria-label="Permitir saltos de sección"
                        className="lt-live-switch"
                        onClick={() => onToggleJumps(!jumpsEnabled)}
                        title={jumpsEnabled ? 'Bloquear los saltos de sección' : 'Permitir saltos de sección'}
                      >
                        <span className="lt-live-switch-track" aria-hidden="true"><i /></span>
                        <span>{jumpsEnabled ? 'Saltos activos' : 'Saltos bloqueados'}</span>
                      </button>
                    </div>
                    <div className="lt-live-jump-tabs" role="group" aria-labelledby="live-jump-label">
                      {QUANTIZE_OPTIONS.map((option) => (
                        <button
                          key={option.value}
                          type="button"
                          aria-pressed={project.quantizeMode === option.value}
                          disabled={!jumpsEnabled}
                          title={option.hint}
                          onClick={() => onChangeQuantize(option.value)}
                        >
                          {option.label}
                        </button>
                      ))}
                    </div>
                    <select
                      className="lt-live-select lt-live-section-picker"
                      data-needed={hasShortSections || undefined}
                      aria-label="Ir a una sección"
                      disabled={!jumpsEnabled}
                      value=""
                      onChange={(event) => onJumpSection(event.target.value)}
                    >
                      <option value="" disabled>Ir a una sección</option>
                      {sections.map((section) => <option key={section.id} value={section.id}>{section.name}</option>)}
                    </select>
                  </div>
                </div>
              )}
            </>
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

            {!padOnly && (
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
            )}
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

        <ol className="flex-1 min-h-0 overflow-y-auto pb-2">
          {setlistQueue.map((song, idx) => {
            const isCurrent = song.id === project?.id;
            const isNext = nextSong?.id === song.id;
            const status = songStatus(song);
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
                    <span className="block lt-live-song-title">{song.title}</span>
                    <span className="block text-xs text-[var(--lt-mut)] tabular-nums">
                      {isCurrent ? (transport.isPlaying ? 'Sonando' : 'Cargada') : isNext ? 'Siguiente' : `${song.bpm} BPM`}
                      {isPadOnlySong(song) ? ' · Pad' : dur > 0 ? `, ${mmss(dur)}` : ''}
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
