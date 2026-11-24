import React from 'react';
import { Volume2, VolumeX } from 'lucide-react';
import type { SongProject, TransportState } from '../types/project';
import {
  CLICK_SUBDIVISION_OPTIONS,
  effectivePadNoteIndex,
  normalizeClickSubdivision,
  noteIndexToLabel,
  PAD_NOTES,
  parseKeyToNoteIndex,
  TIME_SIGNATURE_OPTIONS,
} from '../utils/padSong';

interface PadStagePanelProps {
  mode: 'prepare' | 'live';
  project: SongProject;
  transport: TransportState;
  onChangeKeySignature?: (key: string) => void;
  onChangeBpm?: (bpm: number) => void;
  onChangeBeatsPerBar?: (beatsPerBar: number) => void;
  onChangeClickSubdivision?: (subdivision: 1 | 2 | 4) => void;
  onTogglePad?: () => void;
  onToggleClick?: () => void;
}

/**
 * Panel del modo sin secuencia: cuadrícula de las 12 notas del pad + metrónomo moderno (×1, ×2, ×4).
 * En `prepare` (Setlist) permite ajustar todo; en `live` (En vivo) es estrictamente visual para evitar toques accidentales.
 */
export const PadStagePanel: React.FC<PadStagePanelProps> = ({
  mode,
  project,
  transport,
  onChangeKeySignature,
  onChangeBpm,
  onChangeBeatsPerBar,
  onChangeClickSubdivision,
  onTogglePad,
  onToggleClick,
}) => {
  const isLive = mode === 'live';
  const baseNoteIdx = parseKeyToNoteIndex(project.keySignature);
  const activeNoteIdx = effectivePadNoteIndex(project.keySignature, project.pitchSemitones);
  const padOn = project.padEnabled !== false;
  const subdivision = normalizeClickSubdivision(project.clickSubdivision);
  const bpb = Math.max(2, Math.min(12, project.beatsPerBar || 4));
  const beatUnit = project.beatUnit || (bpb === 6 ? 8 : 4);
  const bpm = Math.max(40, Math.min(240, Math.round(project.bpm || 120)));
  const subdivisionBadge = CLICK_SUBDIVISION_OPTIONS.find((o) => o.value === subdivision)?.badge ?? '×1';

  return (
    <section
      className={`lt-pad-stage ${isLive ? 'lt-pad-stage-live' : 'lt-pad-stage-prepare'}`}
      aria-label={isLive ? 'Pad y metrónomo en vivo (solo lectura)' : 'Preparar pad y metrónomo'}
    >
      {/* Bloque izquierdo: 12 notas del pad */}
      <div className="lt-pad-card">
        <div className="lt-pad-card-head">
          <div>
            <h2>Pad continuo · 12 notas</h2>
            <p className="lt-pad-sub">
              {padOn
                ? project.pitchSemitones !== 0
                  ? `Sonando en ${noteIndexToLabel(activeNoteIdx)} (base ${noteIndexToLabel(baseNoteIdx)} ${project.pitchSemitones > 0 ? '+' : ''}${project.pitchSemitones} st)`
                  : `Tono activo: ${noteIndexToLabel(activeNoteIdx)}`
                : 'Pad silenciado (solo click)'}
            </p>
          </div>
          {!isLive && onTogglePad ? (
            <button
              type="button"
              className="lt-control"
              aria-pressed={padOn}
              onClick={onTogglePad}
            >
              {padOn ? <Volume2 size={15} /> : <VolumeX size={15} />}
              <span>{padOn ? 'Pad activo' : 'Pad silenciado'}</span>
            </button>
          ) : (
            <span className="lt-pad-pill" data-active={padOn && transport.isPlaying || undefined}>
              {padOn ? (transport.isPlaying ? 'Sonando' : 'Pad listo') : 'Silenciado'}
            </span>
          )}
        </div>

        <div className="lt-pad-grid" role="group" aria-label="Notas del pad">
          {PAD_NOTES.map((n) => {
            const isActive = n.index === activeNoteIdx;
            const isSounding = isActive && padOn && transport.isPlaying;
            if (isLive) {
              return (
                <div
                  key={n.keySignature}
                  className="lt-pad-note lt-pad-note-ro"
                  data-active={isActive || undefined}
                  data-sounding={isSounding || undefined}
                >
                  <span className="lt-pad-note-label">{n.label}</span>
                  {isActive && <span className="lt-pad-note-tag">{padOn ? 'Tono' : 'Mute'}</span>}
                </div>
              );
            }
            return (
              <button
                key={n.keySignature}
                type="button"
                className="lt-pad-note"
                data-active={isActive || undefined}
                data-sounding={isSounding || undefined}
                aria-pressed={n.index === baseNoteIdx}
                onClick={() => onChangeKeySignature?.(n.keySignature)}
              >
                <span className="lt-pad-note-label">{n.label}</span>
                {isActive && <span className="lt-pad-note-tag">{padOn ? 'Tono' : 'Mute'}</span>}
              </button>
            );
          })}
        </div>
      </div>

      {/* Bloque derecho: metrónomo moderno */}
      <div className="lt-metro-card">
        <div className="lt-pad-card-head">
          <div>
            <h2>Metrónomo</h2>
            <p className="lt-pad-sub">
              {project.clickEnabled
                ? isLive
                  ? `Click en auriculares · ${bpb}/${beatUnit}`
                  : `${bpm} BPM · ${bpb}/${beatUnit} · Pulso ${subdivisionBadge}`
                : 'Click desactivado'}
            </p>
          </div>
          {!isLive && onToggleClick ? (
            <button
              type="button"
              className="lt-control"
              aria-pressed={project.clickEnabled}
              onClick={onToggleClick}
            >
              {project.clickEnabled ? <Volume2 size={15} /> : <VolumeX size={15} />}
              <span>{project.clickEnabled ? 'Click activo' : 'Click mudo'}</span>
            </button>
          ) : (
            <span className="lt-pad-pill" data-active={project.clickEnabled && transport.isPlaying || undefined}>
              {project.clickEnabled ? (transport.isPlaying ? 'Marcando' : 'Click listo') : 'Click mudo'}
            </span>
          )}
        </div>

        {/* Luces de pulso por tiempo del compás */}
        <div className="lt-metro-beats" aria-label={`Pulso ${transport.currentBeat} de ${bpb}`}>
          {Array.from({ length: bpb }, (_, idx) => {
            const beatNum = idx + 1;
            const active = transport.isPlaying && project.clickEnabled && transport.currentBeat === beatNum;
            const isDownbeat = idx === 0;
            return (
              <div
                key={beatNum}
                className="lt-metro-beat"
                data-active={active || undefined}
                data-downbeat={isDownbeat || undefined}
              >
                <span>{beatNum}</span>
              </div>
            );
          })}
        </div>

        {/* Lectura grande solo en En vivo (en Setlist los controles ya muestran BPM, compás y pulso) */}
        {isLive && (
          <div className="lt-metro-readout">
            <div className="lt-metro-bpm">
              <strong>{bpm}</strong>
              <span>BPM</span>
            </div>
            <div className="lt-metro-meta">
              <span>Compás {bpb}/{beatUnit}</span>
              <span>·</span>
              <span>Pulso {subdivisionBadge}</span>
            </div>
          </div>
        )}

        {isLive ? (
          <div className="lt-metro-sub-badges" aria-label="Subdivisión del click">
            {CLICK_SUBDIVISION_OPTIONS.map((opt) => (
              <div
                key={opt.value}
                className="lt-metro-sub-ro"
                data-active={subdivision === opt.value || undefined}
              >
                <strong>{opt.badge}</strong>
                <span>{opt.label}</span>
              </div>
            ))}
          </div>
        ) : (
          <div className="lt-metro-controls">
            <div className="lt-metro-row">
              <label className="lt-field">
                <span>BPM</span>
                <div className="lt-metro-bpm-edit">
                  <button
                    type="button"
                    className="lt-control lt-icon-control"
                    aria-label="Bajar BPM"
                    onClick={() => onChangeBpm?.(Math.max(40, bpm - 1))}
                  >
                    −
                  </button>
                  <input
                    type="number"
                    min={40}
                    max={240}
                    value={bpm}
                    onChange={(e) => {
                      const val = Number(e.target.value);
                      if (Number.isFinite(val) && val >= 40 && val <= 240) {
                        onChangeBpm?.(Math.round(val));
                      }
                    }}
                  />
                  <button
                    type="button"
                    className="lt-control lt-icon-control"
                    aria-label="Subir BPM"
                    onClick={() => onChangeBpm?.(Math.min(240, bpm + 1))}
                  >
                    +
                  </button>
                </div>
              </label>

              <label className="lt-field">
                <span>Compás</span>
                <select
                  value={bpb}
                  onChange={(e) => onChangeBeatsPerBar?.(Number(e.target.value) || 4)}
                >
                  {TIME_SIGNATURE_OPTIONS.map((opt) => (
                    <option key={opt.label} value={opt.beatsPerBar}>
                      {opt.label}
                    </option>
                  ))}
                </select>
              </label>
            </div>

            <div className="lt-field">
              <span>Subdivisión del click (el BPM no cambia)</span>
              <div className="lt-segmented" role="group" aria-label="Subdivisión del click">
                {CLICK_SUBDIVISION_OPTIONS.map((opt) => (
                  <button
                    key={opt.value}
                    type="button"
                    className="lt-control"
                    aria-pressed={subdivision === opt.value}
                    title={opt.hint}
                    onClick={() => onChangeClickSubdivision?.(opt.value)}
                  >
                    {opt.badge} · {opt.label}
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>
    </section>
  );
};
