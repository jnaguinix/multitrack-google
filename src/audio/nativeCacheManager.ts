// Caché PCM nativa de cada canción: avance de la decodificación (evento audio://import-progress), estado
// conocido «lista / no lista» para pintar la interfaz de forma síncrona y generación de la caché sin lanzar nunca
// dos decodificaciones a la vez del mismo proyecto. La usa `NativeAudioEngine`, que expone la misma API pública.

import type { SongProject } from '../types/project';
import { loadProjectStemsFromDb, extractStemArrayBuffer } from '../storage/projectDb';
import { pickNativeFolder, scanNativeFolder, checkFilesExist, importTrackBytesRaw } from '../utils/nativeDialog';

type Invoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;

export interface NativeImportProgress {
  percent: number;
  text: string;
  completed: boolean;
  /** Pista que se está decodificando (1-based). 0 si aún no se conoce. */
  trackNumber: number;
  totalTracks: number;
}

export interface CacheStatus {
  isReady: boolean;
  cachedCount: number;
  totalCount: number;
}

/**
 * ¿La generación de caché dejó TODAS las pistas del proyecto? Devuelve `null` si sí y, si no, el motivo en lenguaje
 * claro (errores del motor y pistas que faltan). Una caché parcial no es una caché «lista»: montarla daría una
 * canción con pistas ausentes o un error de carga después.
 */
export function importIncompleteReason(
  res: { tracks?: Array<{ trackId?: string }>; errors?: string[] } | null | undefined,
  expectedTrackIds: readonly string[]
): string | null {
  const imported = new Set((res?.tracks ?? []).map((t) => t.trackId).filter((id): id is string => Boolean(id)));
  const missing = expectedTrackIds.filter((id) => !imported.has(id));
  const errors = (res?.errors ?? []).filter(Boolean);
  if (missing.length === 0 && errors.length === 0) return null;
  const parts: string[] = [];
  if (missing.length > 0) parts.push(`no se generó la caché de ${missing.length === 1 ? 'la pista' : 'las pistas'} ${missing.join(', ')}`);
  if (errors.length > 0) parts.push(errors.join('; '));
  return parts.join(' — ');
}

interface Deps {
  getInvoke: () => Invoke | null;
  /** Aviso visible para el usuario (toast). */
  notice: (msg: string) => void;
}

export class NativeCacheManager {
  private readonly listeners = new Set<() => void>();
  private readonly importProgressByProject = new Map<string, NativeImportProgress>();
  private readonly generatingCachePromises = new Map<string, Promise<boolean>>();
  /** Último estado conocido de la caché PCM nativa por proyecto (para pintar la interfaz de forma síncrona). */
  private readonly nativeReadyByProject = new Map<string, boolean>();
  /** Pistas de cada proyecto, para poder re-consultar el estado al terminar una importación. */
  private readonly trackIdsByProject = new Map<string, string[]>();

  constructor(private readonly deps: Deps) {}

  // ---------------------------------------------------------------------------------------------
  // Suscripción
  // ---------------------------------------------------------------------------------------------

  public subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  public notify(): void {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch (err) {
        console.warn('[NativeAudioEngine] Error en listener de caché:', err);
      }
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Avance de la decodificación
  // ---------------------------------------------------------------------------------------------

  /** Evento `audio://import-progress` del motor. */
  public handleProgressEvent(payload: any): void {
    if (!payload) return;
    const projId = payload.project_id || payload.projectId;
    let percent = Math.round(payload.percent || 0);
    const text = payload.track_name || '';
    const completed = Boolean(payload.completed);
    const totalTracks = Number(payload.total_tracks ?? payload.totalTracks ?? 0);
    // El backend envía cuántas pistas llevan terminadas; la que se está procesando es la siguiente.
    const rawIndex = Number(payload.track_index ?? payload.trackIndex ?? 0);
    let trackNumber = completed ? totalTracks : Math.min(rawIndex + 1, totalTracks || rawIndex + 1);

    // Los eventos salen de varios hilos y pueden llegar cruzados: mientras la importación sigue en
    // curso, ni el porcentaje ni el número de pista pueden retroceder.
    const prev = this.importProgressByProject.get(projId);
    if (prev && !prev.completed && !completed) {
      percent = Math.max(prev.percent, percent);
      trackNumber = Math.max(prev.trackNumber, trackNumber);
    }

    this.importProgressByProject.set(projId, {
      percent,
      text,
      completed,
      trackNumber,
      totalTracks,
    });

    this.notify();

    if (completed) {
      console.info(`[NativeAudioEngine] Importación de caché completada para proyecto '${projId}'`);
      this.recheckKnownProject(projId);
    }
  }

  public getImportProgress(projectId: string): NativeImportProgress | null {
    return this.importProgressByProject.get(projectId) || null;
  }

  public isProjectImporting(projectId: string): boolean {
    const prog = this.importProgressByProject.get(projectId);
    return Boolean(prog && !prog.completed);
  }

  public markImportStarted(projectId: string, text = 'Iniciando decodificación...', totalTracks = 0): void {
    this.importProgressByProject.set(projectId, {
      percent: 0,
      text,
      completed: false,
      trackNumber: 0,
      totalTracks,
    });
    this.notify();
  }

  public markImportCompleted(projectId: string): void {
    const prev = this.importProgressByProject.get(projectId);
    this.importProgressByProject.set(projectId, {
      percent: 100,
      text: 'Completado',
      completed: true,
      trackNumber: prev?.totalTracks ?? 0,
      totalTracks: prev?.totalTracks ?? 0,
    });
    this.notify();
    this.recheckKnownProject(projectId);
  }

  /** Texto "Pista N de M · P%" a partir del avance real emitido por el backend. */
  public formatImportProgress(projectId: string): string | null {
    const prog = this.importProgressByProject.get(projectId);
    if (!prog || prog.completed) return null;
    const pista = prog.totalTracks > 0 && prog.trackNumber > 0
      ? `Pista ${prog.trackNumber} de ${prog.totalTracks} · `
      : '';
    return `${pista}${prog.percent}%`;
  }

  // ---------------------------------------------------------------------------------------------
  // Estado de la caché
  // ---------------------------------------------------------------------------------------------

  /**
   * Estado conocido de la caché PCM nativa: `null` si aún no se consultó, `true`/`false` según el último
   * resultado del backend. Es síncrono para poder usarlo al renderizar tarjetas.
   */
  public isNativeCacheReady(projectId: string): boolean | null {
    const v = this.nativeReadyByProject.get(projectId);
    return v === undefined ? null : v;
  }

  /** Guarda el estado y avisa a los suscriptores solo si cambió (evita redibujados en bucle). */
  private setNativeReady(projectId: string, ready: boolean): void {
    const prev = this.nativeReadyByProject.get(projectId);
    this.nativeReadyByProject.set(projectId, ready);
    if (prev !== ready) this.notify();
  }

  /** Re-consulta el estado de un proyecto cuyas pistas ya conocemos (p. ej. al terminar una importación). */
  private recheckKnownProject(projectId: string): void {
    const trackIds = this.trackIdsByProject.get(projectId);
    if (!trackIds) return;
    this.queryCacheStatus(projectId, trackIds).catch((err) => {
      console.error(`[NativeAudioEngine] Error re-consultando la caché de '${projectId}':`, err);
    });
  }

  /** Consulta varias canciones a la vez (p. ej. el setlist al abrir la app o al cambiar). */
  public async refreshCacheStatuses(projects: SongProject[]): Promise<void> {
    await Promise.all(projects.map((p) => this.checkProjectCacheStatus(p)));
  }

  /** Consulta al backend y actualiza el estado síncrono. Lanza si el backend falla. */
  private async queryCacheStatus(projectId: string, trackIds: string[]): Promise<CacheStatus> {
    const invoke = this.deps.getInvoke();
    if (!invoke) return { isReady: false, cachedCount: 0, totalCount: trackIds.length };

    const res: any = await invoke('audio_get_project_cache_status', {
      projectId,
      sampleRate: null,
      trackIds,
    });
    const isReady = Boolean(res?.isReady);
    this.setNativeReady(projectId, isReady);
    return {
      isReady,
      cachedCount: res?.cachedTracksCount || 0,
      totalCount: res?.totalTracksCount || trackIds.length,
    };
  }

  public async checkProjectCacheStatus(project: SongProject): Promise<CacheStatus> {
    const trackIds = project.tracks.map((t) => t.id);
    this.trackIdsByProject.set(project.id, trackIds);
    try {
      return await this.queryCacheStatus(project.id, trackIds);
    } catch (err) {
      console.error(`[NativeAudioEngine] Error consultando el estado de la caché de '${project.id}':`, err);
      this.setNativeReady(project.id, false);
      return { isReady: false, cachedCount: 0, totalCount: trackIds.length };
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Generar la caché
  // ---------------------------------------------------------------------------------------------

  /**
   * Genera la caché PCM nativa de un proyecto. Nunca lanza dos decodificaciones a la vez
   * para el mismo proyecto: si ya hay una en curso (propia o iniciada por otro camino,
   * `isProjectImporting`), espera a esa y devuelve si la caché quedó lista.
   */
  public async generateNativeCacheForProject(
    project: SongProject,
    onProgress?: (percent: number, text: string) => void
  ): Promise<boolean> {
    const inFlight = this.generatingCachePromises.get(project.id);
    if (inFlight) {
      const unsubscribe = this.forwardRealProgress(project.id, onProgress);
      try {
        return await inFlight;
      } finally {
        unsubscribe();
      }
    }

    if (this.isProjectImporting(project.id)) {
      const unsubscribe = this.forwardRealProgress(project.id, onProgress);
      try {
        await this.waitForImportToFinish(project.id);
        return (await this.checkProjectCacheStatus(project)).isReady;
      } finally {
        unsubscribe();
      }
    }

    this.trackIdsByProject.set(project.id, project.tracks.map((t) => t.id));
    this.markImportStarted(project.id, 'Preparando decodificación...', project.tracks.length);
    const unsubscribe = this.forwardRealProgress(project.id, onProgress);
    const task = this.runGenerateNativeCache(project, onProgress).finally(() => {
      // Si el backend no llegó a emitir `completed` (error/cancelación), no dejar el proyecto
      // marcado como "importando" para siempre.
      if (this.isProjectImporting(project.id)) this.markImportCompleted(project.id);
      this.generatingCachePromises.delete(project.id);
      unsubscribe();
    });
    this.generatingCachePromises.set(project.id, task);
    return task;
  }

  /** Reenvía a `onProgress` el avance real (audio://import-progress) mientras dure la decodificación. */
  private forwardRealProgress(
    projectId: string,
    onProgress?: (percent: number, text: string) => void
  ): () => void {
    if (!onProgress) return () => {};
    return this.subscribe(() => {
      const prog = this.importProgressByProject.get(projectId);
      if (!prog || prog.completed || prog.trackNumber === 0) return;
      const label = this.formatImportProgress(projectId) ?? `${prog.percent}%`;
      onProgress(prog.percent, `${label}${prog.text ? ` · ${prog.text}` : ''}`);
    });
  }

  private waitForImportToFinish(projectId: string): Promise<void> {
    return new Promise((resolve) => {
      if (!this.isProjectImporting(projectId)) return resolve();
      const unsubscribe = this.subscribe(() => {
        if (!this.isProjectImporting(projectId)) {
          unsubscribe();
          resolve();
        }
      });
    });
  }

  private async runGenerateNativeCache(
    project: SongProject,
    onProgress?: (percent: number, text: string) => void
  ): Promise<boolean> {
    const invoke = this.deps.getInvoke();
    if (!invoke) return false;

    try {
      onProgress?.(5, 'Comprobando rutas de origen...');

      // 1. INTENTO 1: Rutas de archivos originales en disco (track.filePath)
      const tracksWithPaths = project.tracks.filter((t) => Boolean(t.filePath));
      if (tracksWithPaths.length === project.tracks.length && tracksWithPaths.length > 0) {
        const paths = tracksWithPaths.map((t) => t.filePath!);
        const existResults = await checkFilesExist(paths);
        const allExist = existResults.every(Boolean);

        if (allExist) {
          onProgress?.(15, `Decodificando ${paths.length} pistas desde rutas originales...`);
          const filesToImport = tracksWithPaths.map((t) => ({
            filePath: t.filePath!,
            trackId: t.id,
          }));

          const res: any = await invoke('audio_import_tracks', {
            projectId: project.id,
            files: filesToImport,
            targetSampleRate: null,
          });

          const problem = importIncompleteReason(res, project.tracks.map((t) => t.id));
          if (!problem && res?.tracks && res.tracks.length > 0) {
            onProgress?.(100, `¡Caché nativa generada para ${res.tracks.length} pistas!`);
            this.notify();
            await this.checkProjectCacheStatus(project);
            return true;
          }
          if (problem && res?.tracks && res.tracks.length > 0) {
            // Caché parcial: se refresca el estado (no queda «lista») y se avisa con el motivo.
            this.notify();
            await this.checkProjectCacheStatus(project);
            throw new Error(`Caché incompleta: ${problem}`);
          }
        }
      }

      // 2. INTENTO 2: Audios guardados en almacenamiento IndexedDB (versión web o drag & drop)
      onProgress?.(20, 'Buscando pistas en almacenamiento local (IndexedDB)...');
      const stems = await loadProjectStemsFromDb(project.id);
      if (stems && stems.length > 0) {
        const total = stems.length;
        let completed = 0;
        const importedIds = new Set<string>();

        for (let i = 0; i < total; i++) {
          const stem = stems[i];
          const label = stem.fileName || stem.trackId;
          onProgress?.(
            Math.round(20 + ((i + 1) / total) * 75),
            `Decodificando "${label}" (${i + 1}/${total})...`
          );

          const arrayBuf = await extractStemArrayBuffer(stem);
          if (!arrayBuf || arrayBuf.byteLength === 0) continue;

          await importTrackBytesRaw(
            project.id,
            stem.trackId,
            stem.fileName || `${stem.trackId}.mp3`,
            new Uint8Array(arrayBuf)
          );
          completed++;
          importedIds.add(stem.trackId);
        }

        if (completed > 0) {
          this.notify();
          await this.checkProjectCacheStatus(project);
          const problem = importIncompleteReason({ tracks: [...importedIds].map((trackId) => ({ trackId })) }, project.tracks.map((t) => t.id));
          if (problem) throw new Error(`Caché incompleta: ${problem}`);
          onProgress?.(100, `¡Caché nativa generada para ${completed} pistas!`);
          return true;
        }
      }

      // 3. INTENTO 3: Solicitar carpeta con selector nativo de Windows
      onProgress?.(30, `Solicitando carpeta original para "${project.title}"...`);
      const selectedFolder = await pickNativeFolder();
      if (!selectedFolder) {
        throw new Error('Operación cancelada: no se seleccionó ninguna carpeta.');
      }

      onProgress?.(45, `Escaneando carpeta "${selectedFolder}"...`);
      const scanned = await scanNativeFolder(selectedFolder);
      if (!scanned.files || scanned.files.length === 0) {
        throw new Error('No se encontraron archivos de audio compatibles en la carpeta seleccionada.');
      }

      const filesToImport = scanned.files.map((file, idx) => {
        const matchedTrack = project.tracks.find(
          (t) => t.name.toLowerCase() === file.trackName.toLowerCase() || t.fileName === file.fileName
        );
        const trackId = matchedTrack ? matchedTrack.id : project.tracks[idx]?.id || file.trackId;
        if (matchedTrack) matchedTrack.filePath = file.filePath;
        return {
          filePath: file.filePath,
          trackId,
        };
      });

      onProgress?.(60, `Decodificando ${filesToImport.length} pistas...`);
      const res: any = await invoke('audio_import_tracks', {
        projectId: project.id,
        files: filesToImport,
        targetSampleRate: null,
      });

      if (res?.tracks && res.tracks.length > 0) {
        this.notify();
        await this.checkProjectCacheStatus(project);
        const problem = importIncompleteReason(res, project.tracks.map((t) => t.id));
        if (problem) throw new Error(`Caché incompleta: ${problem}`);
        onProgress?.(100, `¡Caché nativa generada para ${res.tracks.length} pistas!`);
        return true;
      }

      throw new Error('No se generaron pistas en la caché.');
    } catch (err: any) {
      const msg = err?.message || String(err);
      console.error('[NativeAudioEngine] Error generando caché nativa:', err);
      onProgress?.(0, `Error: ${msg}`);
      this.deps.notice(`Error al generar caché nativa: ${msg}`);
      return false;
    }
  }
}
