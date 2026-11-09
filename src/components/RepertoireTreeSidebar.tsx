import React, { useMemo, useRef, useState } from 'react';
import {
  Search,
  FolderOpen,
  Music,
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
        aria-label="Repertorio Colapsado"
        className="w-9 shrink-0 bg-[#111827] border-r border-slate-800 flex flex-col items-center py-2 gap-2 select-none"
      >
        <button
          type="button"
          onClick={onToggleCollapse}
          title="Expandir Repertorio"
          className="p-1.5 rounded text-slate-300 hover:bg-slate-800 cursor-pointer"
        >
          <PanelLeftOpen className="w-3.5 h-3.5" />
        </button>

        <button
          type="button"
          onClick={() => multiFileInputRef.current?.click()}
          title="Importar Nueva Canción (Stems)"
          className="p-1.5 rounded bg-cyan-400 text-slate-950 hover:bg-cyan-300 cursor-pointer"
        >
          <Upload className="w-3.5 h-3.5" />
        </button>

        <button
          type="button"
          onClick={() => folderInputRef.current?.click()}
          title="Importar Carpeta de Canción"
          className="p-1.5 rounded bg-slate-800 text-cyan-400 hover:bg-slate-700 border border-slate-700 cursor-pointer"
        >
          <FolderPlus className="w-3.5 h-3.5" />
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
    e.dataTransfer.setData('application/x-libretracks-song-id', song.id);
    e.dataTransfer.effectAllowed = 'copyMove';
  };

  return (
    <aside
      aria-label="Árbol de Repertorio"
      className="w-52 shrink-0 bg-[#111827] border-r border-slate-800 flex flex-col h-full select-none"
    >
      {/* Compact Sidebar Header */}
      <div className="px-2.5 py-1.5 border-b border-slate-800 flex items-center justify-between shrink-0">
        <span className="font-display text-[11px] font-bold text-slate-200 flex items-center gap-1">
          <FolderOpen className="w-3 h-3 text-cyan-400" />
          <span>Repertorio ({projects.length})</span>
        </span>

        <div className="flex items-center gap-0.5">
          <button
            type="button"
            onClick={onOpenNewSongModal}
            title="Crear canción vacía o gestionar biblioteca"
            className="p-1 rounded hover:bg-slate-800 text-slate-400 hover:text-slate-200 cursor-pointer"
          >
            <Plus className="w-3 h-3" />
          </button>
          <button
            type="button"
            onClick={onToggleCollapse}
            title="Colapsar panel lateral"
            className="p-1 rounded hover:bg-slate-800 text-slate-400 hover:text-slate-200 cursor-pointer"
          >
            <PanelLeftClose className="w-3 h-3" />
          </button>
        </div>
      </div>

      {/* Compact Search + Import Triggers */}
      <div className="p-2 border-b border-slate-800 space-y-1.5 shrink-0">
        <div className="relative">
          <Search className="w-3 h-3 text-slate-400 absolute left-2 top-1/2 -translate-y-1/2 pointer-events-none" />
          <input
            type="search"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Buscar canción..."
            className="w-full bg-[#0B0F17] border border-slate-800 rounded pl-6 pr-2 py-1 text-[11px] text-slate-100 placeholder:text-slate-500 focus:outline-none focus:border-cyan-400"
          />
        </div>

        <div className="grid grid-cols-2 gap-1">
          <button
            type="button"
            onClick={() => multiFileInputRef.current?.click()}
            className="px-2 py-1 rounded bg-cyan-400 hover:bg-cyan-300 text-slate-950 text-[10px] font-bold flex items-center justify-center gap-1 transition-colors cursor-pointer"
            title="Selecciona los stems de una canción para guardarla en tu Repertorio"
          >
            <Upload className="w-2.5 h-2.5 shrink-0" />
            <span className="truncate">+ Stems</span>
          </button>

          <button
            type="button"
            onClick={() => folderInputRef.current?.click()}
            className="px-2 py-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 text-[10px] font-semibold flex items-center justify-center gap-1 transition-colors cursor-pointer"
            title="Selecciona una carpeta completa de stems para convertirla en una sola canción"
          >
            <FolderPlus className="w-2.5 h-2.5 shrink-0 text-cyan-400" />
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
      <div className="flex-1 overflow-y-auto p-1.5 space-y-1">
        {filteredProjects.length === 0 ? (
          <div className="px-2 py-5 text-center text-[11px] text-slate-500">
            Repertorio vacío. Usa <strong>+ Stems</strong> o <strong>Carpeta</strong> para importar.
          </div>
        ) : (
          filteredProjects.map((song) => {
            const isCurrent = song.id === currentProjectId;
            const isInSetlist = setlistQueue.some((s) => s.id === song.id);

            return (
              <div
                key={song.id}
                draggable
                onDragStart={(e) => handleSongDragStart(e, song)}
                onClick={() => onRequestSongAction(song)}
                title={`${song.title} — Clic para montar o arrastrar al Setlist`}
                className={`group flex items-center justify-between gap-1 px-2 py-1.5 rounded-md text-[11px] cursor-grab active:cursor-grabbing transition-colors select-none border ${
                  isCurrent
                    ? 'bg-cyan-500/15 text-cyan-200 font-semibold border-cyan-500/40'
                    : 'text-slate-300 border-transparent hover:bg-slate-800/80 hover:border-slate-700/80 hover:text-white'
                }`}
              >
                <div className="flex items-center gap-1 min-w-0 flex-1">
                  <GripVertical className="w-3 h-3 text-slate-600 group-hover:text-cyan-400 shrink-0" />
                  <Music
                    className={`w-3 h-3 shrink-0 ${
                      isCurrent ? 'text-cyan-400' : 'text-slate-500 group-hover:text-slate-300'
                    }`}
                  />
                  <div className="min-w-0 flex-1 leading-tight">
                    <div className="flex items-center gap-1">
                      <span className="truncate">{song.title}</span>
                    </div>
                    <div className="flex items-center gap-1 text-[9px] text-slate-500 font-normal">
                      <span className="font-mono tabular-nums">
                        {formatDurationMmSs(song.durationSec, song.totalBars, song.bpm)}
                      </span>
                      <span aria-hidden="true">·</span>
                      <span className="font-mono tabular-nums">{song.bpm}</span>
                      <span aria-hidden="true">·</span>
                      <span className="font-mono tabular-nums">{song.tracks.length}p</span>
                    </div>
                  </div>
                </div>

                {/* Quick Actions */}
                <div className="flex items-center gap-0.5 shrink-0">
                  {!isInSetlist ? (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        onAddToSetlist(song.id);
                      }}
                      title="Añadir al Setlist"
                      className="px-1 py-0.5 rounded bg-slate-800 hover:bg-emerald-500/20 text-slate-400 hover:text-emerald-300 border border-slate-700 text-[9px] font-semibold cursor-pointer"
                    >
                      +Set
                    </button>
                  ) : (
                    <span
                      title="En el Setlist"
                      className="px-1 py-0.2 rounded bg-emerald-500/15 text-emerald-300 border border-emerald-500/30 text-[8px] font-mono"
                    >
                      SET
                    </span>
                  )}

                  <div className="hidden group-hover:flex items-center">
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        onExportJson(song);
                      }}
                      title="Exportar configuración .libretracks.json"
                      className="p-0.5 rounded hover:bg-slate-700 text-slate-400 hover:text-slate-200 cursor-pointer"
                    >
                      <Download className="w-3 h-3" />
                    </button>

                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        onDeleteProject(song.id);
                      }}
                      title="Quitar de la biblioteca"
                      className="p-0.5 rounded hover:bg-red-500/20 text-slate-400 hover:text-red-400 cursor-pointer"
                    >
                      <Trash2 className="w-3 h-3" />
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
