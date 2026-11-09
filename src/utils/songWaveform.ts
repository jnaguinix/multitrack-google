import type { SongProject } from '../types/project';

export function getSongWaveformPeaks(project: SongProject | null, totalDurationSec?: number): number[] {
  if (!project || project.tracks.length === 0) return [];
  const numBuckets = 380;
  const anySolo = project.tracks.some((track) => track.soloed);
  const activeTracks = project.tracks.filter(
    (track) => track.role !== 'click' && track.role !== 'guide'
      && !track.muted && (!anySolo || track.soloed),
  );
  const tracks = activeTracks.length > 0 ? activeTracks : project.tracks;
  const divisor = Math.max(1, tracks.length * 0.65);
  return Array.from({ length: numBuckets }, (_, index) => {
    let sum = 0;
    for (const track of tracks) {
      if (!track.peaks?.length) continue;
      const relativeTime = totalDurationSec && track.durationSec
        ? (index / numBuckets) * (totalDurationSec / track.durationSec)
        : index / numBuckets;
      if (relativeTime >= 1) continue;
      const peakIndex = Math.floor(relativeTime * track.peaks.length);
      sum += (track.peaks[peakIndex] || 0) * track.gain;
    }
    return Math.min(1, sum / divisor);
  });
}
