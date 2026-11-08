import React from 'react';
import { ListMusic } from 'lucide-react';

export type WorkspaceView = 'setlist' | 'arranger' | 'mixer' | 'remote' | 'library';

interface TopBarProps {
  activeView: WorkspaceView;
  setlistCount: number;
  onSelectView: (view: WorkspaceView) => void;
  onOpenImportModal: () => void;
}

export const TopBar: React.FC<TopBarProps> = ({
  activeView,
  setlistCount,
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

  return (
    <header className="flex items-center justify-between gap-6 px-5 py-2.5 bg-[#0B0F17] border-b border-slate-800/90 select-none">
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
      <nav aria-label="Navegación Principal" className="flex items-center gap-5 text-sm font-medium">
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

      {/* Zone 3: Primary Import Action */}
      <div className="flex items-center shrink-0">
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
