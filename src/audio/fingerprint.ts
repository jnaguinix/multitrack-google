/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { SongProject } from '../types/project';

export interface FingerprintCandidate {
  song: SongProject;
  matchRatio: number; // 0.0 to 1.0
  matchedTrackCount: number;
  totalTracks: number;
}

export interface TrackSummary {
  fileSize?: number;
  durationSec?: number;
  name?: string;
  fileName?: string;
}

/**
 * Compares an incoming set of audio tracks against songs existing in the library.
 * Rule: Only considers two songs to be the same if their track counts match within ±1
 * and at least 80% (>= 0.80) of the tracks match in size and duration.
 */
export function findSongFingerprintMatches(
  incomingTracks: TrackSummary[],
  existingSongs: SongProject[]
): FingerprintCandidate[] {
  const incomingCount = incomingTracks.length;
  if (incomingCount === 0) return [];

  const candidates: FingerprintCandidate[] = [];

  for (const song of existingSongs) {
    const existingCount = song.tracks.length;
    // Condition 1: Track count within ±1
    if (Math.abs(incomingCount - existingCount) > 1) {
      continue;
    }

    // Condition 2: Compare tracks by size and duration
    let matchedCount = 0;
    const usedExistingIndices = new Set<number>();

    for (const inTrack of incomingTracks) {
      for (let j = 0; j < song.tracks.length; j++) {
        if (usedExistingIndices.has(j)) continue;
        const exTrack = song.tracks[j];

        const durationA = inTrack.durationSec;
        const durationB = exTrack.durationSec;
        const sizeA = inTrack.fileSize;
        const sizeB = exTrack.fileSize;

        let durationMatches = false;
        if (durationA != null && durationB != null && durationA > 0 && durationB > 0) {
          durationMatches = Math.abs(durationA - durationB) <= 1.0; // 1s tolerance
        }

        let sizeMatches = false;
        if (sizeA != null && sizeB != null && sizeA > 0 && sizeB > 0) {
          const diff = Math.abs(sizeA - sizeB);
          // Allow tag diffs up to 64KB or 2%
          sizeMatches = diff === 0 || diff < 65536 || diff / Math.max(sizeA, sizeB) < 0.02;
        }

        const isMatch =
          (durationMatches && sizeMatches) ||
          (sizeMatches && !durationA && !durationB) ||
          (durationMatches && !sizeA && !sizeB);

        if (isMatch) {
          matchedCount++;
          usedExistingIndices.add(j);
          break;
        }
      }
    }

    const maxCount = Math.max(incomingCount, existingCount);
    const matchRatio = maxCount > 0 ? matchedCount / maxCount : 0;

    // Condition 3: At least 80% match ratio
    if (matchRatio >= 0.80) {
      candidates.push({
        song,
        matchRatio,
        matchedTrackCount: matchedCount,
        totalTracks: maxCount,
      });
    }
  }

  candidates.sort((a, b) => b.matchRatio - a.matchRatio);
  return candidates;
}
