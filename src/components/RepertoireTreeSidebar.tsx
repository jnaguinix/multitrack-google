import React, { useMemo, useState } from 'react';
import {
  Search,
  MoreHorizontal,
  Trash2,
  Download,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  GripVertical,
  RotateCcw,
  Edit3,
  ListX,
  ListPlus,
  Check,
} from 'lucide-react';
import { SongProject } from '../types/project';

interface RepertoireTreeSidebarProps {
  projects: SongProject[];
  setlistQueue: SongProject[];
  currentProjectId: string | null;
  isCollapsed: boolean;
  onToggleCollapse: () => void;
  onRequestSongAction: (project: SongProject) => void;
  onAddToSetlist: (projectId: string) => void;
  onRemoveFromSetlist?: (projectId: string) => void;
  onClearSetlist?: () => void;
  onEditMetadata?: (song: SongProject) => void;
  onDeleteProject: (projectId: string) => void;
  onExportJson: (project: SongProject) => void;
  onQuickImportNewSongFiles: (files: FileList | File[]) => void;
  onQuickImportNativeFolder?: (folderPath: string) => void;
  onQuickImportNativeFiles?: (filePaths: string[]) => void;
  onOpenNewSongModal: () => void;
}

function formatDurationMmSs(sec?: number, totalBars?: number, bpm?: number): string {
  const effectiveSec =
    sec && sec > 1 ? sec : ((totalBars || 24) * 4 * 60) / (bpm || 120);
  const mins = Math.floor(effectiveSec / 60);
  const rem = Math.floor(effectiveSec % 60);
  return `${String(mins).padStart(2, '0')}:${String(rem).padStart(2, '0')}`;
}

export const RepertoireTreeSidebar: React.FC<RepertoireTreeSidebarProps> = ({
  projects,
  setlistQueue,
  currentProjectId,
  isCollapsed,
  onToggleCollapse,
  onRequestSongAction,
  onAddToSetlist,
  onRemoveFromSetlist,
  onClearSetlist,
  onEditMetadata,
  onDeleteProject,
  onExportJson,
  onOpenNewSongModal,
}) => {
  const [searchQuery, setSearchQuery] = useState('');
  const [showClearConfirm, setShowClearConfirm] = useState(false);


  const filteredProjects = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return projects;
    return projects.filter((p) => {
      if (p.title.toLowerCase().includes(q)) return true;
      if (p.artist.toLowerCase().includes(q)) return true;
      if (p.keySignature.toLowerCase().includes(q)) return true;
      if (String(p.bpm).includes(q)) return true;
      return false;
    });
  }, [projects, searchQuery]);

  if (isCollapsed) {
    return (
      <aside
        aria-label="Biblioteca Colapsada"
        className="lt-repertoire-rail w-12 shrink-0 bg-studio-panel border-r border-neutral-800 flex flex-col items-center py-2.5 gap-2.5 select-none"
      >
        <button
          type="button"
          onClick={onToggleCollapse}
          title="Expandir Biblioteca"
          className="p-2 rounded-lg text-neutral-300 hover:bg-neutral-800 cursor-pointer"
        >
          <PanelLeftOpen className="w-4 h-4" />
        </button>
      </aside>
    );
  }

  const handleSongDragStart = (
    e: React.DragEvent<HTMLDivElement>,
    song: SongProject
  ) => {
    e.dataTransfer.setData('application/x-omnitracks-song-id', song.id);
    e.dataTransfer.effectAllowed = 'copyMove';
  };

  return (
    <aside
      aria-label="Biblioteca de Canciones"
      className="lt-repertoire shrink-0 bg-studio-panel border-r border-neutral-800 flex flex-col h-full select-none"
    >
      {/* Sidebar Header */}
      <div className="px-4 py-3.5 flex items-center justify-between shrink-0">
        <span className="text-sm font-semibold text-neutral-100 flex items-center gap-1.5 min-w-0">
          <span className="truncate">Biblioteca ({projects.length})</span>
          {setlistQueue.length > 0 && (
            <span
              title={`${setlistQueue.length} ${setlistQueue.length === 1 ? 'canción en la sesión de hoy' : 'canciones en la sesión de hoy'}`}
              className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-400 border border-emerald-500/30 shrink-0"
            >
              {setlistQueue.length} en set
            </span>
          )}
        </span>

        <div className="flex items-center gap-1 shrink-0">
          {setlistQueue.length > 0 && onClearSetlist && (
            <button
              type="button"
              onClick={() => setShowClearConfirm(true)}
              title={`Limpiar sesión actual (${setlistQueue.length} ${setlistQueue.length === 1 ? 'canción' : 'canciones'}). Se conservan en biblioteca.`}
              className="p-1 rounded hover:bg-neutral-800 text-neutral-400 hover:text-amber-400 cursor-pointer transition-colors"
            >
              <RotateCcw className="w-3.5 h-3.5" />
            </button>
          )}
          <button
            type="button"
            onClick={onOpenNewSongModal}
            title="Crear canción vacía o gestionar biblioteca"
            className="p-1 rounded hover:bg-neutral-800 text-neutral-300 hover:text-white cursor-pointer"
          >
            <Plus className="w-3.5 h-3.5" />
          </button>
          <button
            type="button"
            onClick={onToggleCollapse}
            title="Colapsar panel lateral"
            className="p-1 rounded hover:bg-neutral-800 text-neutral-300 hover:text-white cursor-pointer"
          >
            <PanelLeftClose className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Search + Import Triggers */}
      <div className="px-3 pb-3 space-y-2 shrink-0">
        <div className="relative">
          <Search className="w-3.5 h-3.5 text-neutral-400 absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
          <input
            type="search"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Buscar canción…" aria-label="Buscar canción en el repertorio"
            className="w-full bg-studio-ground border border-neutral-800 rounded-lg pl-8 pr-2.5 py-1.5 text-xs text-neutral-100 placeholder:text-neutral-400 focus:outline-none focus:border-studio-line"
          />
        </div>
      </div>

      {/* Scrollable Song List */}
      <div className="flex-1 overflow-y-auto p-2 space-y-1">
        {filteredProjects.length === 0 ? (
          <div className="px-3 py-6 text-center text-xs text-neutral-400">
            {projects.length ? 'No hay canciones que coincidan.' : 'Aún no tienes canciones en el repertorio.'}
          </div>
        ) : (
          filteredProjects.map((song, index) => {
            const isCurrent = song.id === currentProjectId;
            const isInSetlist = setlistQueue.some((s) => s.id === song.id);

            return (
              <div
                key={song.id}
                draggable
                onDragStart={(e) => handleSongDragStart(e, song)}
                onClick={() => onRequestSongAction(song)}
                title={`${song.title} — Clic para montar o arrastrar al Setlist`}
                className={`group flex items-center justify-between gap-1.5 px-2.5 py-2 rounded-lg text-[13px] cursor-grab active:cursor-grabbing transition-colors select-none border ${
                  isCurrent
                    ? 'bg-studio-strip text-studio-ink font-semibold border-studio-line'
                    : 'text-neutral-200 font-medium border-transparent hover:bg-neutral-800/80 hover:border-neutral-700/80 hover:text-white'
                }`}
              >
                <div className="flex items-center gap-1.5 min-w-0 flex-1">
                  <GripVertical className="w-3.5 h-3.5 text-neutral-400 group-hover:text-studio-ink shrink-0" />
                  <div className="min-w-0 flex-1 leading-snug">
                    <div className="flex items-center gap-1.5">
                      <span className="truncate">{song.title}</span>
                    </div>
                    <div className="flex flex-wrap items-center gap-x-1 text-[11px] text-neutral-400 font-normal">
                      <span className="tabular-nums">
                        {formatDurationMmSs(song.durationSec, song.totalBars, song.bpm)}
                      </span>
                      <span aria-hidden="true">·</span>
                      <span className="tabular-nums">{song.bpm} BPM</span>
                      <span aria-hidden="true">·</span>
                      <span className="tabular-nums">{song.tracks.length}p</span>
                    </div>
                  </div>
                </div>

                {/* Quick Actions */}
                <div className="flex items-center gap-1 shrink-0">
                  {!isInSetlist ? (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        onAddToSetlist(song.id);
                      }}
                      title="Añadir a la sesión (Setlist)"
                      className="px-1.5 py-0.5 rounded bg-neutral-800 hover:bg-studio-strip text-neutral-300 hover:text-studio-ink border border-neutral-700 text-[11px] font-semibold cursor-pointer"
                    >
                      +Set
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        onRemoveFromSetlist?.(song.id);
                      }}
                      title="En la sesión (Setlist). Clic para quitar de la sesión."
                      className="group/set px-1.5 py-0.5 rounded bg-emerald-500/10 hover:bg-red-500/20 border border-emerald-500/30 hover:border-red-500/40 text-[11px] font-bold cursor-pointer transition-colors"
                    >
                      <span className="text-emerald-400 group-hover/set:hidden">✓</span>
                      <span className="hidden group-hover/set:inline text-red-400">✕</span>
                    </button>
                  )}

                  <button type="button" popoverTarget={`repertoire-song-${index}`} aria-label={`Acciones de ${song.title}`} onClick={(event) => event.stopPropagation()} className="lt-control lt-queue-action">
                    <MoreHorizontal size={16} />
                  </button>
                  <div id={`repertoire-song-${index}`} popover="auto" className="lt-popover lt-library-actions space-y-1" onClick={(event) => event.stopPropagation()}>
                    {isInSetlist ? (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.currentTarget.closest<HTMLElement>('[popover]')?.hidePopover();
                          onRemoveFromSetlist?.(song.id);
                        }}
                        title="Quitar de la sesión actual (se conserva en la biblioteca)"
                        className="lt-control text-amber-400 hover:text-amber-300 w-full text-left flex items-center gap-1.5 cursor-pointer"
                      >
                        <ListX className="w-3.5 h-3.5" /> Quitar de la sesión
                      </button>
                    ) : (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.currentTarget.closest<HTMLElement>('[popover]')?.hidePopover();
                          onAddToSetlist(song.id);
                        }}
                        title="Añadir al Setlist de hoy"
                        className="lt-control w-full text-left flex items-center gap-1.5 cursor-pointer"
                      >
                        <ListPlus className="w-3.5 h-3.5" /> Añadir a la sesión
                      </button>
                    )}

                    {onEditMetadata && (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.currentTarget.closest<HTMLElement>('[popover]')?.hidePopover();
                          onEditMetadata(song);
                        }}
                        title="Editar metadatos de la canción"
                        className="lt-control w-full text-left flex items-center gap-1.5 cursor-pointer"
                      >
                        <Edit3 className="w-3.5 h-3.5" /> Editar metadatos
                      </button>
                    )}

                    <button
                      type="button"
                      onClick={(e) => {
                        e.currentTarget.closest<HTMLElement>('[popover]')?.hidePopover();
                        onExportJson(song);
                      }}
                      title="Exportar configuración omnitracks.project.json"
                      className="lt-control w-full text-left flex items-center gap-1.5 cursor-pointer"
                    >
                      <Download className="w-3.5 h-3.5" /> Exportar JSON
                    </button>

                    <button
                      type="button"
                      onClick={(e) => {
                        e.currentTarget.closest<HTMLElement>('[popover]')?.hidePopover();
                        onDeleteProject(song.id);
                      }}
                      title="Eliminar permanentemente de la biblioteca"
                      className="lt-control text-red-400 hover:text-red-300 w-full text-left flex items-center gap-1.5 cursor-pointer"
                    >
                      <Trash2 className="w-3.5 h-3.5" /> Eliminar de biblioteca
                    </button>
                  </div>
                </div>
              </div>
            );
          })
        )}
      </div>

      {/* Modal de confirmación para limpiar la sesión desde el lateral */}
      {showClearConfirm && (
        <div
          role="dialog"
          aria-modal="true"
          className="fixed inset-0 z-50 bg-black/75 flex items-center justify-center p-4"
        >
          <div className="bg-neutral-900 border border-neutral-700 rounded-2xl max-w-md w-full p-6 space-y-4 shadow-2xl">
            <div className="flex items-start gap-3">
              <div className="w-10 h-10 rounded-full bg-amber-500/20 text-amber-400 flex items-center justify-center shrink-0">
                <RotateCcw className="w-5 h-5" />
              </div>
              <div className="space-y-1">
                <h2 className="text-base font-bold text-neutral-100">
                  ¿Limpiar las canciones de la sesión?
                </h2>
                <p className="text-sm text-neutral-300">
                  Se quitarán todas las canciones ({setlistQueue.length}) de la sesión de hoy y se liberará su memoria caché.
                </p>
                <p className="text-xs text-emerald-400 font-medium">
                  Todas las canciones permanecerán guardadas intactas en tu biblioteca permanente.
                </p>
              </div>
            </div>
            <div className="flex items-center justify-end gap-3 pt-2">
              <button
                type="button"
                onClick={() => setShowClearConfirm(false)}
                className="px-4 py-2 rounded-xl bg-neutral-800 hover:bg-neutral-700 text-sm font-semibold text-neutral-200 cursor-pointer"
              >
                Cancelar
              </button>
              <button
                type="button"
                onClick={() => {
                  setShowClearConfirm(false);
                  onClearSetlist?.();
                }}
                className="px-4 py-2 rounded-xl bg-amber-600 hover:bg-amber-500 text-sm font-semibold text-neutral-950 cursor-pointer"
              >
                Sí, limpiar sesión
              </button>
            </div>
          </div>
        </div>
      )}
    </aside>
  );
};
