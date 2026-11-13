import React from 'react';
import { AudioLines, Plus, Settings2 } from 'lucide-react';
import { AudioEngineMode } from '../types/project';

export type WorkspaceView = 'setlist' | 'live' | 'arranger' | 'mixer' | 'library';

interface TopBarProps {
  activeView: WorkspaceView;
  setlistCount: number;
  engineMode: AudioEngineMode;
  ramBudgetMB: number;
  cachedRamMB: number;
  remoteTriggerRef?: React.Ref<HTMLSpanElement>;
  audioTriggerRef?: React.Ref<HTMLSpanElement>;
  onChangeEngineMode: (mode: AudioEngineMode) => void;
  onChangeRamBudgetMB: (mb: number) => void;
  onSelectView: (view: WorkspaceView) => void;
  onOpenImportModal: () => void;
}

const RAM_BUDGET_PRESETS = [400, 800, 1200, 1600, 2400, 3200];
const NAV_ITEMS: { id: WorkspaceView; label: string }[] = [
  { id: 'setlist', label: 'Setlist' },
  { id: 'live', label: 'En vivo' },
  { id: 'arranger', label: 'Arreglo' },
  { id: 'mixer', label: 'Mezcla' },
  { id: 'library', label: 'Biblioteca' },
];

export const TopBar: React.FC<TopBarProps> = ({
  activeView,
  setlistCount,
  engineMode,
  ramBudgetMB,
  cachedRamMB,
  remoteTriggerRef,
  audioTriggerRef,
  onChangeEngineMode,
  onChangeRamBudgetMB,
  onSelectView,
  onOpenImportModal,
}) => {
  const budgetOptions = RAM_BUDGET_PRESETS.includes(ramBudgetMB)
    ? RAM_BUDGET_PRESETS
    : [...RAM_BUDGET_PRESETS, ramBudgetMB].sort((a, b) => a - b);

  return (
    <header className="lt-topbar">
      <a href="#setlist" className="lt-brand" onClick={(event) => {
        event.preventDefault();
        onSelectView('setlist');
      }}>
        <AudioLines size={22} aria-hidden="true" />
        OmniTracks
      </a>

      <nav className="lt-nav" aria-label="Navegación principal">
        {NAV_ITEMS.map(({ id, label }) => (
          <a key={id} href={`#${id}`} aria-current={activeView === id ? 'page' : undefined} onClick={(event) => {
            event.preventDefault();
            onSelectView(id);
          }}>
            {label}
            {id === 'setlist' && setlistCount > 0 && <span className="lt-nav-count">{setlistCount}</span>}
          </a>
        ))}
      </nav>

      <div className="lt-header-actions">
        {remoteTriggerRef && <span ref={remoteTriggerRef} />}
        {audioTriggerRef && <span ref={audioTriggerRef} />}
        <button type="button" popoverTarget="audio-settings" className="lt-control lt-icon-control" aria-label="Motor de audio" title="Motor de audio">
          <Settings2 size={17} />
        </button>
        <section id="audio-settings" popover="auto" className="lt-popover space-y-3" aria-label="Motor de audio">
          <h2 className="text-sm font-semibold">Motor de audio</h2>
          <label className="lt-field">
            Reproducción
            <select value={engineMode} onChange={(event) => onChangeEngineMode(event.target.value as AudioEngineMode)}>
              <option value="buffer">Buffer · desde RAM</option>
              <option value="stream">Streaming · desde disco</option>
            </select>
          </label>
          <label className="lt-field">
            Presupuesto de RAM
            <select value={ramBudgetMB} onChange={(event) => onChangeRamBudgetMB(Number(event.target.value))}>
              {budgetOptions.map((mb) => <option key={mb} value={mb}>{mb} MB</option>)}
            </select>
          </label>
          <p className="text-xs text-neutral-400">{cachedRamMB.toFixed(0)} MB en caché</p>
        </section>
        <button type="button" onClick={onOpenImportModal} className="lt-primary">
          <Plus size={16} /> Importar
        </button>
      </div>
    </header>
  );
};
