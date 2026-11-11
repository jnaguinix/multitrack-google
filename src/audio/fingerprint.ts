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

        const hasDurationA = durationA != null && durationA > 0;
        const hasDurationB = durationB != null && durationB > 0;
        const hasBothDurations = hasDurationA && hasDurationB;

        const hasSizeA = sizeA != null && sizeA > 0;
        const hasSizeB = sizeB != null && sizeB > 0;
        const hasBothSizes = hasSizeA && hasSizeB;

        let durationMatches = false;
        if (hasBothDurations) {
          durationMatches = Math.abs(durationA - durationB) <= 1.0; // 1s tolerance
        }

        let sizeMatches = false;
        if (hasBothSizes) {
          const diff = Math.abs(sizeA - sizeB);
          // Allow tag diffs up to 64KB or 2%
          sizeMatches = diff === 0 || diff < 65536 || diff / Math.max(sizeA, sizeB) < 0.02;
        }

        let isMatch = false;
        if (hasBothDurations && hasBothSizes) {
          isMatch = durationMatches && sizeMatches;
        } else if (hasBothSizes && !hasBothDurations) {
          // Si falta la duración en cualquiera de los dos lados, decide solo por tamaño (misma tolerancia)
          isMatch = sizeMatches;
        } else if (hasBothDurations && !hasBothSizes) {
          // Si falta el tamaño en cualquiera de los dos lados, decide solo por duración
          isMatch = durationMatches;
        }

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
