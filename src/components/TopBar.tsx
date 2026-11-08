import React from 'react';
import { ListMusic, Cpu, HardDrive } from 'lucide-react';
import { AudioEngineMode } from '../types/project';

export type WorkspaceView = 'setlist' | 'arranger' | 'mixer' | 'remote' | 'library';

interface TopBarProps {
  activeView: WorkspaceView;
  setlistCount: number;
  engineMode: AudioEngineMode;
  ramBudgetMB: number;
  cachedRamMB: number;
  onChangeEngineMode: (mode: AudioEngineMode) => void;
  onChangeRamBudgetMB: (mb: number) => void;
  onSelectView: (view: WorkspaceView) => void;
  onOpenImportModal: () => void;
}

const RAM_BUDGET_PRESETS = [400, 800, 1200, 1600, 2400, 3200];

export const TopBar: React.FC<TopBarProps> = ({
  activeView,
  setlistCount,
  engineMode,
  ramBudgetMB,
  cachedRamMB,
  onChangeEngineMode,
  onChangeRamBudgetMB,
  onSelectView,
  onOpenImportModal,
}) => {
  const navItems: { id: WorkspaceView; label: string; badge?: number }[] = [
    { id: 'setlist', label: 'Setlist', badge: setlistCount },
    { id: 'arranger', label: 'Arranger (DAW)' },
    { id: 'mixer', label: 'Mixer' },
    { id: 'remote', label: 'Stage Remote' },
    { id: 'library', label: 'Biblioteca' },
  ];

  const budgetOptions = RAM_BUDGET_PRESETS.includes(ramBudgetMB)
    ? RAM_BUDGET_PRESETS
    : [...RAM_BUDGET_PRESETS, ramBudgetMB].sort((a, b) => a - b);

  return (
    <header className="flex items-center justify-between gap-4 px-5 py-2 bg-[#0B0F17] border-b border-slate-800/90 select-none">
      {/* Zone 1: Brand Wordmark */}
      <a
        href="#setlist"
        onClick={(e) => {
          e.preventDefault();
          onSelectView('setlist');
        }}
        className="font-display text-lg font-bold tracking-tight text-slate-100 whitespace-nowrap shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500 rounded"
      >
        LibreTracks
      </a>

      {/* Zone 2: Navigation Links including Dedicated Setlist Page */}
      <nav aria-label="Navegación Principal" className="flex items-center gap-4 text-sm font-medium">
        {navItems.map((item) => {
          const isActive = activeView === item.id;
          const isSetlistTab = item.id === 'setlist';
          return (
            <a
              key={item.id}
              href={`#${item.id}`}
              onClick={(e) => {
                e.preventDefault();
                onSelectView(item.id);
              }}
              className={`whitespace-nowrap shrink-0 py-1 px-2 rounded-md transition-colors flex items-center gap-1.5 ${
                isActive
                  ? isSetlistTab
                    ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/50 font-semibold'
                    : 'text-cyan-400 border-b-2 border-cyan-400 font-semibold rounded-none'
                  : 'text-slate-400 hover:text-slate-100'
              }`}
            >
              {isSetlistTab && <ListMusic className="w-3.5 h-3.5" />}
              <span>{item.label}</span>
              {typeof item.badge === 'number' && item.badge > 0 && (
                <span className="px-1.5 py-0.2 rounded-full bg-emerald-500/25 text-emerald-300 font-mono text-[10px] font-bold">
                  {item.badge}
                </span>
              )}
            </a>
          );
        })}
      </nav>

      {/* Zone 3: Engine Mode ('buffer' | 'stream'), RAM Budget & Primary Import Action */}
      <div className="flex items-center gap-2.5 shrink-0">
        {/* Engine Mode Switch ('buffer' | 'stream') */}
        <div
          title="Modo del motor de audio: 'buffer' (AudioBuffer en RAM) o 'stream' (OPFS PCM por ventanas; si una canción no tiene PCM generado, usa 'buffer' automáticamente)"
          className="flex items-center gap-1 bg-[#12161f] border border-slate-800 rounded-lg px-2 py-1 text-[11px]"
        >
          <Cpu className="w-3.5 h-3.5 text-cyan-400 shrink-0" />
          <span className="text-[10px] uppercase tracking-wider text-slate-400 font-mono">
            Motor:
          </span>
          <div className="flex items-center rounded bg-[#0B0F17] p-0.5 border border-slate-800/80">
            <button
              type="button"
              onClick={() => onChangeEngineMode('buffer')}
              className={`px-1.5 py-0.5 rounded text-[10px] font-mono font-semibold cursor-pointer transition-colors ${
                engineMode === 'buffer'
                  ? 'bg-cyan-500/25 text-cyan-300 border border-cyan-500/40'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              Buffer
            </button>
            <button
              type="button"
              onClick={() => onChangeEngineMode('stream')}
              className={`px-1.5 py-0.5 rounded text-[10px] font-mono font-semibold cursor-pointer transition-colors ${
                engineMode === 'stream'
                  ? 'bg-emerald-500/25 text-emerald-300 border border-emerald-500/40'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              Stream
            </button>
          </div>
        </div>

        {/* RAM Budget Selector (ramBudgetMB) & Live Cached MB */}
        <div
          title={`Presupuesto máximo de caché RAM (MAX_CACHE_BYTES). Uso actual: ${cachedRamMB.toFixed(0)} MB de ${ramBudgetMB} MB.`}
          className="flex items-center gap-1.5 bg-[#12161f] border border-slate-800 rounded-lg px-2.5 py-1 text-[11px]"
        >
          <HardDrive className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
          <span className="font-mono text-[10px] text-slate-300">
            RAM:{' '}
            <strong className="text-emerald-300">{cachedRamMB.toFixed(0)}</strong>
            <span className="text-slate-500"> / </span>
          </span>
          <select
            aria-label="Presupuesto de RAM (MB)"
            value={ramBudgetMB}
            onChange={(e) => onChangeRamBudgetMB(Number(e.target.value))}
            className="bg-[#0B0F17] border border-slate-800 rounded px-1.5 py-0.5 font-mono text-[10px] font-semibold text-cyan-300 focus:outline-none cursor-pointer"
          >
            {budgetOptions.map((mb) => (
              <option key={mb} value={mb} className="bg-[#12161f] text-slate-100">
                {mb} MB
              </option>
            ))}
          </select>
        </div>

        <button
          type="button"
          onClick={onOpenImportModal}
          className="px-3.5 py-1.5 text-xs font-semibold text-slate-950 bg-cyan-400 hover:bg-cyan-300 active:scale-[0.99] rounded-lg transition-all whitespace-nowrap shrink-0 cursor-pointer"
        >
          Importar Stems
        </button>
      </div>
    </header>
  );
};

