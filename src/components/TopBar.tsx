import React from 'react';
import { AudioLines, Plus } from 'lucide-react';

export type WorkspaceView = 'setlist' | 'live' | 'arranger' | 'mixer' | 'library';

interface TopBarProps {
  activeView: WorkspaceView;
  setlistCount: number;
  remoteTriggerRef?: React.Ref<HTMLSpanElement>;
  audioTriggerRef?: React.Ref<HTMLSpanElement>;
  onSelectView: (view: WorkspaceView) => void;
  onOpenImportModal: () => void;
}

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
  remoteTriggerRef,
  audioTriggerRef,
  onSelectView,
  onOpenImportModal,
}) => {
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
        <button type="button" onClick={onOpenImportModal} className="lt-primary">
          <Plus size={16} /> Importar
        </button>
      </div>
    </header>
  );
};
