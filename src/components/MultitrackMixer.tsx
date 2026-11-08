import React, { useEffect, useRef, useState } from 'react';
import {
  MetersSnapshot,
  OutputBus,
  SongProject,
  TrackChannel,
  TransportState,
} from '../types/project';
import { audioEngine } from '../audio/audioEngine';

const MIN_DB = -60;
const MAX_DB = 6;

export function gainToDb(gain: number): number {
  if (gain <= 0.001) return -Infinity;
  const db = 20 * Math.log10(gain);
  return Math.max(MIN_DB, Math.min(MAX_DB, Math.round(db * 10) / 10));
}

export function dbToGain(db: number): number {
  if (!isFinite(db) || db <= MIN_DB) return 0;
  const clamped = Math.max(MIN_DB, Math.min(MAX_DB, db));
  return Number(Math.pow(10, clamped / 20).toFixed(4));
}

function posFromDb(db: number): number {
  if (!isFinite(db) || db <= MIN_DB) return 0;
  return Math.max(0, Math.min(1, (db - MIN_DB) / (MAX_DB - MIN_DB)));
}

function dbFromPos(pos: number): number {
  if (pos <= 0.004) return -Infinity;
  return MIN_DB + pos * (MAX_DB - MIN_DB);
}

function formatDb(db: number): string {
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
  const dragRef = useRef<{ startY: number; startPanPct: number } | null>(null);
  const panPct = Math.max(-100, Math.min(100, Math.round(pan * 100)));
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
          e.currentTarget.setPointerCapture(e.pointerId);
          dragRef.current = { startY: e.clientY, startPanPct: panPct };
        }}
        onPointerMove={(e) => {
          if (e.currentTarget.hasPointerCapture(e.pointerId) && dragRef.current) {
            const deltaY = dragRef.current.startY - e.clientY;
            setFromPct(dragRef.current.startPanPct + deltaY * 1.5);
          }
        }}
        onPointerUp={(e) => {
          if (e.currentTarget.hasPointerCapture(e.pointerId)) {
            e.currentTarget.releasePointerCapture(e.pointerId);
          }
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
 * VERTICAL STUDIO FADER + DUAL STEREO METERS (.lt-fx)
 * ============================================================================ */

interface StudioFaderProps {
  name: string;
  gain: number;
  levelL: number; // 0..1
  levelR: number; // 0..1
  onChangeGain: (nextGain: number) => void;
}

const StudioFader: React.FC<StudioFaderProps> = ({
  name,
  gain,
  levelL,
  levelR,
  onChangeGain,
}) => {
  const faderRef = useRef<HTMLDivElement | null>(null);
  const db = gainToDb(gain);
  const posPct = posFromDb(db) * 100;

  const updateFromClientY = (clientY: number) => {
    const el = faderRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const rawPos = 1 - (clientY - rect.top) / rect.height;
    const clampedPos = Math.max(0, Math.min(1, rawPos));
    let nextDb = dbFromPos(clampedPos);
    if (isFinite(nextDb) && Math.abs(nextDb) < 1.1) {
      nextDb = 0;
    }
    const roundedDb = !isFinite(nextDb) ? -Infinity : Math.round(nextDb * 10) / 10;
    onChangeGain(dbToGain(roundedDb));
  };

  const maskHeightL = `${Math.max(0, Math.min(100, (1 - levelL) * 100)).toFixed(1)}%`;
  const maskHeightR = `${Math.max(0, Math.min(100, (1 - levelR) * 100)).toFixed(1)}%`;

  return (
    <>
      <div className="lt-fx">
        <div className="lt-scale" aria-hidden="true">
          <span>+6</span>
          <span>0</span>
          <span>-10</span>
          <span>-20</span>
          <span>-40</span>
          <span>-∞</span>
        </div>

        <div
          ref={faderRef}
          role="slider"
          tabIndex={0}
          aria-label={`Nivel ${name}`}
          aria-valuetext={formatDb(db)}
          className="lt-fader"
          onPointerDown={(e) => {
            e.currentTarget.setPointerCapture(e.pointerId);
            updateFromClientY(e.clientY);
          }}
          onPointerMove={(e) => {
            if (e.currentTarget.hasPointerCapture(e.pointerId)) {
              updateFromClientY(e.clientY);
            }
          }}
          onPointerUp={(e) => {
            if (e.currentTarget.hasPointerCapture(e.pointerId)) {
              e.currentTarget.releasePointerCapture(e.pointerId);
            }
          }}
          onDoubleClick={() => onChangeGain(1.0)} // 0.0 dB
          onKeyDown={(e) => {
            const currentDb = isFinite(db) ? db : MIN_DB;
            if (e.key === 'ArrowUp') {
              e.preventDefault();
              onChangeGain(dbToGain(Math.min(MAX_DB, currentDb + 0.5)));
            } else if (e.key === 'ArrowDown') {
              e.preventDefault();
              onChangeGain(dbToGain(Math.max(MIN_DB, currentDb - 0.5)));
            }
          }}
          title="Arrastra para ajustar dB · Doble clic para 0.0 dB"
        >
          <div className="lt-fill" style={{ height: `${posPct}%` }} />
          <div className="lt-handle" style={{ bottom: `${posPct}%` }} />
        </div>

        <div className="lt-meter" aria-hidden="true">
          <i />
          <s style={{ height: maskHeightL }} />
        </div>
        <div className="lt-meter" aria-hidden="true">
          <i />
          <s style={{ height: maskHeightR }} />
        </div>
      </div>

      <div className="lt-db">{formatDb(db)}</div>
    </>
  );
};

/* ============================================================================
 * REDESIGNED STUDIO MIXER CONSOLE
 * ============================================================================ */

export interface MultitrackMixerProps {
  project: SongProject;
  transport: TransportState;
  metersRef: React.MutableRefObject<MetersSnapshot>;
  docked?: boolean;
  onToggleTrackMute: (trackId: string) => void;
  onToggleTrackSolo: (trackId: string) => void;
  onChangeTrackGain: (trackId: string, gain: number) => void;
  onChangeTrackPan: (trackId: string, pan: number) => void;
  onChangeTrackBus: (trackId: string, bus: OutputBus) => void;
  onChangeClickGain: (gain: number) => void;
  onToggleClick: () => void;
  onChangeGuideGain: (gain: number) => void;
  onToggleGuide: () => void;
  onChangeMasterGain: (gain: number) => void;
  onChangeCueMasterGain: (gain: number) => void;
  onResetMixer: () => void;
}

export const MultitrackMixer: React.FC<MultitrackMixerProps> = ({
  project,
  transport,
  metersRef,
  docked = false,
  onToggleTrackMute,
  onToggleTrackSolo,
  onChangeTrackGain,
  onChangeTrackPan,
  onChangeTrackBus,
  onChangeClickGain,
  onToggleClick,
  onChangeGuideGain,
  onToggleGuide,
  onChangeMasterGain,
  onChangeCueMasterGain,
  onResetMixer,
}) => {
  const [, setMeterTick] = useState(0);

  // Poll meters into metersRef and refresh only MultitrackMixer at a maximum of 20 fps (50 ms)
  useEffect(() => {
    if (!transport.isPlaying) {
      metersRef.current = {
        tracks: {},
        master: { rms: 0, peak: 0, clipping: false },
      };
      setMeterTick((t) => t + 1);
      return;
    }

    const intervalId = window.setInterval(() => {
      metersRef.current = audioEngine.getTrackMeters();
      setMeterTick((t) => (t + 1) % 1000000);
    }, 50);

    return () => window.clearInterval(intervalId);
  }, [transport.isPlaying, metersRef]);

  const meters = metersRef.current;
  const anySolo = project.tracks.some((t) => t.soloed);
  const activeSection = project.sections.find((s) => s.id === transport.activeSectionId);

  // Compute stereo L/R levels per track and bus
  let maxMainBusLevel = 0;
  let maxCueBusLevel = 0;

  const computeStereoPair = (rms: number, pan: number) => {
    const leftWeight = pan <= 0 ? 1 : Math.max(0.2, 1 - pan * 0.85);
    const rightWeight = pan >= 0 ? 1 : Math.max(0.2, 1 + pan * 0.85);
    const l = Math.min(1, rms * leftWeight);
    const r = Math.min(1, rms * rightWeight);
    return { l, r };
  };

  for (const trk of project.tracks) {
    const isAudible = anySolo ? trk.soloed && !trk.muted : !trk.muted;
    const rawRms = isAudible && transport.isPlaying ? meters.tracks[trk.id]?.rms || 0 : 0;
    if (rawRms > 0) {
      if (trk.bus === 'main' || trk.bus === 'both') {
        maxMainBusLevel = Math.max(maxMainBusLevel, rawRms);
      }
      if (trk.bus === 'cue-click' || trk.bus === 'both') {
        maxCueBusLevel = Math.max(maxCueBusLevel, rawRms);
      }
    }
  }

  // Synthesize realistic beat-synced meter pulse for the built-in Click & Cues strips when playing
  const beatDecay = transport.isPlaying
    ? Math.max(0, 1 - transport.beatProgress * 2.6)
    : 0;
  const clickStripLevel =
    transport.isPlaying && project.clickEnabled && !anySolo
      ? posFromDb(gainToDb(project.clickGain)) *
        (transport.currentBeat === 1 ? 0.86 : 0.65) *
        beatDecay
      : 0;
  const guideStripLevel =
    transport.isPlaying && project.guideCuesEnabled && !anySolo
      ? posFromDb(gainToDb(project.guideGain)) *
        (transport.queuedSectionId ? 0.78 : 0.25) *
        beatDecay
      : 0;

  maxCueBusLevel = Math.max(maxCueBusLevel, clickStripLevel, guideStripLevel);

  const cueMasterGain = project.cueMasterGain ?? 0.708; // -3.0 dB default
  const mainBusOutLevel = transport.isPlaying
    ? Math.min(1, Math.max(maxMainBusLevel, meters.master.rms) * posFromDb(gainToDb(project.masterGain)) * 1.05)
    : 0;
  const cueBusOutLevel = transport.isPlaying
    ? Math.min(1, maxCueBusLevel * posFromDb(gainToDb(cueMasterGain)) * 1.05)
    : 0;

  // Check if user already imported custom tracks named "Click" or "Cues"
  const hasCustomClickTrack = project.tracks.some((t) => t.role === 'click');
  const hasCustomGuideTrack = project.tracks.some((t) => t.role === 'guide');

  return (
    <div
      className={`lt-mixer-surface flex flex-col select-none ${
        docked
          ? 'border-t-2 border-[#252d3c]'
          : 'flex-1 overflow-y-auto'
      }`}
    >
      {/* Mixer Top Sub-bar (shown in full Mixer view, or compact header when docked) */}
      <div className="flex items-center justify-between gap-4 px-5 py-2.5 border-b border-[#252d3c] bg-[#151a24]/70">
        <div className="flex items-center gap-3">
          <div className="text-xl font-semibold tracking-tight text-[#e9ecf2] font-mono tabular-nums">
            {String(transport.currentBar).padStart(3, '0')}
            <small className="text-xs font-medium text-[#7f8899] ml-2 font-sans">
              {activeSection ? activeSection.name : 'Listo'}
            </small>
          </div>
          {!docked && (
            <span className="text-xs text-[#7f8899] hidden sm:inline">
              · Doble clic en fader = 0.0 dB · Doble clic en knob = Centrar (C)
            </span>
          )}
        </div>

        <button
          type="button"
          onClick={onResetMixer}
          className="text-xs font-medium text-[#7f8899] hover:text-[#e9ecf2] underline underline-offset-3 cursor-pointer"
        >
          Restablecer mezcla a 0 dB
        </button>
      </div>

      {/* Main Console Strip Container */}
      <main className={`lt-console ${docked ? 'lt-docked' : ''}`}>
        {/* Left: Scrollable Individual Channel Strips (#channels) */}
        <section className="lt-channels" aria-label="Canales">
          {project.tracks.map((track: TrackChannel) => {
            const isDimmed = track.muted || (anySolo && !track.soloed);
            const rawRms =
              !isDimmed && transport.isPlaying
                ? meters.tracks[track.id]?.rms || 0
                : 0;
            const stereo = computeStereoPair(rawRms, track.pan);
            const isCueRoute = track.bus === 'cue-click';

            return (
              <div
                key={track.id}
                style={{ '--c': track.color } as React.CSSProperties}
                className={`lt-strip ${isDimmed ? 'lt-dim' : ''}`}
              >
                <div className="lt-cap" />
                <div className="lt-name" title={track.name}>
                  {track.name}
                </div>

                <PanKnob
                  name={track.name}
                  pan={track.pan}
                  onChangePan={(nextPan) => onChangeTrackPan(track.id, nextPan)}
                />

                <StudioFader
                  name={track.name}
                  gain={track.gain}
                  levelL={stereo.l}
                  levelR={stereo.r}
                  onChangeGain={(nextGain) => onChangeTrackGain(track.id, nextGain)}
                />

                <div className="lt-ms">
                  <button
                    type="button"
                    className="lt-m"
                    aria-pressed={track.muted}
                    aria-label={`Mute ${track.name}`}
                    onClick={() => onToggleTrackMute(track.id)}
                  >
                    M
                  </button>
                  <button
                    type="button"
                    className="lt-s"
                    aria-pressed={track.soloed}
                    aria-label={`Solo ${track.name}`}
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

              <PanKnob name="Click" pan={0} onChangePan={() => {}} />

              <StudioFader
                name="Click"
                gain={project.clickGain}
                levelL={clickStripLevel}
                levelR={clickStripLevel * 0.96}
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

          {/* Built-in Voice / Tone Guide Cues Strip (if no custom Guide stem exists) */}
          {!hasCustomGuideTrack && (
            <div
              style={{ '--c': '#22d3ee' } as React.CSSProperties}
              className={`lt-strip ${!project.guideCuesEnabled || anySolo ? 'lt-dim' : ''}`}
            >
              <div className="lt-cap" />
              <div className="lt-name" title="Cues de Guía Vocal">
                Cues
              </div>

              <PanKnob name="Cues" pan={0} onChangePan={() => {}} />

              <StudioFader
                name="Cues"
                gain={project.guideGain}
                levelL={guideStripLevel}
                levelR={guideStripLevel * 0.95}
                onChangeGain={onChangeGuideGain}
              />

              <div className="lt-ms">
                <button
                  type="button"
                  className="lt-m"
                  aria-pressed={!project.guideCuesEnabled}
                  aria-label="Mute Cues"
                  onClick={onToggleGuide}
                >
                  M
                </button>
                <button
                  type="button"
                  className="lt-s"
                  aria-pressed={false}
                  aria-label="Solo Cues"
                  onClick={() => {
                    if (!project.guideCuesEnabled) onToggleGuide();
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
              levelL={mainBusOutLevel}
              levelR={mainBusOutLevel * 0.95}
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
              levelL={cueBusOutLevel}
              levelR={cueBusOutLevel * 0.95}
              onChangeGain={onChangeCueMasterGain}
            />
          </div>
        </section>
      </main>
    </div>
  );
};
