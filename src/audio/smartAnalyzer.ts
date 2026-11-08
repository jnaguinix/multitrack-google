import { SongSection, TrackChannel } from '../types/project';

const SECTION_PALETTE = [
  '#0891B2', // Cyan
  '#2563EB', // Blue
  '#059669', // Emerald
  '#D97706', // Amber
  '#7C3AED', // Violet
  '#DB2777', // Pink
  '#DC2626', // Crimson
];

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
  const firstRelPath = (files[0] as File & { webkitRelativePath?: string }).webkitRelativePath || '';
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
    const qual = keyMatch[2].toLowerCase().startsWith('m') && !keyMatch[2].toLowerCase().startsWith('maj')
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
    while (i < first.length && first.charAt(i).toLowerCase() === last.charAt(i).toLowerCase()) {
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
    songTitle = `Sesión Multipista (${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })})`;
  }

  // 5. Clean individual track names by removing the common song prefix
  const cleanTrackNames = rawBaseNames.map((name, idx) => {
    let cleaned = name;
    if (commonPrefix && commonPrefix.length >= 3 && cleaned.toLowerCase().startsWith(commonPrefix.toLowerCase())) {
      cleaned = cleaned.slice(commonPrefix.length);
    }
    cleaned = cleaned
      .replace(/^[-_\s0-9.]+/, '')
      .replace(/[-_]+/g, ' ')
      .trim();
    return cleaned || name || `Stem ${idx + 1}`;
  });

  return {
    songTitle,
    detectedBpm,
    detectedKey,
    cleanTrackNames,
  };
}

/**
 * Analyzes the combined RMS energy envelope across all musical tracks per bar
 * and automatically generates musical sections (Intro, Verso, Coro, Puente, Outro)
 * aligned to 4-bar or 8-bar structural phrases.
 */
export function autoDetectSectionsFromTracks(
  tracks: TrackChannel[],
  totalBars: number
): SongSection[] {
  const safeTotalBars = Math.max(4, totalBars);

  // Filter musical tracks (ignore click/guide tracks so constant click doesn't flatten dynamics)
  const musicalTracks = tracks.filter(
    (t) => t.role !== 'click' && t.role !== 'guide' && t.peaks && t.peaks.length > 0
  );
  const sourceTracks = musicalTracks.length > 0 ? musicalTracks : tracks.filter((t) => t.peaks.length > 0);

  if (sourceTracks.length === 0 || safeTotalBars <= 8) {
    return [
      {
        id: `sec-auto-1-${Date.now()}`,
        name: 'Sección Principal',
        code: 'A',
        color: SECTION_PALETTE[0],
        startBar: 1,
        lengthBars: safeTotalBars,
        cueName: 'Main Section',
      },
    ];
  }

  // 1. Compute average energy for each bar (1..safeTotalBars)
  const barEnergy: number[] = new Array(safeTotalBars).fill(0);
  for (let b = 0; b < safeTotalBars; b++) {
    let sum = 0;
    for (const trk of sourceTracks) {
      const numPeaks = trk.peaks.length;
      const startIdx = Math.floor((b / safeTotalBars) * numPeaks);
      const endIdx = Math.max(startIdx + 1, Math.floor(((b + 1) / safeTotalBars) * numPeaks));
      let barMax = 0;
      for (let i = startIdx; i < endIdx && i < numPeaks; i++) {
        barMax += trk.peaks[i] || 0;
      }
      sum += barMax / Math.max(1, endIdx - startIdx);
    }
    barEnergy[b] = sum / sourceTracks.length;
  }

  // Normalize bar energy 0..1
  const maxE = Math.max(0.001, ...barEnergy);
  const normEnergy = barEnergy.map((e) => e / maxE);

  // 2. Group into phrase blocks (4 bars for medium songs, 8 bars for longer songs > 40 bars)
  const phraseSize = safeTotalBars >= 40 ? 8 : 4;
  const numPhrases = Math.ceil(safeTotalBars / phraseSize);
  const phraseEnergies: number[] = [];

  for (let p = 0; p < numPhrases; p++) {
    const startB = p * phraseSize;
    const endB = Math.min(safeTotalBars, startB + phraseSize);
    let sum = 0;
    for (let b = startB; b < endB; b++) {
      sum += normEnergy[b];
    }
    phraseEnergies.push(sum / Math.max(1, endB - startB));
  }

  // 3. Merge adjacent phrases with similar energy (< 0.14 delta) unless already 2 phrases long
  interface RawSegment {
    startBar: number;
    lengthBars: number;
    avgEnergy: number;
  }

  const segments: RawSegment[] = [];
  let currentStartBar = 1;
  let currentLength = Math.min(phraseSize, safeTotalBars);
  let currentEnergy = phraseEnergies[0] || 0.5;

  for (let p = 1; p < numPhrases; p++) {
    const pStartBar = p * phraseSize + 1;
    const pLen = Math.min(phraseSize, safeTotalBars - p * phraseSize);
    const pEnergy = phraseEnergies[p];
    const delta = Math.abs(pEnergy - currentEnergy);

    if (delta < 0.14 && currentLength < phraseSize * 2 && segments.length < 7) {
      currentLength += pLen;
      currentEnergy = (currentEnergy + pEnergy) / 2;
    } else {
      segments.push({
        startBar: currentStartBar,
        lengthBars: currentLength,
        avgEnergy: currentEnergy,
      });
      currentStartBar = pStartBar;
      currentLength = pLen;
      currentEnergy = pEnergy;
    }
  }
  segments.push({
    startBar: currentStartBar,
    lengthBars: currentLength,
    avgEnergy: currentEnergy,
  });

  // 4. Assign intelligent musical section names based on position and energy tier
  let verseCount = 0;
  let chorusCount = 0;
  let bridgeUsed = false;

  return segments.map((seg, idx) => {
    const isFirst = idx === 0;
    const isLast = idx === segments.length - 1 && segments.length > 2;
    let name = '';
    let code = '';
    let cueName = '';
    let vampByDefault = false;

    if (isFirst && seg.avgEnergy < 0.65) {
      name = 'Intro';
      code = 'IN';
      cueName = 'Intro';
    } else if (isLast && seg.avgEnergy < 0.65) {
      name = 'Outro';
      code = 'OU';
      cueName = 'Outro';
    } else if (seg.avgEnergy >= 0.72) {
      chorusCount++;
      name = chorusCount === 1 ? 'Coro Principal' : `Coro ${chorusCount}`;
      code = chorusCount === 1 ? 'CH' : `C${chorusCount}`;
      cueName = 'Chorus';
    } else if (
      !bridgeUsed &&
      idx >= Math.floor(segments.length * 0.55) &&
      idx < segments.length - 1
    ) {
      bridgeUsed = true;
      name = 'Puente (Vamp)';
      code = 'BR';
      cueName = 'Bridge';
      vampByDefault = true;
    } else {
      verseCount++;
      name = `Verso ${verseCount}`;
      code = `V${verseCount}`;
      cueName = `Verse ${verseCount}`;
    }

    return {
      id: `sec-auto-${Date.now()}-${idx}`,
      name,
      code,
      color: SECTION_PALETTE[idx % SECTION_PALETTE.length],
      startBar: seg.startBar,
      lengthBars: seg.lengthBars,
      vampByDefault,
      cueName,
    };
  });
}
