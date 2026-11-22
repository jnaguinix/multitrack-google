import React, { useEffect, useMemo, useRef } from 'react';
import type { SongProject, TransportState } from '../types/project';
import { drawSectionWaveBars, getSongWaveformPeaks } from '../utils/songWaveform';
import { formatMmSs } from './TransportDeck';

interface Props {
  project: SongProject;
  transport: TransportState;
  /** Mueve el cursor a un segundo de la canción (clic en la onda). */
  onSeekSeconds: (seconds: number) => void;
  /** Salta a una sección (clic en su círculo). */
  onJumpSection: (sectionId: string) => void;
}

/**
 * Mapa compacto de la canción para la página Mezcla: la misma onda por colores de sección que Setlist y En vivo
 * (`drawSectionWaveBars`), con el cursor, y un clic mueve el cursor. Sirve para adelantar o atrasar hasta donde suena
 * el instrumento que se quiere mezclar sin esperar a que llegue.
 */
export const SongMapStrip: React.FC<Props> = ({ project, transport, onSeekSeconds, onJumpSection }) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  const totalDurationSec = useMemo(() => {
    const secPerBar = (60 / (project.bpm || 120)) * (project.beatsPerBar || 4);
    return Math.max(1, transport.totalDurationSec || project.durationSec || project.totalBars * secPerBar);
  }, [project, transport.totalDurationSec]);

  const peaks = useMemo(() => getSongWaveformPeaks(project, totalDurationSec), [project, totalDurationSec]);
  const sections = useMemo(
    () => [...project.sections].sort((a, b) => a.startTimeSec - b.startTimeSec),
    [project.sections],
  );
  const playheadSec = Math.max(0, Math.min(transport.currentTimeSec, totalDurationSec));
  const playheadPct = (playheadSec / totalDurationSec) * 100;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const draw = () => {
      const { clientWidth: width, clientHeight: height } = canvas;
      if (!width || !height) return;
      const dpr = window.devicePixelRatio || 1;
      const pixelWidth = Math.round(width * dpr);
      const pixelHeight = Math.round(height * dpr);
      if (canvas.width !== pixelWidth) canvas.width = pixelWidth;
      if (canvas.height !== pixelHeight) canvas.height = pixelHeight;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, width, height);
      for (const section of sections) {
        const startX = (section.startTimeSec / totalDurationSec) * width;
        const endX = (section.endTimeSec / totalDurationSec) * width;
        const queued = section.id === transport.queuedSectionId;
        ctx.fillStyle = queued ? '#e8ba68' : section.color || '#F5F5F3';
        ctx.globalAlpha = queued || section.id === transport.activeSectionId ? 0.34 : 0.2;
        ctx.fillRect(startX, 0, Math.max(0, endX - startX), height);
        ctx.globalAlpha = 0.6;
        ctx.fillRect(startX, 0, 1, height);
      }
      // Arriba queda una franja libre para los círculos de las secciones.
      drawSectionWaveBars(ctx, { width, height, peaks, sections, totalDurationSec, top: 30, bottom: height - 6 });
      ctx.globalAlpha = 1;
    };
    draw();
    const observer = new ResizeObserver(draw);
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [peaks, sections, totalDurationSec, transport.activeSectionId, transport.queuedSectionId]);

  const handleClick = (event: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    if (rect.width <= 0) return;
    const ratio = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
    onSeekSeconds(ratio * totalDurationSec);
  };

  return (
    <section className="lt-mix-map" aria-label="Mapa de la canción">
      <div className="lt-waveform lt-mix-map-wave relative overflow-hidden">
        <canvas
          ref={canvasRef}
          onClick={handleClick}
          className="w-full h-full block cursor-pointer"
          aria-label="Mapa de la canción. Haz clic para mover el cursor."
        />
        <span className="lt-setlist-waveform-unplayed" style={{ left: `${playheadPct}%` }} aria-hidden="true" />
        <span
          className="lt-setlist-waveform-cursor"
          style={{ left: `min(${playheadPct}%, calc(100% - 2px))` }}
          aria-hidden="true"
        />
        {sections.map((section) => (
          <button
            key={section.id}
            type="button"
            className="lt-map-badge"
            data-active={section.id === transport.activeSectionId || undefined}
            data-queued={section.id === transport.queuedSectionId || undefined}
            style={{
              left: `${(section.startTimeSec / totalDurationSec) * 100}%`,
              '--sec': section.color || 'var(--lt-accent)',
            } as React.CSSProperties}
            onClick={() => onJumpSection(section.id)}
            title={`${section.name} · ${formatMmSs(section.startTimeSec)}`}
            aria-label={`${section.name}, ${formatMmSs(section.startTimeSec)}`}
          >
            {section.code}
          </button>
        ))}
      </div>
    </section>
  );
};
