import React from 'react';

export type WorkspaceView = 'arranger' | 'mixer' | 'remote' | 'library';

interface TopBarProps {
  activeView: WorkspaceView;
  onSelectView: (view: WorkspaceView) => void;
  onOpenImportModal: () => void;
}

export const TopBar: React.FC<TopBarProps> = ({
  activeView,
  onSelectView,
  onOpenImportModal,
}) => {
  const navItems: { id: WorkspaceView; label: string }[] = [
    { id: 'arranger', label: 'Arranger' },
    { id: 'mixer', label: 'Mixer' },
    { id: 'remote', label: 'Stage Remote' },
    { id: 'library', label: 'Library' },
  ];

  return (
    <header className="flex items-center justify-between gap-8 px-6 py-3 bg-white dark:bg-[#0B0F17] border-b border-slate-200 dark:border-slate-800/90 select-none">
      {/* Zone 1: Single text element wordmark */}
      <a
        href="#arranger"
        onClick={(e) => {
          e.preventDefault();
          onSelectView('arranger');
        }}
        className="font-display text-lg font-bold tracking-tight text-slate-900 dark:text-slate-100 whitespace-nowrap shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 rounded"
      >
        LibreTracks
      </a>

      {/* Zone 2: 4 concise single-line text navigation links */}
      <nav aria-label="Navegación Principal" className="flex items-center gap-6 text-sm font-medium">
        {navItems.map((item) => {
          const isActive = activeView === item.id;
          return (
            <a
              key={item.id}
              href={`#${item.id}`}
              onClick={(e) => {
                e.preventDefault();
                onSelectView(item.id);
              }}
              className={`whitespace-nowrap shrink-0 py-1 transition-colors border-b-2 ${
                isActive
                  ? 'text-sky-600 dark:text-cyan-400 border-sky-600 dark:border-cyan-400 font-semibold'
                  : 'text-slate-600 dark:text-slate-400 border-transparent hover:text-slate-900 dark:hover:text-slate-100 hover:border-slate-300 dark:hover:border-slate-600'
              }`}
            >
              {item.label}
            </a>
          );
        })}
      </nav>

      {/* Zone 3: 1 primary action */}
      <div className="flex items-center shrink-0">
        <button
          type="button"
          onClick={onOpenImportModal}
          className="px-4 py-2 text-xs font-semibold text-white dark:text-slate-950 bg-sky-600 dark:bg-cyan-400 hover:bg-sky-500 dark:hover:bg-cyan-300 active:scale-[0.99] rounded-lg transition-all whitespace-nowrap shrink-0 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500"
        >
          Import Stems
        </button>
      </div>
    </header>
  );
};
