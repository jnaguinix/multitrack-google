import { useCallback } from 'react';
import { logAsyncError } from '../utils/asyncErrors';
import type { OutputBus, SongProject } from '../types/project';
import { saveProjectToDb } from '../storage/projectDb';
import { loadTrackMapMemory, rememberTrackMapping } from '../utils/trackMapMemory';
import { findSongFingerprintMatches, TrackSummary } from '../audio/fingerprint';
import { scanNativeFolder, scanNativeFiles, ScannedFolderInfo } from '../utils/nativeDialog';
import { audioEngine } from '../audio/audioEngine';
import { nativeAudioEngine } from '../audio/nativeAudioEngine';
import {
  applyDecodedTracks,
  buildImportedTracks,
  buildWizardFiles,
  buildWizardMeta,
  importedSongBecomesMounted,
  mergeReimportedTracks,
  newImportedSong,
  scannedSections,
} from '../utils/nativeImportPlan';
import type { ImportFlowDeps } from './useImportFlow';

/**
 * Importación nativa de escritorio: las rutas de la carpeta o de los archivos pasan directamente al motor en Rust.
 * JavaScript nunca lee los bytes del audio; la canción aparece al momento en la biblioteca y, si ya está en el
 * setlist, se decodifica en segundo plano.
 */
export function useNativeImport({
  projects,
  projectsRef,
  currentProjectRef,
  setProjects,
  setCurrentProject,
  showToast,
  setImportStatusText,
  setFingerprintPrompt,
  setMissingNativeCache,
  requestImportWizard,
}: ImportFlowDeps) {
  return useCallback(
    async (
      source: { folderPath?: string; filePaths?: string[] },
      defaultBus: OutputBus = 'main',
      importMode: 'new-song' | 'current-song' = 'new-song'
    ) => {
      const invoke = (window as any).__TAURI__?.core?.invoke;
      if (!invoke) return;

      const t0 = performance.now();
      const baseTimestamp = Date.now();
      const effectiveMode =
        importMode === 'current-song' && !currentProjectRef.current ? 'new-song' : importMode;
      let targetProjectId =
        effectiveMode === 'new-song'
          ? `song-${baseTimestamp}`
          : currentProjectRef.current!.id;

      try {
        let scanned: ScannedFolderInfo;
        if (source.folderPath) {
          scanned = await scanNativeFolder(source.folderPath);
        } else if (source.filePaths && source.filePaths.length > 0) {
          scanned = await scanNativeFiles(source.filePaths);
        } else {
          return;
        }

        if (scanned.files.length === 0) {
          showToast('No se encontraron pistas de audio compatibles en la selección.');
          return;
        }

        // Track fingerprinting check:
        // Rule: Only considers two songs to be the same if track count matches within ±1
        // and at least 80% (>= 0.80) of tracks match in size and duration.
        // If match is partial (0.80 <= ratio < 1.0) or multiple candidates, prompt the user.
        const incomingSummaries: TrackSummary[] = scanned.files.map((f) => ({
          fileSize: f.fileSize ?? undefined,
          durationSec: f.estDurationSec ?? undefined,
          name: f.trackName,
          fileName: f.fileName,
        }));

        let existingCandidate: SongProject | null = null;

        if (effectiveMode === 'new-song') {
          const fingerprintCandidates = findSongFingerprintMatches(
            incomingSummaries,
            projectsRef.current
          );

          if (fingerprintCandidates.length > 0) {
            const topCandidate = fingerprintCandidates[0];
            const isExactSingleMatch =
              fingerprintCandidates.length === 1 && topCandidate.matchRatio === 1.0;

            if (isExactSingleMatch) {
              // 100% exact match and unique candidate: update existing song without prompt
              existingCandidate = topCandidate.song;
            } else {
              // Partial match (80% <= ratio < 100%) OR multiple candidates: ask user!
              const sourceLabel =
                scanned.folderName || scanned.title || (scanned.files[0]?.trackName ?? 'Audio');
              const userChoice = await new Promise<SongProject | null | 'cancel'>((resolve) => {
                setFingerprintPrompt({
                  candidates: fingerprintCandidates,
                  incomingTrackCount: scanned.files.length,
                  sourceLabel,
                  resolve,
                });
              });

              if (userChoice === 'cancel') {
                return;
              } else if (userChoice !== null) {
                existingCandidate = userChoice;
              } else {
                existingCandidate = null;
              }
            }
          } else {
            // Secondary fallback: check by exact folderPath
            const folderMatch = scanned.folderPath
              ? projectsRef.current.find(
                  (p) =>
                    p.folderPath &&
                    scanned.folderPath &&
                    p.folderPath.toLowerCase() === scanned.folderPath.toLowerCase()
                )
              : null;
            if (folderMatch) {
              existingCandidate = folderMatch;
            }
          }

          if (existingCandidate) {
            targetProjectId = existingCandidate.id;
          }
        }

        // ---- Asistente: el usuario escribe los datos de la canción y elige a mano el instrumento de cada pista.
        const current = effectiveMode === 'current-song' ? currentProjectRef.current : null;
        const wizard = await requestImportWizard({
          mode: effectiveMode === 'new-song' ? 'new-song' : 'add-tracks',
          initialMeta: buildWizardMeta(scanned, existingCandidate, current),
          files: buildWizardFiles(scanned, existingCandidate, loadTrackMapMemory()),
        });
        if (!wizard) return;
        const meta = wizard.meta;
        rememberTrackMapping(
          wizard.rows.map((r, i) => ({ fileName: scanned.files[i].fileName, instrumentId: r.instrumentId }))
        );

        const { initialTracks, renamedExisting, maxDurationSec } = buildImportedTracks(
          scanned,
          wizard,
          current?.tracks ?? []
        );

        const bpm = effectiveMode === 'new-song' ? meta.bpm : current?.bpm || 120;
        const beatsPerBar = effectiveMode === 'new-song' ? meta.beatsPerBar : current?.beatsPerBar || 4;
        const secPerBar = (60 / bpm) * beatsPerBar;

        const initialDurationSec = maxDurationSec > 1 ? maxDurationSec : 180;
        const initialBars = Math.max(4, Math.ceil(initialDurationSec / secPerBar));
        const initialSections = scannedSections(scanned);

        let newSongProject: SongProject;
        if (effectiveMode === 'new-song') {
          if (existingCandidate) {
            // Re-importing existing song: keep user edits, sections and mix settings!
            newSongProject = {
              ...existingCandidate,
              title: meta.title,
              artist: meta.artist,
              keySignature: meta.key,
              bpm: meta.bpm,
              beatsPerBar: meta.beatsPerBar,
              isTitleCustom: true,
              totalBars: initialBars,
              durationSec: initialDurationSec,
              tracks: mergeReimportedTracks(initialTracks, existingCandidate),
              sections: existingCandidate.sections.length > 0 ? existingCandidate.sections : initialSections,
              inSetlist: existingCandidate.inSetlist ?? false,
              setlistOrder: existingCandidate.setlistOrder,
              folderPath: scanned.folderPath || existingCandidate.folderPath,
              updatedAt: Date.now(),
            };

            // Solo si pasa a ser la canción de la consola: si no, el motor y el audio que suena no se tocan.
            if (importedSongBecomesMounted(newSongProject, currentProjectRef.current?.id)) {
              audioEngine.prepareProjectShell(newSongProject);
              setMissingNativeCache(false);
              setCurrentProject(newSongProject);
            }
            setProjects((prev) =>
              prev.map((p) => (p.id === newSongProject.id ? newSongProject : p))
            );
            saveProjectToDb(newSongProject).catch(logAsyncError('guardar la canción'));
          } else {
            newSongProject = newImportedSong({
              id: targetProjectId,
              meta,
              bpm,
              beatsPerBar,
              folderPath: scanned.folderPath,
              totalBars: initialBars,
              durationSec: initialDurationSec,
              sections: initialSections,
              tracks: initialTracks,
            });

            // Una canción nueva entra en la biblioteca, no en la consola: no se toca el motor ni lo que suena.
            // (Antes, prepareProjectShell cambiaba la canción del motor y detenía el audio.)
            if (importedSongBecomesMounted(newSongProject, currentProjectRef.current?.id)) {
              audioEngine.prepareProjectShell(newSongProject);
              setMissingNativeCache(false);
              setCurrentProject(newSongProject);
            }
            setProjects((prev) => [newSongProject, ...prev]);
            saveProjectToDb(newSongProject).catch(logAsyncError('guardar la canción'));
          }
        } else {
          const combinedTracks = [...renamedExisting, ...initialTracks];
          const nextDurationSec = Math.max(current!.durationSec || 0, initialDurationSec);
          const nextTotalBars = Math.max(current!.totalBars, initialBars);

          newSongProject = {
            ...current!,
            totalBars: nextTotalBars,
            durationSec: nextDurationSec,
            tracks: combinedTracks,
            updatedAt: Date.now(),
          };

          setMissingNativeCache(false);
          audioEngine.updateProjectConfig(newSongProject);
          setCurrentProject(newSongProject);
          setProjects((prev) =>
            prev.map((p) => (p.id === newSongProject.id ? newSongProject : p))
          );
          saveProjectToDb(newSongProject).catch(logAsyncError('guardar la canción'));
        }

        const mountMs = performance.now() - t0;

        // Diseño aprobado: importar solo escanea y guarda metadatos (library.json + sidecar).
        // La caché PCM se crea al añadir la canción al setlist o al cargarla sin caché.
        // Solo se decodifica aquí si la canción YA está en el setlist (p. ej. se fusionó con una existente).
        if (!newSongProject.inSetlist) {
          console.info(
            `[NativeImport] "${newSongProject.title}" importada en biblioteca en ${mountMs.toFixed(1)} ms (${scanned.files.length} pistas, solo metadatos; caché PCM diferida al añadir al setlist).`
          );
          showToast(`"${newSongProject.title}": añadida a la biblioteca (${scanned.files.length} pistas).`);
          return;
        }

        console.info(
          `[NativeImport] "${newSongProject.title}" montada en UI en ${mountMs.toFixed(1)} ms. Decodificando ${scanned.files.length} pistas en segundo plano (ya está en el setlist)...`
        );

        nativeAudioEngine.markImportStarted(
          targetProjectId,
          `Decodificando ${scanned.files.length} pistas...`,
          scanned.files.length
        );
        setImportStatusText(`Convirtiendo ${scanned.files.length} pistas en segundo plano (0%)...`);
        const unsubscribeImportProgress = nativeAudioEngine.subscribeCache(() => {
          const live = nativeAudioEngine.formatImportProgress(targetProjectId);
          if (live) setImportStatusText(`Convirtiendo "${newSongProject.title}": ${live}`);
        });
        showToast(`"${newSongProject.title}": montada en biblioteca. Decodificando pistas...`);

        const importedIds = new Set(initialTracks.map((tr) => tr.id));
        const filesToImport = scanned.files
          .filter((f) => importedIds.has(f.trackId))
          .map((f) => ({
            filePath: f.filePath,
            trackId: f.trackId,
          }));

        invoke('audio_import_tracks', {
          projectId: targetProjectId,
          files: filesToImport,
          targetSampleRate: null,
        })
          .then((importResult: any) => {
            unsubscribeImportProgress();
            nativeAudioEngine.markImportCompleted(targetProjectId);
            setImportStatusText(null);
            if (importResult?.tracks) {
              const { tracks: updatedTracks, durationSec: updatedDuration } = applyDecodedTracks(
                newSongProject,
                importResult.tracks
              );

              const completedProject: SongProject = {
                ...newSongProject,
                durationSec: updatedDuration,
                tracks: updatedTracks,
                updatedAt: Date.now(),
              };

              setProjects((prev) =>
                prev.map((p) => (p.id === targetProjectId ? completedProject : p))
              );
              saveProjectToDb(completedProject).catch(logAsyncError('guardar la canción'));

              const isStillCurrent =
                !currentProjectRef.current || currentProjectRef.current.id === targetProjectId;
              if (isStillCurrent) {
                setCurrentProject(completedProject);
                setMissingNativeCache(false);

                nativeAudioEngine
                  .loadProject(completedProject)
                  .then(() => {
                    showToast(`"${completedProject.title}": lista para reproducir.`);
                    console.info(`[NativeImport] "${completedProject.title}" cargada en motor nativo.`);
                  })
                  .catch((loadErr) => {
                    console.error('[NativeImport] Error cargando proyecto en motor nativo:', loadErr);
                    showToast(`Pistas decodificadas, pero ocurrió un error al cargar: ${loadErr}`);
                  });
              } else {
                showToast(`"${completedProject.title}": decodificación completada en biblioteca.`);
              }
            }
          })
          .catch((importErr: any) => {
            unsubscribeImportProgress();
            nativeAudioEngine.markImportCompleted(targetProjectId);
            console.error('[NativeImport] Error en decodificación de pistas:', importErr);
            setImportStatusText(null);
            showToast(`Error al decodificar pistas: ${importErr}`);
          });
      } catch (scanErr) {
        console.error('[NativeImport] Error escaneando audio:', scanErr);
        showToast(`Error al leer carpeta/archivos: ${scanErr}`);
      }
    },
    [projects.length, showToast]
  );
}
