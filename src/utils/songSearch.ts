/** Búsqueda de canciones sin acentos ni mayúsculas, compartida por la Biblioteca y el explorador del Setlist. */
export interface SearchableSong {
  title: string;
  artist?: string;
  keySignature?: string;
  bpm?: number;
}

export function normalizeText(text: string): string {
  return text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

/**
 * Filtra por título, artista, tonalidad y BPM. Cada palabra de la búsqueda debe aparecer en algún campo,
 * así «dios grande» encuentra «Dios el más grande» y «g 108» encuentra una canción en G a 108 BPM.
 */
export function filterSongs<T extends SearchableSong>(songs: readonly T[], query: string): T[] {
  const tokens = normalizeText(query).split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return songs.slice();
  return songs.filter((song) => {
    const haystack = normalizeText(`${song.title} ${song.artist ?? ''} ${song.keySignature ?? ''} ${song.bpm ?? ''}`);
    return tokens.every((token) => haystack.includes(token));
  });
}
