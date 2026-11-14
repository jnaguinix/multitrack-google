import React, { useEffect, useRef, useState } from 'react';
import {
  MetersSnapshot,
  OutputBus,
  SongProject,
  TrackChannel,
  TransportState,
} from '../types/project';
import { useLiveMeters } from '../audio/liveMeters';
import { computeMixerLevels, trackPeak, activityFromGain, peakPosition } from '../utils/mixerLevels';

const MIN_DB = -40;
const MAX_DB = 10;
const MUTE_TRAVEL = 0.04;
const PEAK_FLOOR_DBFS = -60;
const PEAK_TICKS = [0, -20, -40, PEAK_FLOOR_DBFS];
const GAIN_TICKS = [MAX_DB, 0, -10, -20, MIN_DB];

export function gainToDb(gain: number): number {
  if (!Number.isFinite(gain) || gain <= 0) return -Infinity;
  return Math.round(200 * Math.log10(gain)) / 10;
}

export function dbToGain(db: number): number {
  if (!Number.isFinite(db)) return 0;
  const clamped = Math.max(MIN_DB, Math.min(MAX_DB, db));
  return Number(Math.pow(10, clamped / 20).toFixed(4));
}

export function posFromDb(db: number): number {
  if (!Number.isFinite(db)) return 0;
  const normalized = Math.max(0, Math.min(1, (db - MIN_DB) / (MAX_DB - MIN_DB)));
  return MUTE_TRAVEL + normalized * (1 - MUTE_TRAVEL);
}

export function dbFromPos(pos: number): number {
  if (pos < MUTE_TRAVEL) return -Infinity;
  return MIN_DB + (pos - MUTE_TRAVEL) / (1 - MUTE_TRAVEL) * (MAX_DB - MIN_DB);
}

export function formatDb(db: number): string {
  if (!isFinite(db)) return '-∞ dB';
  return `${db > 0 ? '+' : ''}${db.toFixed(1)} dB`;
}

function formatPanLabel(panPercent: number): string {
  const rounded = Math.round(panPercent);
  if (rounded === 0) return 'C';
  return rounded < 0 ? `L${-rounded}` : `R${rounded}`;
}

/* ============================================================================
 * ROTARY PAN KNOB COMPONENT (.lt-knob)
 * ============================================================================ */

interface PanKnobProps {
  name: string;
  pan: number; // -1.0 to +1.0
  onChangePan: (nextPan: number) => void;
}

const PanKnob: React.FC<PanKnobProps> = ({ name, pan, onChangePan }) => {
  const dragRef = useRef<{ pointerId: number; startY: number; startPanPct: number } | null>(null);
  const safePan = Number.isFinite(pan) ? pan : 0;
  const panPct = Math.max(-100, Math.min(100, Math.round(safePan * 100)));
  const angleDeg = panPct * 1.35;

  const setFromPct = (pct: number) => {
    const clamped = Math.max(-100, Math.min(100, Math.round(pct)));
    onChangePan(Number((clamped / 100).toFixed(2)));
  };

  return (
    <>
      <div
        role="slider"
        tabIndex={0}
        aria-label={`Pan ${name}`}
        aria-valuemin={-100}
        aria-valuemax={100}
        aria-valuenow={panPct}
        style={{ '--r': `${angleDeg}deg` } as React.CSSProperties}
        className="lt-knob"
        onPointerDown={(e) => {
          try {
            e.currentTarget.setPointerCapture(e.pointerId);
          } catch {
            // Ignore pointer capture errors on non-standard touch/pen drivers
          }
          dragRef.current = { pointerId: e.pointerId, startY: e.clientY, startPanPct: panPct };
        }}
        onPointerMove={(e) => {
          if (dragRef.current && dragRef.current.pointerId === e.pointerId) {
            const deltaY = dragRef.current.startY - e.clientY;
            setFromPct(dragRef.current.startPanPct + deltaY * 1.5);
          }
        }}
        onPointerUp={(e) => {
          try {
            if (e.currentTarget.hasPointerCapture(e.pointerId)) {
              e.currentTarget.releasePointerCapture(e.pointerId);
            }
          } catch {
            // Ignore
          }
          dragRef.current = null;
        }}
        onPointerCancel={() => {
          dragRef.current = null;
        }}
        onLostPointerCapture={() => {
          dragRef.current = null;
        }}
        onDoubleClick={() => onChangePan(0)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowUp' || e.key === 'ArrowRight') {
            e.preventDefault();
            setFromPct(panPct + 5);
          } else if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') {
            e.preventDefault();
            setFromPct(panPct - 5);
          }
        }}
        title="Arrastra verticalmente para panear · Doble clic para centrar (C)"
      />
      <div className="lt-panval">{formatPanLabel(panPct)}</div>
    </>
  );
};

/* ============================================================================
 * VERTICAL STUDIO FADER AND LEVEL METERS (.lt-fx)
 * ============================================================================ */

type MeterLevels = { l: number; r: number; dbScale: boolean };

type StudioFaderProps = {
  name: string;
  gain: number;
  onChangeGain: (nextGain: number) => void;
  /** Hay reproducción: solo entonces los medidores se suscriben al ciclo de lectura. */
  live: boolean;
} & (
  | { peakOf: (m: MetersSnapshot) => number; levelsOf?: never }
  | { levelsOf: (m: MetersSnapshot) => MeterLevels; peakOf?: never }
);

function meterMask(level: number): string {
  return `${Math.max(0, Math.min(100, (1 - level) * 100)).toFixed(1)}%`;
}

/* Los medidores son componentes hoja: son los únicos que se vuelven a renderizar con cada lectura (UI03). */

const FaderPeakMeter: React.FC<{ live: boolean; peakOf: (m: MetersSnapshot) => number }> = ({ live, peakOf }) => {
  const peak = peakOf(useLiveMeters(live));
  const peakDbfs = peak && Number.isFinite(peak) ? 20 * Math.log10(peak) : -Infinity;
  return (
    <>
      <div className="lt-meter lt-peak-meter" aria-hidden="true">
        <i />
        <s style={{ height: meterMask(peakPosition(peakDbfs)) }} />
      </div>
      <div className="lt-scale lt-peak-scale" aria-hidden="true">
        {PEAK_TICKS.map((tick) => (
          <span key={tick} data-zero={tick === 0 || undefined} style={{ bottom: `${peakPosition(tick) * 100}%` }} />
        ))}
      </div>
    </>
  );
};

const FaderPeakReadout: React.FC<{ live: boolean; peakOf: (m: MetersSnapshot) => number }> = ({ live, peakOf }) => {
  const peak = peakOf(useLiveMeters(live));
  const peakDbfs = peak && Number.isFinite(peak) ? 20 * Math.log10(peak) : -Infinity;
  const peakLabel = Number.isFinite(peakDbfs) ? `${peakDbfs.toFixed(1)} dBFS` : '−∞ dBFS';
  const peakTitle = `Pico de muestras del analizador de pista en mono, después de la ganancia y el paneo: ${peakLabel}`;
  return (
    <div className="lt-peak-readout" title={peakTitle}>
      {peakLabel}
    </div>
  );
};

const FaderLevelMeters: React.FC<{ live: boolean; levelsOf: (m: MetersSnapshot) => MeterLevels }> = ({ live, levelsOf }) => {
  const lv = levelsOf(useLiveMeters(live));
  return (
    <>
      <div className={`lt-meter${lv.dbScale ? ' lt-db-meter' : ''}`} aria-hidden="true">
        <i />
        <s style={{ height: meterMask(lv.l) }} />
      </div>
      <div className={`lt-meter${lv.dbScale ? ' lt-db-meter' : ''}`} aria-hidden="true">
        <i />
        <s style={{ height: meterMask(lv.r) }} />
      </div>
    </>
  );
};

const StudioFader: React.FC<StudioFaderProps> = ({
  name,
  gain,
  live,
  peakOf,
  levelsOf,
  onChangeGain,
}) => {
  const faderRef = useRef<HTMLDivElement | null>(null);
  const activePointerIdRef = useRef<number | null>(null);
  const safeGain = Number.isFinite(gain) ? gain : 1.0;
  const db = gainToDb(safeGain);
  const posPct = posFromDb(db) * 100;

  const updateFromClientY = (clientY: number) => {
    const el = faderRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    if (rect.height <= 0) return;
    const rawPos = 1 - (clientY - rect.top) / rect.height;
    const clampedPos = Math.max(0, Math.min(1, rawPos));
    let nextDb = dbFromPos(clampedPos);
    if (isFinite(nextDb) && Math.abs(nextDb) < 1.1) {
      nextDb = 0;
    }
    const roundedDb = !isFinite(nextDb) ? -Infinity : Math.round(nextDb * 10) / 10;
    onChangeGain(dbToGain(roundedDb));
  };

  return (
    <>
      <div className="lt-fx">
        <div className="lt-scale" aria-hidden="true">
          {GAIN_TICKS.map((tick) => (
            <span key={tick} data-zero={tick === 0 || undefined} style={{ bottom: `${posFromDb(tick) * 100}%` }} />
          ))}
        </div>

        <div
          ref={faderRef}
          role="slider"
          tabIndex={0}
          aria-label={`Nivel ${name}`}
          aria-valuetext={formatDb(db)}
          className="lt-fader"
          onPointerDown={(e) => {
            activePointerIdRef.current = e.pointerId;
            try {
              e.currentTarget.setPointerCapture(e.pointerId);
            } catch {
              // Ignore pointer capture errors
            }
            updateFromClientY(e.clientY);
          }}
          onPointerMove={(e) => {
            if (
              activePointerIdRef.current === e.pointerId ||
              e.currentTarget.hasPointerCapture(e.pointerId)
            ) {
              updateFromClientY(e.clientY);
            }
          }}
          onPointerUp={(e) => {
            activePointerIdRef.current = null;
            try {
              if (e.currentTarget.hasPointerCapture(e.pointerId)) {
                e.currentTarget.releasePointerCapture(e.pointerId);
              }
            } catch {
              // Ignore
            }
          }}
          onPointerCancel={() => {
            activePointerIdRef.current = null;
          }}
          onLostPointerCapture={() => {
            activePointerIdRef.current = null;
          }}
          onDoubleClick={() => onChangeGain(1.0)} // 0.0 dB
          onKeyDown={(e) => {
            if (e.key === 'ArrowUp') {
              e.preventDefault();
              onChangeGain(dbToGain(!Number.isFinite(db) ? MIN_DB : Math.min(MAX_DB, db + 0.5)));
            } else if (e.key === 'ArrowDown') {
              e.preventDefault();
              onChangeGain(!Number.isFinite(db) || db <= MIN_DB ? 0 : dbToGain(db - 0.5));
            }
          }}
          title="Ganancia de −40 a +10 dB · Hasta abajo para silencio · Doble clic para 0 dB"
        >
          <div className="lt-fill" style={{ height: `${posPct}%` }} />
          <div className="lt-handle" style={{ bottom: `${posPct}%` }} />
        </div>

        {peakOf ? <FaderPeakMeter live={live} peakOf={peakOf} /> : <FaderLevelMeters live={live} levelsOf={levelsOf} />}
      </div>

      <div className="lt-db">{formatDb(db)}</div>
      {peakOf && <FaderPeakReadout live={live} peakOf={peakOf} />}
    </>
  );
};

/* ============================================================================
 * REDESIGNED STUDIO MIXER CONSOLE
 * ============================================================================ */

export function formatTrackDisplayName(name: string): string {
  const trimmed = (name || '').trim();
  const norm = trimmed
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
  if (norm === 'cues' || norm === 'cue' || norm === 'guide' || norm === 'guia') {
    return 'Guía';
  }
  return trimmed || name;
}

export interface MultitrackMixerProps {
  project: SongProject;
  transport: TransportState;
  docked?: boolean;
  onToggleTrackMute: (trackId: string) => void;
  onToggleTrackSolo: (trackId: string) => void;
  onChangeTrackGain: (trackId: string, gain: number) => void;
  onChangeTrackPan: (trackId: string, pan: number) => void;
  onChangeTrackBus: (trackId: string, bus: OutputBus) => void;
  onChangeClickGain: (gain: number) => void;
  onChangeClickPan?: (pan: number) => void;
  onToggleClick: () => void;
  onChangeMasterGain: (gain: number) => void;
  onChangeCueMasterGain: (gain: number) => void;
  onResetMixer: () => void;
}

export const MultitrackMixer: React.FC<MultitrackMixerProps> = ({
  project,
  transport,
  docked = false,
  onToggleTrackMute,
  onToggleTrackSolo,
  onChangeTrackGain,
  onChangeTrackPan,
  onChangeTrackBus,
  onChangeClickGain,
  onChangeClickPan,
  onToggleClick,
  onChangeMasterGain,
  onChangeCueMasterGain,
  onResetMixer,
}) => {
  const anySolo = project.tracks.some((t) => t.soloed);
  const activeSection = project.sections.find((s) => s.id === transport.activeSectionId);
  const cueMasterGain = project.cueMasterGain ?? 0.708; // -3.0 dB por defecto
  const live = transport.isPlaying;

  // Niveles de los buses: cada medidor los calcula con su propia lectura (ver componentes hoja).
  const busLevelsOf = (bus: 'click' | 'main' | 'cue') => (m: MetersSnapshot): MeterLevels => {
    const lv = computeMixerLevels(project, transport, m);
    return { l: lv[bus].l, r: lv[bus].r, dbScale: lv.nativeScale };
  };

  // Check if user already imported a custom track named "Click" / metronome
  const hasCustomClickTrack = project.tracks.some((t) => {
    if (t.role === 'click') return true;
    const norm = (t.name || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
    return norm.includes('click') || norm.includes('metro');
  });
  return (
    <div
      className={`lt-mixer-surface flex flex-col select-none ${
        docked
          ? ''
          : 'flex-1 overflow-y-auto'
      }`}
    >
      {/* Mixer Top Sub-bar (shown only in standalone Mixer view; when docked, Setlist/Arranger toolbar already provides these controls) */}
      {!docked && (
        <div className="flex items-center justify-between gap-4 px-4 py-1.5 border-b border-studio-line bg-studio-panel/70 shrink-0">
          <div className="flex items-center gap-3">
            <div className="text-sm font-semibold tracking-tight text-studio-ink tabular-nums">
              {String(transport.currentBar).padStart(3, '0')}
              <small className="text-xs font-medium text-studio-muted ml-2 font-sans">
                {activeSection ? activeSection.name : 'Listo'}
              </small>
            </div>
            <span className="text-xs text-studio-muted hidden sm:inline">
              · Doble clic en fader = 0.0 dB · Doble clic en knob = Centrar (C)
            </span>
          </div>

          <button
            type="button"
            onClick={onResetMixer}
            className="text-xs font-medium text-studio-muted hover:text-studio-ink underline underline-offset-3 cursor-pointer"
          >
            Restablecer mezcla a 0 dB
          </button>
        </div>
      )}

      {/* Main Console Strip Container */}
      <main className={`lt-console ${docked ? 'lt-docked' : 'lt-console-full'}`}>
        {/* Left: Scrollable Individual Channel Strips (#channels) */}
        <section className="lt-channels" aria-label="Canales">
          {project.tracks.map((track: TrackChannel) => {
            const isDimmed = track.muted || (anySolo && !track.soloed);
            const isCueRoute = track.bus === 'cue-click';
            const displayName = formatTrackDisplayName(track.name);

            return (
              <div
                key={track.id}
                style={{ '--c': track.color } as React.CSSProperties}
                className={`lt-strip ${isDimmed ? 'lt-dim' : ''}`}
              >
                <div className="lt-cap" />
                <div className="lt-name" title={displayName}>
                  {displayName}
                </div>

                <PanKnob
                  name={displayName}
                  pan={track.pan}
                  onChangePan={(nextPan) => onChangeTrackPan(track.id, nextPan)}
                />

                <StudioFader
                  name={displayName}
                  gain={track.gain}
                  live={live}
                  peakOf={(m) => trackPeak(project, transport, m, track.id)}
                  onChangeGain={(nextGain) => onChangeTrackGain(track.id, nextGain)}
                />

                <div className="lt-ms">
                  <button
                    type="button"
                    className="lt-m"
                    aria-pressed={track.muted}
                    aria-label={`Mute ${displayName}`}
                    onClick={() => onToggleTrackMute(track.id)}
                  >
                    M
                  </button>
                  <button
                    type="button"
                    className="lt-s"
                    aria-pressed={track.soloed}
                    aria-label={`Solo ${displayName}`}
                    onClick={() => onToggleTrackSolo(track.id)}
                  >
                    S
                  </button>
                </div>

                <button
                  type="button"
                  className="lt-route"
                  data-bus={isCueRoute ? 'cue-click' : 'main'}
                  onClick={() =>
                    onChangeTrackBus(
                      track.id,
                      isCueRoute ? 'main' : 'cue-click'
                    )
                  }
                  title="Alternar envío a Main L/R o Click / Cue"
                >
                  {isCueRoute ? 'Click / Cue' : 'Main L/R'}
                </button>
              </div>
            );
          })}

          {/* Built-in Synthesized Click Strip (if no custom Click stem exists) */}
          {!hasCustomClickTrack && (
            <div
              style={{ '--c': '#22d3ee' } as React.CSSProperties}
              className={`lt-strip ${!project.clickEnabled || anySolo ? 'lt-dim' : ''}`}
            >
              <div className="lt-cap" />
              <div className="lt-name" title="Click Metrónomo">
                Click
              </div>

              <PanKnob
                name="Click"
                pan={project.clickPan ?? 0}
                onChangePan={(nextPan) => onChangeClickPan?.(nextPan)}
              />

              <StudioFader
                name="Click"
                gain={project.clickGain}
                live={live}
                levelsOf={busLevelsOf('click')}
                onChangeGain={onChangeClickGain}
              />

              <div className="lt-ms">
                <button
                  type="button"
                  className="lt-m"
                  aria-pressed={!project.clickEnabled}
                  aria-label="Mute Click"
                  onClick={onToggleClick}
                >
                  M
                </button>
                <button
                  type="button"
                  className="lt-s"
                  aria-pressed={false}
                  aria-label="Solo Click"
                  onClick={() => {
                    if (!project.clickEnabled) onToggleClick();
                  }}
                >
                  S
                </button>
              </div>

              <button
                type="button"
                className="lt-route"
                data-bus="cue-click"
                title="Ruteado al bus Click / Cue"
              >
                Click / Cue
              </button>
            </div>
          )}

        </section>

        {/* Right: Master Output Buses (#buses — Main L/R & Click / Cue) */}
        <section className="lt-buses" aria-label="Buses de salida">
          {/* Bus 1: Main L/R ("Salida principal") */}
          <div
            style={{ '--c': '#f59e0b' } as React.CSSProperties}
            className="lt-strip lt-bus"
          >
            <div className="lt-cap" />
            <div className="lt-name">Main L/R</div>
            <div className="lt-sub">Salida principal</div>

            <StudioFader
              name="Main L/R"
              gain={project.masterGain}
              live={live}
              levelsOf={busLevelsOf('main')}
              onChangeGain={onChangeMasterGain}
            />
          </div>

          {/* Bus 2: Click / Cue ("Auriculares banda") */}
          <div
            style={{ '--c': '#22d3ee' } as React.CSSProperties}
            className="lt-strip lt-bus"
          >
            <div className="lt-cap" />
            <div className="lt-name">Click / Cue</div>
            <div className="lt-sub">Auriculares banda</div>

            <StudioFader
              name="Click / Cue"
              gain={cueMasterGain}
              live={live}
              levelsOf={busLevelsOf('cue')}
              onChangeGain={onChangeCueMasterGain}
            />
          </div>
        </section>
      </main>
    </div>
  );
};
