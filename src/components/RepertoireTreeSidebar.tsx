import React, { useMemo, useRef, useState } from 'react';
import { pickAudioSources } from '../storage/sourceFiles';
import { isDesktopApp, pickNativeFiles, pickNativeFolder } from '../utils/nativeDialog';
import {
  Search,
  MoreHorizontal,
  Upload,
  FolderPlus,
  Trash2,
  Download,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  GripVertical,
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
  onDeleteProject,
  onExportJson,
  onQuickImportNewSongFiles,
  onQuickImportNativeFolder,
  onQuickImportNativeFiles,
  onOpenNewSongModal,
}) => {
  const [searchQuery, setSearchQuery] = useState('');

  const multiFileInputRef = useRef<HTMLInputElement | null>(null);
  const folderInputRef = useRef<HTMLInputElement | null>(null);

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

        <button
          type="button"
          onClick={() => {
            if (isDesktopApp()) {
              pickNativeFiles().then((paths) => {
                if (paths && paths.length > 0) onQuickImportNativeFiles?.(paths);
              });
              return;
            }
            pickAudioSources('files', multiFileInputRef.current, onQuickImportNewSongFiles);
          }}
          title="Importar Nueva Canción (Stems)"
          className="p-2 rounded-lg bg-studio-strip text-studio-ink hover:bg-neutral-700 cursor-pointer"
        >
          <Upload className="w-4 h-4" />
        </button>

        <button
          type="button"
          onClick={() => {
            if (isDesktopApp()) {
              pickNativeFolder().then((folder) => {
                if (folder) onQuickImportNativeFolder?.(folder);
              });
              return;
            }
            pickAudioSources('folder', folderInputRef.current, onQuickImportNewSongFiles);
          }}
          title="Importar Carpeta de Canción"
          className="p-2 rounded-lg bg-neutral-800 text-studio-ink hover:bg-neutral-700 border border-neutral-700 cursor-pointer"
        >
          <FolderPlus className="w-4 h-4" />
        </button>

        <input
          ref={multiFileInputRef}
          type="file"
          multiple
          accept="audio/*,.wav,.mp3,.ogg,.flac,.m4a,.aac,.webm,.opus,.aif,.aiff,.caf"
          className="hidden"
          onChange={(e) => {
            if (e.target.files && e.target.files.length > 0) {
              const files = Array.from(e.target.files);
              e.target.value = '';
              onQuickImportNewSongFiles(files);
            }
          }}
        />
        <input
          ref={folderInputRef}
          type="file"
          multiple
          // @ts-expect-error webkitdirectory is standard across browsers
          webkitdirectory=""
          directory=""
          className="hidden"
          onChange={(e) => {
            if (e.target.files && e.target.files.length > 0) {
              const files = Array.from(e.target.files);
              e.target.value = '';
              onQuickImportNewSongFiles(files);
            }
          }}
        />
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
        <span className="text-sm font-semibold text-neutral-100">
          <span>Biblioteca ({projects.length})</span>
        </span>

        <div className="flex items-center gap-1">
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

        <div className="grid grid-cols-2 gap-1.5">
          <button
            type="button"
            onClick={() => {
              if (isDesktopApp()) {
                pickNativeFiles().then((paths) => {
                  if (paths && paths.length > 0) onQuickImportNativeFiles?.(paths);
                });
                return;
              }
              pickAudioSources('files', multiFileInputRef.current, onQuickImportNewSongFiles);
            }}
            className="px-2.5 py-1.5 rounded-lg bg-studio-strip hover:bg-neutral-700 text-studio-ink text-xs font-semibold flex items-center justify-center gap-1.5 transition-colors cursor-pointer"
            title="Selecciona los stems de una canción para guardarla en tu Repertorio"
          >
            <Upload className="w-3.5 h-3.5 shrink-0" />
            <span className="truncate">Pistas</span>
          </button>

          <button
            type="button"
            onClick={() => {
              if (isDesktopApp()) {
                pickNativeFolder().then((folder) => {
                  if (folder) onQuickImportNativeFolder?.(folder);
                });
                return;
              }
              pickAudioSources('folder', folderInputRef.current, onQuickImportNewSongFiles);
            }}
            className="px-2.5 py-1.5 rounded-lg bg-neutral-800 hover:bg-neutral-700 text-neutral-100 border border-neutral-700 text-xs font-semibold flex items-center justify-center gap-1.5 transition-colors cursor-pointer"
            title="Selecciona una carpeta completa de stems para convertirla en una sola canción"
          >
            <FolderPlus className="w-3.5 h-3.5 shrink-0 text-studio-ink" />
            <span className="truncate">Carpeta</span>
          </button>
        </div>

        <input
          ref={multiFileInputRef}
          type="file"
          multiple
          accept="audio/*,.wav,.mp3,.ogg,.flac,.m4a,.aac,.webm,.opus,.aif,.aiff,.caf"
          className="hidden"
          onChange={(e) => {
            if (e.target.files && e.target.files.length > 0) {
              const files = Array.from(e.target.files);
              e.target.value = '';
              onQuickImportNewSongFiles(files);
            }
          }}
        />
        <input
          ref={folderInputRef}
          type="file"
          multiple
          // @ts-expect-error webkitdirectory is standard across browsers
          webkitdirectory=""
          directory=""
          className="hidden"
          onChange={(e) => {
            if (e.target.files && e.target.files.length > 0) {
              const files = Array.from(e.target.files);
              e.target.value = '';
              onQuickImportNewSongFiles(files);
            }
          }}
        />
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
                      title="Añadir al Setlist"
                      className="px-1.5 py-0.5 rounded bg-neutral-800 hover:bg-studio-strip text-neutral-300 hover:text-studio-ink border border-neutral-700 text-[11px] font-semibold cursor-pointer"
                    >
                      +Set
                    </button>
                  ) : (
                    <span
                      title="En el Setlist de hoy"
                      className="text-emerald-400 text-xs px-1.5 font-bold"
                    >
                      ✓
                    </span>
                  )}

                  <button type="button" popoverTarget={`repertoire-song-${index}`} aria-label={`Acciones de ${song.title}`} onClick={(event) => event.stopPropagation()} className="lt-control lt-queue-action">
                    <MoreHorizontal size={16} />
                  </button>
                  <div id={`repertoire-song-${index}`} popover="auto" className="lt-popover lt-library-actions space-y-1" onClick={(event) => event.stopPropagation()}>
                    {!isInSetlist && (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.currentTarget.closest<HTMLElement>('[popover]')?.hidePopover();
                          onAddToSetlist(song.id);
                        }}
                        title="Añadir al Setlist"
                        className="lt-control"
                      >
                        <Plus className="w-3.5 h-3.5" /> Añadir al Setlist
                      </button>
                    )}

                    <button
                      type="button"
                      onClick={(e) => {
                        e.currentTarget.closest<HTMLElement>('[popover]')?.hidePopover();
                        onExportJson(song);
                      }}
                      title="Exportar configuración omnitracks.project.json"
                      className="lt-control"
                    >
                      <Download className="w-3.5 h-3.5" /> Exportar JSON
                    </button>
                  </div>
                </div>
              </div>
            );
          })
        )}
      </div>
    </aside>
  );
};
