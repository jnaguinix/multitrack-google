/**
 * Cleans a raw folder or filename string by stripping noise/filler tokens (Multitrack, Original, MT, Stems, Secuencia),
 * tuning (440hz), BPM, and Key, and extracting clean title, artist, key signature, and BPM.
 */
export function cleanSongTitleAndMetadata(raw: string): {
  title: string;
  artist?: string;
  key?: string;
  bpm?: number;
} {
  if (!raw) return { title: 'Nueva Sesión' };
  let text = raw.replace(/\.[a-zA-Z0-9]+$/, '').trim();

  // 1. Extract 440hz / tuning
  text = text.replace(/[-_\s]*\b\d{3}\s*hz\b/gi, ' ');

  // 2. Extract Key + BPM attached like '-Bb124' or '-G108'
  let detectedKey: string | null = null;
  let detectedBpm: number | null = null;

  const keyBpmMatch = text.match(/[-_\s]+([A-G][#b]?)\s*([5-9]\d|1\d\d|2[0-2]\d)\b/i);
  if (keyBpmMatch) {
    detectedKey = keyBpmMatch[1];
    detectedKey = detectedKey.charAt(0).toUpperCase() + detectedKey.slice(1).toLowerCase();
    detectedBpm = Number(keyBpmMatch[2]);
    text = text.replace(keyBpmMatch[0], ' ');
  }

  // 3. Extract standalone BPM like '108bpm' or '108_bpm' or '108 bpm'
  if (!detectedBpm) {
    const bpmMatch = text.match(/[-_\s]*\b([5-9]\d|1\d\d|2[0-2]\d)\s*[-_]?\s*bpm\b/i);
    if (bpmMatch) {
      detectedBpm = Number(bpmMatch[1]);
      text = text.replace(bpmMatch[0], ' ');
    }
  }

  // 4. Extract Key like 'G major', 'C minor', 'Bb maj'
  if (!detectedKey) {
    const keyMatch = text.match(/[-_\s]*\b([A-G][#b]?)\s*(major|minor|maj|min|m)\b/i);
    if (keyMatch) {
      const root = keyMatch[1].charAt(0).toUpperCase() + keyMatch[1].slice(1).toLowerCase();
      const qual =
        keyMatch[2].toLowerCase().startsWith('m') &&
        !keyMatch[2].toLowerCase().startsWith('maj')
          ? 'Minor'
          : 'Major';
      detectedKey = `${root} ${qual}`;
      text = text.replace(keyMatch[0], ' ');
    }
  }

  // 5. Look for title enclosed in underscores: '_ERES BENDITO_'
  let enclosedTitle: string | null = null;
  const underMatch = text.match(/_([^_]+)_/);
  if (underMatch) {
    enclosedTitle = underMatch[1].trim();
    text = text.replace(underMatch[0], ' ');
  }

  // 6. Remove filler words: Multitrack, Original, MT, Stems, Secuencia
  const fillerRegex = /\b(multitrack|original|mt|stems?|secuencias?|sequence)\b/gi;
  text = text.replace(fillerRegex, ' ');

  // Clean residual dashes, underscores, spaces
  text = text.replace(/[_\s]+/g, ' ').trim();

  let title = '';
  let artist = '';

  if (enclosedTitle) {
    title = enclosedTitle;
    artist = text.replace(/^[-_\s]+|[-_\s]+$/g, '').trim();
  } else if (text.includes(' - ')) {
    const parts = text
      .split(' - ')
      .map((p) => p.replace(/^[-_\s]+|[-_\s]+$/g, '').trim())
      .filter((p) => p.length > 0 && !p.match(fillerRegex));
    title = parts[0] || '';
    if (parts.length > 1) {
      artist = parts[1];
    }
  } else if (text.includes('-')) {
    const parts = text
      .split('-')
      .map((p) => p.replace(/^[-_\s]+|[-_\s]+$/g, '').trim())
      .filter((p) => p.length > 0 && !p.match(fillerRegex));
    title = parts[0] || '';
    if (parts.length > 1) {
      artist = parts[1];
    }
  } else {
    title = text;
  }

  title = title.replace(/^[-_\s]+|[-_\s]+$/g, '').trim();
  if (artist) {
    artist = artist.replace(/^[-_\s]+|[-_\s]+$/g, '').trim();
  }

  // If title is ALL UPPERCASE, format as Title Case
  if (title && title === title.toUpperCase() && title.length > 2) {
    title = title
      .toLowerCase()
      .split(' ')
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(' ');
  }

  return {
    title: title.trim(),
    artist: artist ? artist.trim() : undefined,
    key: detectedKey || undefined,
    bpm: detectedBpm || undefined,
  };
}

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
