/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { SongProject } from '../types/project';
import { deleteProjectPcm, getProjectPcmDiskBytes, isOpfsSupported } from './opfsStorage';
import { loadProjectStemsFromDb, saveProjectToDb } from './projectDb';

export const OPFS_CACHE_MAX_BYTES = 6 * 1024 * 1024 * 1024; // 6 GB of OPFS cache for songs outside the setlist

export interface PruneResult {
  prunedIds: string[];
  freedBytes: number;
  /** Projects (already stripped of pcm metadata) to merge into app state */
  updatedProjects: SongProject[];
}

/**
 * Keeps the OPFS cache under `maxBytes`. Songs in the setlist (and `keepIds`) are never pruned.
 * Other songs with a PCM cache are removed oldest-first (by `updatedAt`) but only if their
 * original audio is still referenced (handles or Blobs), so they can be rebuilt on demand.
 * The library entry (sections, mix, markers) is kept.
 */
export async function pruneOpfsCache(
  projects: SongProject[],
  keepIds: string[] = [],
  maxBytes: number = OPFS_CACHE_MAX_BYTES
): Promise<PruneResult> {
  const result: PruneResult = { prunedIds: [], freedBytes: 0, updatedProjects: [] };
  if (!isOpfsSupported()) return result;

  const keep = new Set(keepIds);
  const sizes = new Map<string, number>();
  let total = 0;
  for (const p of projects) {
    if (!p.tracks.some((t) => t.pcm)) continue;
    const bytes = await getProjectPcmDiskBytes(p.id);
    sizes.set(p.id, bytes);
    total += bytes;
  }
  if (total <= maxBytes) return result;

  const candidates = projects
    .filter((p) => sizes.has(p.id) && !p.inSetlist && !keep.has(p.id))
    .sort((a, b) => (a.updatedAt || 0) - (b.updatedAt || 0));

  for (const p of candidates) {
    if (total <= maxBytes) break;
    const stems = await loadProjectStemsFromDb(p.id);
    if (stems.length === 0) continue; // no original to rebuild from: keep the cache

    await deleteProjectPcm(p.id);
    const bytes = sizes.get(p.id) || 0;
    total -= bytes;
    result.freedBytes += bytes;
    result.prunedIds.push(p.id);

    const stripped: SongProject = {
      ...p,
      tracks: p.tracks.map((t) => {
        const { pcm: _pcm, ...rest } = t;
        return rest;
      }),
    };
    await saveProjectToDb(stripped);
    result.updatedProjects.push(stripped);
    console.info(
      `[CachePolicy] Caché OPFS de "${p.title}" liberada (${(bytes / 1048576).toFixed(0)} MB); la ficha sigue en la biblioteca.`
    );
  }
  return result;
}
