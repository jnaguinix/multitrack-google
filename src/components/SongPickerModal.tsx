import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Check, FolderPlus, Music, Plus, Search, Upload, X } from 'lucide-react';
import { SongProject } from '../types/project';
import { pickAudioSources } from '../storage/sourceFiles';
import { isDesktopApp, pickNativeFiles, pickNativeFolder } from '../utils/nativeDialog';
import { formatMmSs } from './TransportDeck';
import { filterSongs } from '../utils/songSearch';
import { useProgressiveList } from '../hooks/useProgressiveList';

interface SongPickerModalProps {
  songs: SongProject[];
  setlistIds: Set<string>;
  onClose: () => void;
  onAddToSetlist: (songId: string) => void;
  onRemoveFromSetlist: (songId: string) => void;
  onQuickImportNewSongFiles: (files: FileList | File[]) => void;
  onQuickImportNativeFolder?: (folderPath: string) => void;
  onQuickImportNativeFiles?: (filePaths: string[]) => void;
}

type SortKey = 'title' | 'recent' | 'bpm';

const SORT_LABELS: Record<SortKey, string> = {
  title: 'Nombre',
  recent: 'Recientes',
  bpm: 'BPM',
};

function songDurationSec(song: SongProject): number {
  return song.durationSec || ((song.totalBars || 24) * 4 * 60) / (song.bpm || 120);
}

/** Explorador de canciones superpuesto: buscar en la biblioteca y añadir al setlist. */
export const SongPickerModal: React.FC<SongPickerModalProps> = ({
  songs,
  setlistIds,
  onClose,
  onAddToSetlist,
  onRemoveFromSetlist,
  onQuickImportNewSongFiles,
  onQuickImportNativeFolder,
  onQuickImportNativeFiles,
}) => {
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<SortKey>('title');
  const searchRef = useRef<HTMLInputElement | null>(null);
  const filesInputRef = useRef<HTMLInputElement | null>(null);
  const folderInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    searchRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const visible = useMemo(() => {
    const filtered = filterSongs(songs, query);
    filtered.sort((a, b) => {
      if (sort === 'recent') return (b.updatedAt || 0) - (a.updatedAt || 0);
      if (sort === 'bpm') return (a.bpm || 0) - (b.bpm || 0);
      return a.title.localeCompare(b.title, 'es', { sensitivity: 'base' });
    });
    return filtered;
  }, [songs, query, sort]);

  const { shown, hasMore, remaining, showMore, sentinelRef } = useProgressiveList(visible, `${query}|${sort}`);

  const importFiles = () => {
    if (isDesktopApp()) {
      pickNativeFiles().then((paths) => {
        if (paths && paths.length > 0) onQuickImportNativeFiles?.(paths);
      });
      return;
    }
    pickAudioSources('files', filesInputRef.current, onQuickImportNewSongFiles);
  };

  const importFolder = () => {
    if (isDesktopApp()) {
      pickNativeFolder().then((folder) => {
        if (folder) onQuickImportNativeFolder?.(folder);
      });
      return;
    }
    pickAudioSources('folder', folderInputRef.current, onQuickImportNewSongFiles);
  };

  const inSetlistCount = songs.filter((s) => setlistIds.has(s.id)).length;

  return (
    <div className="lt-picker-backdrop" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Añadir canciones al setlist"
        className="lt-picker"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="lt-picker-header">
          <div>
            <h2>Añadir al setlist</h2>
            <p>
              {songs.length === 1 ? '1 canción en la biblioteca' : `${songs.length} canciones en la biblioteca`}
              {inSetlistCount > 0 && ` · ${inSetlistCount} en el setlist`}
            </p>
          </div>
          <button type="button" onClick={onClose} className="lt-control lt-icon-control" aria-label="Cerrar">
            <X size={16} />
          </button>
        </header>

        <div className="lt-picker-toolbar">
          <label className="lt-picker-search">
            <Search size={15} aria-hidden="true" />
            <input
              ref={searchRef}
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Buscar por nombre, artista, tono o BPM"
              aria-label="Buscar canción"
            />
          </label>
          <div className="lt-picker-sort" role="group" aria-label="Ordenar por">
            {(Object.keys(SORT_LABELS) as SortKey[]).map((key) => (
              <button
                key={key}
                type="button"
                className="lt-control"
                aria-pressed={sort === key}
                onClick={() => setSort(key)}
              >
                {SORT_LABELS[key]}
              </button>
            ))}
          </div>
        </div>

        <div className="lt-picker-list" role="list">
          {songs.length === 0 ? (
            <div className="lt-picker-empty">
              <Music size={22} aria-hidden="true" />
              <p>Tu biblioteca está vacía. Importa los stems o una carpeta de canción para empezar.</p>
            </div>
          ) : visible.length === 0 ? (
            <div className="lt-picker-empty">
              <Search size={22} aria-hidden="true" />
              <p>Ninguna canción coincide con «{query}».</p>
            </div>
          ) : (
            shown.map((song) => {
              const inSet = setlistIds.has(song.id);
              return (
                <div
                  key={song.id}
                  role="listitem"
                  className="lt-picker-row"
                  data-in-set={inSet || undefined}
                  draggable
                  onDragStart={(e) => e.dataTransfer.setData('application/x-omnitracks-song-id', song.id)}
                >
                  <div className="lt-picker-row-main">
                    <span className="lt-picker-title" title={song.title}>{song.title}</span>
                    <span className="lt-picker-artist" title={song.artist}>{song.artist}</span>
                  </div>
                  <span className="lt-picker-meta">{song.keySignature}</span>
                  <span className="lt-picker-meta">{song.bpm} BPM</span>
                  <span className="lt-picker-meta">{formatMmSs(songDurationSec(song))}</span>
                  <span className="lt-picker-meta">{song.tracks.length}p</span>
                  {inSet ? (
                    <button
                      type="button"
                      className="lt-control lt-picker-action"
                      data-active
                      onClick={() => onRemoveFromSetlist(song.id)}
                      title="Quitar del setlist"
                    >
                      <Check size={14} /> En el setlist
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="lt-control lt-picker-action"
                      onClick={() => onAddToSetlist(song.id)}
                      title="Añadir al setlist"
                    >
                      <Plus size={14} /> Añadir
                    </button>
                  )}
                </div>
              );
            })
          )}
          {hasMore && (
            <div ref={sentinelRef} className="lt-list-more">
              <button type="button" className="lt-control" onClick={showMore}>Mostrar {Math.min(remaining, 40)} más ({remaining} sin mostrar)</button>
            </div>
          )}
        </div>

        <footer className="lt-picker-footer">
          <span>¿No está? Importa una nueva:</span>
          <button type="button" onClick={importFiles} className="lt-control" title="Selecciona los stems de una canción">
            <Upload size={14} /> Pistas
          </button>
          <button type="button" onClick={importFolder} className="lt-control" title="Selecciona una carpeta completa de stems">
            <FolderPlus size={14} /> Carpeta
          </button>
          <button type="button" onClick={onClose} className="lt-primary lt-picker-done">Listo</button>
        </footer>

        <input
          ref={filesInputRef}
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
    </div>
  );
};
