import React, { useMemo, useState } from 'react';
import { Search, Download, MoreHorizontal, Trash2, CheckCircle2, FolderPlus, ListPlus, ListMinus, Zap, HardDrive, Edit3, type LucideIcon } from 'lucide-react';
import { SongProject } from '../types/project';
import { audioEngine } from '../audio/audioEngine';
import { isFsAccessSupported } from '../storage/sourceFiles';
import { isDesktopApp } from '../utils/nativeDialog';
import { formatMmSs } from './TransportDeck';
import { SongMetadataEditModal } from './modals/SongMetadataEditModal';
import { filterSongs } from '../utils/songSearch';
import { useProgressiveList } from '../hooks/useProgressiveList';

interface LibraryViewProps {
  projects: SongProject[];
  currentProjectId: string | null;
  onSelectProject: (projectId: string) => void;
  onAddToSetlist: (projectId: string) => void;
  onRemoveFromSetlist?: (projectId: string) => void;
  onDeleteProject: (projectId: string) => void;
  onExportJson: (project: SongProject) => void;
  onOptimizeProject: (project: SongProject) => void;
  onRelinkProject?: (project: SongProject) => void;
  onUpdateSongMetadata?: (updated: SongProject) => void;
}

export const LibraryView: React.FC<LibraryViewProps> = ({
  projects,
  currentProjectId,
  onSelectProject,
  onAddToSetlist,
  onRemoveFromSetlist,
  onDeleteProject,
  onExportJson,
  onOptimizeProject,
  onRelinkProject,
  onUpdateSongMetadata,
}) => {
  const [editingMetadataSong, setEditingMetadataSong] = useState<SongProject | null>(null);
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<'name' | 'recent' | 'bpm'>('name');

  const visibleProjects = useMemo(() => {
    const filtered = filterSongs(projects, query);
    filtered.sort((a, b) => {
      if (sort === 'recent') return (b.updatedAt || 0) - (a.updatedAt || 0);
      if (sort === 'bpm') return (a.bpm || 0) - (b.bpm || 0);
      return a.title.localeCompare(b.title, 'es', { sensitivity: 'base' });
    });
    return filtered;
  }, [projects, query, sort]);
  const { shown, hasMore, remaining, showMore, sentinelRef } = useProgressiveList(visibleProjects, `${query}|${sort}`);

  return (
    <div className="flex-1 min-w-0 bg-studio-ground p-4 sm:p-6 overflow-y-auto">
      <div className="max-w-6xl mx-auto space-y-8">
        {/* Cabecera */}
        <div className="flex flex-wrap items-center justify-between gap-4 border-b border-neutral-800 pb-5">
          <div>
            <h1 className="text-2xl font-bold text-neutral-100">
              Biblioteca
            </h1>
            <p className="text-sm text-neutral-400 mt-1">
              {isDesktopApp()
                ? 'Canciones indexadas en la biblioteca de OmniTracks (almacenadas en library.json).'
                : 'Canciones guardadas en este navegador.'}
            </p>
          </div>

        </div>

        {/* Lista de canciones */}
        <div>
                    <div className="space-y-3">
            <div className="lt-library-toolbar">
              <h2 className="text-base font-semibold text-neutral-200">
                Canciones ({query.trim() ? `${visibleProjects.length} de ${projects.length}` : projects.length})
              </h2>
              <label className="lt-picker-search">
                <Search size={15} aria-hidden="true" />
                <input
                  type="search"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Buscar por nombre, artista, tono o BPM"
                  aria-label="Buscar canción"
                />
              </label>
              <div className="lt-picker-sort" role="group" aria-label="Ordenar por">
                {([['name', 'Nombre'], ['recent', 'Recientes'], ['bpm', 'BPM']] as const).map(([key, label]) => (
                  <button key={key} type="button" className="lt-control" aria-pressed={sort === key} onClick={() => setSort(key)}>
                    {label}
                  </button>
                ))}
              </div>
            </div>

            <div className="divide-y divide-studio-line">
              {projects.length === 0 && <p className="rounded-lg bg-studio-panel p-4 text-sm text-studio-muted">Pulsa «Importar» arriba para añadir tu primera canción.</p>}
              {projects.length > 0 && visibleProjects.length === 0 && <p className="rounded-lg bg-studio-panel p-4 text-sm text-studio-muted">Ninguna canción coincide con «{query}».</p>}
              {shown.map((proj, index) => {
                const isCurrent = proj.id === currentProjectId;
                const durSec =
                  proj.durationSec || ((proj.totalBars || 24) * 4 * 60) / (proj.bpm || 120);
                const isPcmReady = audioEngine.isProjectPcmReady(proj);
                const pcmMB = audioEngine.getProjectPcmEstimatedMB(proj);

                return (
                  <div
                    key={proj.id}
                    className="flex flex-wrap items-center justify-between gap-3 py-3.5"
                  >
                    <div className="min-w-[10rem] flex-1">
                      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                        <div className="flex items-center gap-1.5">
                          <h3
                            onDoubleClick={() => setEditingMetadataSong(proj)}
                            title="Doble clic para editar título, artista, tono, BPM y compás"
                            className="text-base font-bold text-neutral-100 truncate cursor-pointer hover:text-studio-ink transition-colors"
                          >
                            {proj.title}
                          </h3>
                          <button
                            type="button"
                            onClick={() => setEditingMetadataSong(proj)}
                            title="Editar metadatos (título, artista, tono, BPM, compás)"
                            className="p-1 rounded text-neutral-500 hover:text-studio-ink hover:bg-neutral-800 transition-colors cursor-pointer"
                          >
                            <Edit3 className="w-3.5 h-3.5" />
                          </button>
                        </div>
                        {isCurrent && (
                          <span className="text-xs font-medium text-studio-ink flex items-center gap-1">
                            <CheckCircle2 className="w-3.5 h-3.5" /> Activa
                          </span>
                        )}
                        {/* Estado de la caché PCM nativa */}
                        {isPcmReady ? (
                          <span
                            title={`Caché PCM nativa lista (~${pcmMB} MB en disco). Carga rápida.`}
                            className="px-2 py-0.5 rounded text-xs font-bold bg-studio-strip text-studio-ink border border-studio-line flex items-center gap-1"
                          >
                            <HardDrive className="w-3 h-3" />
                            <span>PCM listo ({pcmMB} MB)</span>
                          </span>
                        ) : (
                          <span
                            title="Esta canción aún no tiene caché PCM nativa. Pulsa 'Optimizar para streaming' para generarla en disco."
                            className="px-2 py-0.5 rounded text-xs text-studio-muted flex items-center gap-1"
                          >
                            <span>Sin optimizar</span>
                          </span>
                        )}
                      </div>

                      <div className="flex flex-wrap items-center gap-2 text-xs text-neutral-400 mt-1">
                        <span>{proj.artist}</span>
                        <span aria-hidden="true">·</span>
                        <span className="tabular-nums">{formatMmSs(durSec)}</span>
                        <span aria-hidden="true">·</span>
                        <span className="tabular-nums">{proj.bpm} BPM</span>
                        <span aria-hidden="true">·</span>
                        <span>{proj.keySignature}</span>
                        <span aria-hidden="true">·</span>
                        <span className="tabular-nums">
                          {proj.tracks.length} pistas
                        </span>
                        <span aria-hidden="true">·</span>
                        <span className="tabular-nums">
                          {proj.sections.length} marcadores
                        </span>
                      </div>
                    </div>

                    <div className="flex items-center gap-2 shrink-0">
                      <button type="button" className="lt-control" onClick={() => onSelectProject(proj.id)}>{isCurrent ? 'Abierta' : 'Abrir'}</button>
                      <button type="button" popoverTarget={`library-song-${index}`} aria-label={`Acciones de ${proj.title}`} className="lt-control lt-icon-control">
                        <MoreHorizontal size={17} />
                      </button>
                      <div id={`library-song-${index}`} popover="auto" role="menu" aria-label={`Acciones de ${proj.title}`} className="lt-popover lt-library-actions">
                        {proj.inSetlist && onRemoveFromSetlist ? (
                          <LibraryMenuItem
                            icon={ListMinus}
                            label="Quitar del Setlist"
                            title="Quitar esta canción del Setlist (permanece en la biblioteca)"
                            onSelect={() => onRemoveFromSetlist(proj.id)}
                          />
                        ) : (
                          <LibraryMenuItem icon={ListPlus} label="Añadir al Setlist" onSelect={() => onAddToSetlist(proj.id)} />
                        )}
                        <LibraryMenuItem
                          icon={Edit3}
                          label="Editar metadatos"
                          title="Editar título, artista, BPM, compás y tono"
                          onSelect={() => setEditingMetadataSong(proj)}
                        />
                        {/* Volver a enlazar los archivos originales (carpeta movida o renombrada, o permiso perdido). */}
                        {onRelinkProject && (isDesktopApp() || (!isPcmReady && isFsAccessSupported())) && (
                          <LibraryMenuItem
                            icon={FolderPlus}
                            label="Ubicar carpeta"
                            title="Elegir la carpeta donde están ahora los stems originales de esta canción"
                            onSelect={() => onRelinkProject(proj)}
                          />
                        )}
                        {!isPcmReady && proj.tracks.length > 0 && (
                          <LibraryMenuItem
                            icon={Zap}
                            label="Generar caché"
                            title="Generar la caché PCM nativa de esta canción"
                            onSelect={() => onOptimizeProject(proj)}
                          />
                        )}
                        <LibraryMenuItem
                          icon={Download}
                          label="Exportar JSON"
                          title="Exportar configuración del proyecto en JSON"
                          onSelect={() => onExportJson(proj)}
                        />
                        <div role="separator" className="lt-menu-separator" />
                        <LibraryMenuItem
                          icon={Trash2}
                          label="Eliminar canción"
                          title="Eliminar la canción de la biblioteca (los archivos originales no se tocan)"
                          danger
                          onSelect={() => onDeleteProject(proj.id)}
                        />
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
            {hasMore && (
              <div ref={sentinelRef} className="lt-list-more">
                <button type="button" className="lt-control" onClick={showMore}>
                  Mostrar {Math.min(remaining, 40)} más ({remaining} sin mostrar)
                </button>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Metadata Edit Modal */}
      {editingMetadataSong && (
        <SongMetadataEditModal
          isOpen={Boolean(editingMetadataSong)}
          song={editingMetadataSong}
          onClose={() => setEditingMetadataSong(null)}
          onSave={(updated) => {
            onUpdateSongMetadata?.(updated);
            setEditingMetadataSong(null);
          }}
        />
      )}
    </div>
  );
};

/**
 * Opción del menú «⋯» de una canción en la Biblioteca. Todas iguales (icono y texto en una fila, misma altura), como
 * los demás menús de la app; `danger` solo para la acción destructiva, que va al final tras un separador.
 */
function LibraryMenuItem({
  icon: Icon,
  label,
  title,
  danger = false,
  onSelect,
}: {
  icon: LucideIcon;
  label: string;
  title?: string;
  danger?: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      title={title}
      data-danger={danger || undefined}
      onClick={(event) => {
        event.currentTarget.closest<HTMLElement>('[popover]')?.hidePopover();
        onSelect();
      }}
      className="lt-menu-item"
    >
      <Icon size={16} aria-hidden="true" />
      <span>{label}</span>
    </button>
  );
}
