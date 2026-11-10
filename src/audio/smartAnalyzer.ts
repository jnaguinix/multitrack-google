/**
 * Extracts a clean song title, BPM, and key signature from a list of imported audio files
 * (supports folder drag-and-drop webkitRelativePath as well as common filename prefixes).
 */
export function inferSongMetadataFromFiles(files: File[]): {
  songTitle: string;
  detectedBpm: number | null;
  detectedKey: string | null;
  cleanTrackNames: string[];
} {
  if (files.length === 0) {
    return {
      songTitle: 'Nueva Canción Importada',
      detectedBpm: null,
      detectedKey: null,
      cleanTrackNames: [],
    };
  }

  // 1. Check if files come from a folder via webkitRelativePath
  const firstRelPath =
    (files[0] as File & { webkitRelativePath?: string }).webkitRelativePath || '';
  let folderName = '';
  if (firstRelPath && firstRelPath.includes('/')) {
    const parts = firstRelPath.split('/').filter(Boolean);
    if (parts.length >= 2) {
      folderName = parts[parts.length - 2];
    }
  }

  const rawBaseNames = files.map((f) => f.name.replace(/\.[^/.]+$/, ''));

  // 2. Look for BPM pattern in folder or filenames (e.g. "120bpm", "120_BPM", "98 bpm")
  let detectedBpm: number | null = null;
  const combinedSource = `${folderName} ${rawBaseNames.join(' ')}`;
  const bpmMatch = combinedSource.match(/\b([5-9]\d|1\d\d|2[0-2]\d)\s*[-_]?\s*bpm\b/i);
  if (bpmMatch) {
    const parsed = Number(bpmMatch[1]);
    if (parsed >= 50 && parsed <= 220) {
      detectedBpm = parsed;
    }
  }

  // 3. Look for Key signature pattern (e.g. "Cm", "F#m", "G Major", "Bb")
  let detectedKey: string | null = null;
  const keyMatch = combinedSource.match(/\b([A-G][#b]?)\s*(maj|major|min|minor|m)\b/i);
  if (keyMatch) {
    const root = keyMatch[1].toUpperCase();
    const qual =
      keyMatch[2].toLowerCase().startsWith('m') &&
      !keyMatch[2].toLowerCase().startsWith('maj')
        ? 'Minor'
        : 'Major';
    detectedKey = `${root} ${qual}`;
  }

  // 4. Find common prefix among filenames if folderName is empty
  let commonPrefix = '';
  if (rawBaseNames.length >= 2) {
    const sorted = [...rawBaseNames].sort();
    const first = sorted[0];
    const last = sorted[sorted.length - 1];
    let i = 0;
    while (
      i < first.length &&
      first.charAt(i).toLowerCase() === last.charAt(i).toLowerCase()
    ) {
      i++;
    }
    commonPrefix = first.slice(0, i).replace(/[-_\s([0-9]+$/, '').trim();
  }

  let songTitle = folderName || commonPrefix || rawBaseNames[0] || 'Sesión Importada';
  songTitle = songTitle
    .replace(/\b([5-9]\d|1\d\d|2[0-2]\d)\s*[-_]?\s*bpm\b/gi, '')
    .replace(/[-_]+/g, ' ')
    .trim();

  if (!songTitle || songTitle.length < 2) {
    songTitle = `Sesión Multipista (${new Date().toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
    })})`;
  }

  // 5. Clean individual track names by removing the common song prefix
  const cleanTrackNames = rawBaseNames.map((name, idx) => {
    let cleaned = name;
    if (
      commonPrefix &&
      commonPrefix.length >= 3 &&
      cleaned.toLowerCase().startsWith(commonPrefix.toLowerCase())
    ) {
      cleaned = cleaned.slice(commonPrefix.length);
    }
    cleaned = cleaned
      .replace(/^[-_\s0-9.]+/, '')
      .replace(/[-_]+/g, ' ')
      .trim();
    const norm = cleaned
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase();
    if (norm === 'cues' || norm === 'cue' || norm === 'guide' || norm === 'guia') {
      return 'Guía';
    }
    return cleaned || name || `Stem ${idx + 1}`;
  });

  return {
    songTitle,
    detectedBpm,
    detectedKey,
    cleanTrackNames,
  };
}
