import React from 'react';
import { Volume2, Mic, Sliders, RotateCcw } from 'lucide-react';
import {
  OutputBus,
  SongProject,
  TrackChannel,
  TrackMeterReading,
} from '../types/project';

interface MultitrackMixerProps {
  project: SongProject;
  meters: {
    tracks: Record<string, TrackMeterReading>;
    master: TrackMeterReading;
  };
  onToggleTrackMute: (trackId: string) => void;
  onToggleTrackSolo: (trackId: string) => void;
  onChangeTrackGain: (trackId: string, gain: number) => void;
  onChangeTrackPan: (trackId: string, pan: number) => void;
  onChangeTrackBus: (trackId: string, bus: OutputBus) => void;
  onChangeClickGain: (gain: number) => void;
  onChangeClickSubdivision: (sub: 1 | 2) => void;
  onToggleClick: () => void;
  onChangeGuideGain: (gain: number) => void;
  onToggleGuide: () => void;
  onToggleGuideVoice: () => void;
  onChangeMasterGain: (gain: number) => void;
  onResetMixer: () => void;
}

function gainToDbString(gain: number): string {
  if (gain <= 0.001) return '-∞ dB';
  const db = 20 * Math.log10(gain);
  return `${db >= 0 ? '+' : ''}${db.toFixed(1)} dB`;
}

function formatPan(pan: number): string {
  if (Math.abs(pan) < 0.03) return 'C';
  if (pan < 0) return `L${Math.round(Math.abs(pan) * 100)}`;
  return `R${Math.round(pan * 100)}`;
}

export const MultitrackMixer: React.FC<MultitrackMixerProps> = ({
  project,
  meters,
  onToggleTrackMute,
  onToggleTrackSolo,
  onChangeTrackGain,
  onChangeTrackPan,
  onChangeTrackBus,
  onChangeClickGain,
  onChangeClickSubdivision,
  onToggleClick,
  onChangeGuideGain,
  onToggleGuide,
  onToggleGuideVoice,
  onChangeMasterGain,
  onResetMixer,
}) => {
  const anySolo = project.tracks.some((t) => t.soloed);

  return (
    <div className="flex-1 flex flex-col bg-[#0B0F17] p-6 overflow-y-auto select-none">
      {/* Mixer Console Header */}
      <div className="flex flex-wrap items-center justify-between gap-4 mb-6">
        <div>
          <h1 className="font-display text-xl font-bold text-slate-100">
            Consola Mezcladora Multipista y Buses de Escenario
          </h1>
          <p className="text-xs text-slate-400 mt-0.5">
            Ajusta niveles individuales, paneo estéreo y ruteo independiente hacia Main L/R o Bus de Monitoreo (Click & Cues).
          </p>
        </div>

        <button
          type="button"
          onClick={onResetMixer}
          className="px-3.5 py-2 rounded-lg bg-slate-900 hover:bg-slate-800 border border-slate-800 text-xs font-medium text-slate-300 hover:text-white flex items-center gap-1.5 transition-colors cursor-pointer"
        >
          <RotateCcw className="w-3.5 h-3.5" />
          <span>Restablecer Mezcla Nominal (0 dB)</span>
        </button>
      </div>

      {/* Horizontal Scrollable Console Strips */}
      <div className="flex-1 flex items-stretch gap-3 overflow-x-auto pb-2">
        {/* Track Channel Strips */}
        {project.tracks.map((track: TrackChannel, idx: number) => {
          const isAudible = anySolo ? track.soloed && !track.muted : !track.muted;
          const meter = meters.tracks[track.id] || { rms: 0, peak: 0, clipping: false };

          return (
            <div
              key={track.id}
              className="w-40 shrink-0 bg-[#111827] border border-slate-800 rounded-xl p-3.5 flex flex-col justify-between"
            >
              {/* Strip Top: Channel Number & Name */}
              <div>
                <div className="flex items-center justify-between text-[11px] font-mono tabular-nums text-slate-400 mb-1">
                  <span>CH {String(idx + 1).padStart(2, '0')}</span>
                  <span
                    style={{ backgroundColor: track.color }}
                    className="w-2.5 h-2.5 rounded-xs"
                  />
                </div>
                <div
                  className="font-display text-sm font-semibold text-slate-100 truncate"
                  title={track.name}
                >
                  {track.name}
                </div>
              </div>

              {/* Pan Control */}
              <div className="my-3 bg-[#0B0F17] border border-slate-800/80 rounded-lg p-2">
                <div className="flex items-center justify-between text-[11px] text-slate-400 mb-1">
                  <span>Pan</span>
                  <span className="font-mono tabular-nums text-slate-200 font-medium">
                    {formatPan(track.pan)}
                  </span>
                </div>
                <input
                  type="range"
                  aria-label={`Paneo ${track.name}`}
                  min={-1}
                  max={1}
                  step={0.05}
                  value={track.pan}
                  onDoubleClick={() => onChangeTrackPan(track.id, 0)}
                  onChange={(e) => onChangeTrackPan(track.id, Number(e.target.value))}
                  className="w-full accent-cyan-400 h-1.5 bg-slate-800 rounded cursor-pointer"
                />
              </div>

              {/* Vertical Fader + Dual VU Meter Area */}
              <div className="flex-1 flex items-center justify-center gap-4 my-2 min-h-[180px] bg-[#0B0F17] border border-slate-800/80 rounded-lg p-3">
                {/* Range Fader */}
                <div className="h-40 flex items-center justify-center">
                  <input
                    type="range"
                    aria-label={`Fader ${track.name}`}
                    min={0}
                    max={1.25}
                    step={0.01}
                    value={track.gain}
                    onChange={(e) => onChangeTrackGain(track.id, Number(e.target.value))}
                    className="w-36 -rotate-90 accent-cyan-400 bg-slate-800 h-2 rounded-lg cursor-pointer"
                  />
                </div>

                {/* Vertical VU Meter Bar with dB Scale */}
                <div className="h-40 flex items-center gap-1.5">
                  <div className="w-3 h-full bg-slate-900 rounded-xs overflow-hidden flex flex-col justify-end border border-slate-800">
                    <div
                      style={{
                        height: `${isAudible ? Math.min(100, meter.rms * 100) : 0}%`,
                      }}
                      className={`w-full transition-all duration-75 ${
                        meter.clipping
                          ? 'bg-red-500'
                          : meter.rms > 0.78
                          ? 'bg-amber-400'
                          : 'bg-emerald-400'
                      }`}
                    />
                  </div>
                  <div className="h-full flex flex-col justify-between text-[9px] font-mono tabular-nums text-slate-500">
                    <span>+2</span>
                    <span>0</span>
                    <span>-6</span>
                    <span>-18</span>
                    <span>-∞</span>
                  </div>
                </div>
              </div>

              {/* dB Numeric Display */}
              <div className="text-center font-mono tabular-nums text-xs font-semibold text-slate-200 bg-[#0B0F17] border border-slate-800 py-1 rounded mb-2.5">
                {gainToDbString(track.gain)}
              </div>

              {/* Mute / Solo / Output Bus Controls */}
              <div className="space-y-2">
                <div className="grid grid-cols-2 gap-1.5">
                  <button
                    type="button"
                    onClick={() => onToggleTrackMute(track.id)}
                    className={`py-1.5 rounded text-xs font-mono font-bold transition-colors cursor-pointer ${
                      track.muted
                        ? 'bg-red-500 text-slate-950'
                        : 'bg-slate-800 text-slate-300 hover:bg-slate-700'
                    }`}
                  >
                    MUTE
                  </button>
                  <button
                    type="button"
                    onClick={() => onToggleTrackSolo(track.id)}
                    className={`py-1.5 rounded text-xs font-mono font-bold transition-colors cursor-pointer ${
                      track.soloed
                        ? 'bg-amber-400 text-slate-950'
                        : 'bg-slate-800 text-slate-300 hover:bg-slate-700'
                    }`}
                  >
                    SOLO
                  </button>
                </div>

                <div>
                  <label className="block text-[10px] text-slate-400 mb-1">
                    Bus de Salida
                  </label>
                  <select
                    value={track.bus}
                    onChange={(e) =>
                      onChangeTrackBus(track.id, e.target.value as OutputBus)
                    }
                    className="w-full bg-[#0B0F17] border border-slate-800 rounded px-2 py-1 text-xs text-slate-200 focus:outline-none focus:border-cyan-500 cursor-pointer"
                  >
                    <option value="main">Main L/R</option>
                    <option value="cue-click">Click / Cue Bus</option>
                    <option value="both">Main + Cue</option>
                  </select>
                </div>
              </div>
            </div>
          );
        })}

        {/* Divider between Tracks and Dedicated Stage Buses */}
        <div className="w-px bg-slate-800 mx-1 shrink-0" />

        {/* Dedicated CLICK & METRONOME Bus Strip */}
        <div className="w-44 shrink-0 bg-[#111827] border border-cyan-500/30 rounded-xl p-3.5 flex flex-col justify-between">
          <div>
            <div className="flex items-center justify-between text-[11px] font-mono text-cyan-400 mb-1">
              <span>BUS AUX 01</span>
              <Volume2 className="w-3.5 h-3.5" />
            </div>
            <div className="font-display text-sm font-semibold text-slate-100">
              Click / Metrónomo
            </div>
          </div>

          <div className="my-3 bg-[#0B0F17] border border-slate-800 rounded-lg p-2">
            <div className="text-[11px] text-slate-400 mb-1.5">Subdivisión</div>
            <div className="grid grid-cols-2 gap-1">
              <button
                type="button"
                onClick={() => onChangeClickSubdivision(1)}
                className={`py-1 rounded text-xs font-mono font-medium cursor-pointer ${
                  project.clickSubdivision === 1
                    ? 'bg-cyan-500/20 text-cyan-300 border border-cyan-500/40'
                    : 'bg-slate-900 text-slate-400'
                }`}
              >
                1/4 Negra
              </button>
              <button
                type="button"
                onClick={() => onChangeClickSubdivision(2)}
                className={`py-1 rounded text-xs font-mono font-medium cursor-pointer ${
                  project.clickSubdivision === 2
                    ? 'bg-cyan-500/20 text-cyan-300 border border-cyan-500/40'
                    : 'bg-slate-900 text-slate-400'
                }`}
              >
                1/8 Corchea
              </button>
            </div>
          </div>

          <div className="flex-1 flex items-center justify-center my-2 min-h-[180px] bg-[#0B0F17] border border-slate-800 rounded-lg p-3">
            <input
              type="range"
              aria-label="Volumen Click"
              min={0}
              max={1.25}
              step={0.01}
              value={project.clickGain}
              onChange={(e) => onChangeClickGain(Number(e.target.value))}
              className="w-36 -rotate-90 accent-cyan-400 bg-slate-800 h-2 rounded-lg cursor-pointer"
            />
          </div>

          <div className="text-center font-mono tabular-nums text-xs font-semibold text-cyan-300 bg-[#0B0F17] border border-slate-800 py-1 rounded mb-2.5">
            {gainToDbString(project.clickGain)}
          </div>

          <button
            type="button"
            onClick={onToggleClick}
            className={`w-full py-2 rounded-lg text-xs font-semibold transition-colors cursor-pointer ${
              project.clickEnabled
                ? 'bg-cyan-400 text-slate-950'
                : 'bg-slate-800 text-slate-400 hover:text-white'
            }`}
          >
            {project.clickEnabled ? 'CLICK ACTIVO' : 'CLICK SILENCIADO'}
          </button>
        </div>

        {/* Dedicated GUIDE CUES Bus Strip */}
        <div className="w-44 shrink-0 bg-[#111827] border border-cyan-500/30 rounded-xl p-3.5 flex flex-col justify-between">
          <div>
            <div className="flex items-center justify-between text-[11px] font-mono text-cyan-400 mb-1">
              <span>BUS AUX 02</span>
              <Mic className="w-3.5 h-3.5" />
            </div>
            <div className="font-display text-sm font-semibold text-slate-100">
              Guía Vocal / Cues
            </div>
          </div>

          <div className="my-3 bg-[#0B0F17] border border-slate-800 rounded-lg p-2">
            <div className="text-[11px] text-slate-400 mb-1.5">Anuncio Hablado</div>
            <button
              type="button"
              onClick={onToggleGuideVoice}
              className={`w-full py-1 rounded text-xs font-medium cursor-pointer border ${
                project.guideVoiceReadout
                  ? 'bg-cyan-500/20 text-cyan-300 border-cyan-500/40'
                  : 'bg-slate-900 text-slate-400 border-slate-800'
              }`}
            >
              {project.guideVoiceReadout ? 'Voz + Tono Guía' : 'Solo Tono Estudio'}
            </button>
          </div>

          <div className="flex-1 flex items-center justify-center my-2 min-h-[180px] bg-[#0B0F17] border border-slate-800 rounded-lg p-3">
            <input
              type="range"
              aria-label="Volumen Guía"
              min={0}
              max={1.25}
              step={0.01}
              value={project.guideGain}
              onChange={(e) => onChangeGuideGain(Number(e.target.value))}
              className="w-36 -rotate-90 accent-cyan-400 bg-slate-800 h-2 rounded-lg cursor-pointer"
            />
          </div>

          <div className="text-center font-mono tabular-nums text-xs font-semibold text-cyan-300 bg-[#0B0F17] border border-slate-800 py-1 rounded mb-2.5">
            {gainToDbString(project.guideGain)}
          </div>

          <button
            type="button"
            onClick={onToggleGuide}
            className={`w-full py-2 rounded-lg text-xs font-semibold transition-colors cursor-pointer ${
              project.guideCuesEnabled
                ? 'bg-cyan-400 text-slate-950'
                : 'bg-slate-800 text-slate-400 hover:text-white'
            }`}
          >
            {project.guideCuesEnabled ? 'CUES ACTIVOS' : 'CUES SILENCIADOS'}
          </button>
        </div>

        {/* MASTER L/R Output Bus Strip */}
        <div className="w-48 shrink-0 bg-[#111827] border border-emerald-500/40 rounded-xl p-3.5 flex flex-col justify-between">
          <div>
            <div className="flex items-center justify-between text-[11px] font-mono text-emerald-400 mb-1">
              <span>MASTER BUS</span>
              <Sliders className="w-3.5 h-3.5" />
            </div>
            <div className="font-display text-sm font-bold text-slate-100">
              Main Output L/R
            </div>
          </div>

          <div className="my-3 bg-[#0B0F17] border border-slate-800 rounded-lg p-2 text-[11px] text-slate-400">
            Modo:{' '}
            <strong className="text-slate-200">
              {project.splitRoutingMode === 'split-mono'
                ? 'Split Mono (L:Cue / R:Main)'
                : 'Estéreo Completo'}
            </strong>
          </div>

          <div className="flex-1 flex items-center justify-center gap-4 my-2 min-h-[180px] bg-[#0B0F17] border border-slate-800 rounded-lg p-3">
            <div className="h-40 flex items-center justify-center">
              <input
                type="range"
                aria-label="Volumen Master"
                min={0}
                max={1.25}
                step={0.01}
                value={project.masterGain}
                onChange={(e) => onChangeMasterGain(Number(e.target.value))}
                className="w-36 -rotate-90 accent-emerald-400 bg-slate-800 h-2 rounded-lg cursor-pointer"
              />
            </div>

            <div className="h-40 w-4 bg-slate-900 rounded-xs overflow-hidden flex flex-col justify-end border border-slate-800">
              <div
                style={{
                  height: `${Math.min(100, meters.master.rms * 100)}%`,
                }}
                className={`w-full transition-all duration-75 ${
                  meters.master.clipping
                    ? 'bg-red-500'
                    : meters.master.rms > 0.8
                    ? 'bg-amber-400'
                    : 'bg-emerald-400'
                }`}
              />
            </div>
          </div>

          <div className="text-center font-mono tabular-nums text-xs font-bold text-emerald-400 bg-[#0B0F17] border border-slate-800 py-1.5 rounded">
            {gainToDbString(project.masterGain)}
          </div>
        </div>
      </div>
    </div>
  );
};
