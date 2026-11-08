import React, { useMemo, useRef, useState } from 'react';
import {
  Search,
  Folder,
  FolderOpen,
  Music,
  Upload,
  FolderPlus,
  Star,
  Trash2,
  Download,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
} from 'lucide-react';
import { SongProject } from '../types/project';

interface RepertoireTreeSidebarProps {
  projects: SongProject[];
  currentProjectId: string;
  isCollapsed: boolean;
  onToggleCollapse: () => void;
  onSelectProject: (projectId: string) => void;
  onToggleSetlistStar: (projectId: string) => void;
  onDeleteProject: (projectId: string) => void;
  onExportJson: (project: SongProject) => void;
  onQuickImportNewSongFiles: (files: FileList) => void;
  onOpenNewSongModal: () => void;
}

export const RepertoireTreeSidebar: React.FC<RepertoireTreeSidebarProps> = ({
  projects,
  currentProjectId,
  isCollapsed,
  onToggleCollapse,
  onSelectProject,
  onToggleSetlistStar,
  onDeleteProject,
  onExportJson,
  onQuickImportNewSongFiles,
  onOpenNewSongModal,
}) => {
  const [searchQuery, setSearchQuery] = useState('');
  const [openFolders, setOpenFolders] = useState<Record<string, boolean>>({
    setlist: true,
    imported: true,
    demos: true,
  });

  const multiFileInputRef = useRef<HTMLInputElement | null>(null);
  const folderInputRef = useRef<HTMLInputElement | null>(null);

  const toggleFolder = (key: string) => {
    setOpenFolders((prev) => ({ ...prev, [key]: !prev[key] }));
  };

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

  const setlistSongs = useMemo(
    () => filteredProjects.filter((p) => p.inSetlist),
    [filteredProjects]
  );

  const importedSongs = useMemo(
    () =>
      filteredProjects.filter(
        (p) => !p.id.startsWith('demo-') || p.folder === 'imported'
      ),
    [filteredProjects]
  );

  const demoSongs = useMemo(
    () => filteredProjects.filter((p) => p.id.startsWith('demo-')),
    [filteredProjects]
  );

  if (isCollapsed) {
    return (
      <aside
        aria-label="Repertorio Colapsado"
        className="w-11 shrink-0 bg-[#111827] border-r border-slate-800 flex flex-col items-center py-3 gap-4 select-none"
      >
        <button
          type="button"
          onClick={onToggleCollapse}
          title="Expandir Árbol de Repertorio"
          className="p-2 rounded-lg text-slate-300 hover:bg-slate-800 cursor-pointer"
        >
          <PanelLeftOpen className="w-4 h-4" />
        </button>

        <button
          type="button"
          onClick={() => multiFileInputRef.current?.click()}
          title="Importar Nueva Canción (Stems)"
          className="p-2 rounded-lg bg-cyan-400 text-slate-950 hover:bg-cyan-300 cursor-pointer"
        >
          <Upload className="w-4 h-4" />
        </button>

        <input
          ref={multiFileInputRef}
          type="file"
          multiple
          accept="audio/*,.wav,.mp3,.ogg,.flac,.m4a"
          className="hidden"
          onChange={(e) => {
            if (e.target.files && e.target.files.length > 0) {
              onQuickImportNewSongFiles(e.target.files);
              e.target.value = '';
            }
          }}
        />
      </aside>
    );
  }

  const renderSongNode = (song: SongProject) => {
    const isCurrent = song.id === currentProjectId;

    return (
      <div
        key={song.id}
        onClick={() => onSelectProject(song.id)}
        className={`group flex items-center justify-between gap-2 px-2.5 py-2 rounded-lg text-xs cursor-pointer transition-colors select-none ${
          isCurrent
            ? 'bg-cyan-500/15 text-cyan-200 font-semibold border border-cyan-500/30'
            : 'text-slate-300 hover:bg-slate-800/70 hover:text-white'
        }`}
      >
        <div className="flex items-center gap-2 min-w-0 flex-1">
          <Music
            className={`w-3.5 h-3.5 shrink-0 ${
              isCurrent ? 'text-cyan-400' : 'text-slate-500 group-hover:text-slate-300'
            }`}
          />
          <div className="min-w-0 flex-1">
            <div className="truncate" title={song.title}>
              {song.title}
            </div>
            <div className="flex items-center gap-1.5 text-[10px] text-slate-500 font-normal">
              <span className="font-mono tabular-nums">{song.bpm} BPM</span>
              <span aria-hidden="true">·</span>
              <span>{song.keySignature}</span>
              <span aria-hidden="true">·</span>
              <span className="font-mono tabular-nums">{song.tracks.length} pistas</span>
            </div>
          </div>
        </div>

        {/* Quick Actions on Hover */}
        <div className="hidden group-hover:flex items-center gap-0.5 shrink-0">
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onToggleSetlistStar(song.id);
            }}
            title={
              song.inSetlist
                ? 'Quitar de Setlist en Vivo'
                : 'Fijar en Setlist en Vivo'
            }
            className={`p-1 rounded hover:bg-slate-700 cursor-pointer ${
              song.inSetlist ? 'text-amber-400' : 'text-slate-400'
            }`}
          >
            <Star className={`w-3.5 h-3.5 ${song.inSetlist ? 'fill-current' : ''}`} />
          </button>

          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onExportJson(song);
            }}
            title="Exportar configuración .libretracks.json"
            className="p-1 rounded hover:bg-slate-700 text-slate-400 hover:text-slate-200 cursor-pointer"
          >
            <Download className="w-3.5 h-3.5" />
          </button>

          {projects.length > 1 && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onDeleteProject(song.id);
              }}
              title="Quitar de la biblioteca (no borra tus archivos del disco)"
              className="p-1 rounded hover:bg-red-500/20 text-slate-400 hover:text-red-400 cursor-pointer"
            >
              <Trash2 className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      </div>
    );
  };

  return (
    <aside
      aria-label="Árbol de Repertorio y Biblioteca"
      className="w-68 shrink-0 bg-[#111827] border-r border-slate-800 flex flex-col h-full select-none"
    >
      {/* Sidebar Header */}
      <div className="px-3.5 py-2.5 border-b border-slate-800 flex items-center justify-between">
        <span className="font-display text-xs font-bold text-slate-200">
          Repertorio ({projects.length})
        </span>

        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={onOpenNewSongModal}
            title="Crear canción vacía o gestionar biblioteca"
            className="p-1 rounded hover:bg-slate-800 text-slate-400 hover:text-slate-200 cursor-pointer"
          >
            <Plus className="w-3.5 h-3.5" />
          </button>
          <button
            type="button"
            onClick={onToggleCollapse}
            title="Ocultar panel lateral"
            className="p-1 rounded hover:bg-slate-800 text-slate-400 hover:text-slate-200 cursor-pointer"
          >
            <PanelLeftClose className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Live Search Input */}
      <div className="p-2.5 border-b border-slate-800 space-y-2">
        <div className="relative">
          <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
          <input
            type="search"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Buscar canción en repertorio..."
            className="w-full bg-[#0B0F17] border border-slate-800 rounded-lg pl-8 pr-2.5 py-1.5 text-xs text-slate-100 placeholder:text-slate-500 focus:outline-none focus:border-cyan-400"
          />
        </div>

        {/* Instant New Song Import Triggers (Stems or Folder) */}
        <div className="grid grid-cols-2 gap-1.5">
          <button
            type="button"
            onClick={() => multiFileInputRef.current?.click()}
            className="px-2.5 py-1.5 rounded-lg bg-cyan-400 hover:bg-cyan-300 text-slate-950 text-[11px] font-semibold flex items-center justify-center gap-1.5 transition-colors cursor-pointer"
            title="Selecciona los stems de una canción para crearla automáticamente"
          >
            <Upload className="w-3 h-3 shrink-0" />
            <span className="truncate">Importar Stems</span>
          </button>

          <button
            type="button"
            onClick={() => folderInputRef.current?.click()}
            className="px-2.5 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 text-[11px] font-semibold flex items-center justify-center gap-1.5 transition-colors cursor-pointer"
            title="Selecciona una carpeta completa de stems para convertirla en una sola canción"
          >
            <FolderPlus className="w-3 h-3 shrink-0 text-cyan-400" />
            <span className="truncate">Carpeta</span>
          </button>
        </div>

        {/* Hidden File & Directory Inputs */}
        <input
          ref={multiFileInputRef}
          type="file"
          multiple
          accept="audio/*,.wav,.mp3,.ogg,.flac,.m4a"
          className="hidden"
          onChange={(e) => {
            if (e.target.files && e.target.files.length > 0) {
              onQuickImportNewSongFiles(e.target.files);
              e.target.value = '';
            }
          }}
        />
        <input
          ref={folderInputRef}
          type="file"
          multiple
          // @ts-expect-error webkitdirectory is standard across browsers for directory selection
          webkitdirectory="true"
          directory="true"
          className="hidden"
          onChange={(e) => {
            if (e.target.files && e.target.files.length > 0) {
              onQuickImportNewSongFiles(e.target.files);
              e.target.value = '';
            }
          }}
        />
      </div>

      {/* Scrollable Tree View: Folders -> Single Song Items Only */}
      <div className="flex-1 overflow-y-auto p-2 space-y-2.5">
        {/* 1. Setlist / Live Show Folder */}
        {setlistSongs.length > 0 && (
          <div>
            <button
              type="button"
              onClick={() => toggleFolder('setlist')}
              className="w-full flex items-center justify-between px-2 py-1 text-xs font-semibold text-slate-300 hover:text-white cursor-pointer"
            >
              <span className="flex items-center gap-1.5">
                {openFolders.setlist ? (
                  <FolderOpen className="w-3.5 h-3.5 text-amber-400" />
                ) : (
                  <Folder className="w-3.5 h-3.5 text-amber-400" />
                )}
                <span>Setlist en Vivo</span>
              </span>
              <span className="font-mono tabular-nums text-[10px] text-slate-500">
                {setlistSongs.length}
              </span>
            </button>
            {openFolders.setlist && (
              <div className="mt-1 pl-2 border-l border-slate-800/80 ml-2 space-y-0.5">
                {setlistSongs.map(renderSongNode)}
              </div>
            )}
          </div>
        )}

        {/* 2. Imported / Custom Repertoire Folder */}
        <div>
          <button
            type="button"
            onClick={() => toggleFolder('imported')}
            className="w-full flex items-center justify-between px-2 py-1 text-xs font-semibold text-slate-300 hover:text-white cursor-pointer"
          >
            <span className="flex items-center gap-1.5">
              {openFolders.imported ? (
                <FolderOpen className="w-3.5 h-3.5 text-cyan-400" />
              ) : (
                <Folder className="w-3.5 h-3.5 text-cyan-400" />
              )}
              <span>Mis Canciones</span>
            </span>
            <span className="font-mono tabular-nums text-[10px] text-slate-500">
              {importedSongs.length}
            </span>
          </button>

          {openFolders.imported && (
            <div className="mt-1 pl-2 border-l border-slate-800/80 ml-2 space-y-0.5">
              {importedSongs.length === 0 ? (
                <div className="px-2.5 py-2 text-[11px] text-slate-500">
                  Suelta una carpeta o grupo de pistas para agregar tu canción aquí.
                </div>
              ) : (
                importedSongs.map(renderSongNode)
              )}
            </div>
          )}
        </div>

        {/* 3. Built-in Demo Sessions Folder */}
        {demoSongs.length > 0 && (
          <div>
            <button
              type="button"
              onClick={() => toggleFolder('demos')}
              className="w-full flex items-center justify-between px-2 py-1 text-xs font-semibold text-slate-300 hover:text-white cursor-pointer"
            >
              <span className="flex items-center gap-1.5">
                {openFolders.demos ? (
                  <FolderOpen className="w-3.5 h-3.5 text-emerald-400" />
                ) : (
                  <Folder className="w-3.5 h-3.5 text-emerald-400" />
                )}
                <span>Sesiones Demo</span>
              </span>
              <span className="font-mono tabular-nums text-[10px] text-slate-500">
                {demoSongs.length}
              </span>
            </button>

            {openFolders.demos && (
              <div className="mt-1 pl-2 border-l border-slate-800/80 ml-2 space-y-0.5">
                {demoSongs.map(renderSongNode)}
              </div>
            )}
          </div>
        )}
      </div>
    </aside>
  );
};
