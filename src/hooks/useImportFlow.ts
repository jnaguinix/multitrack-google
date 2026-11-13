import { useCallback } from 'react';
import {
  OutputBus,
  SongProject,
  SongSection,
  TrackChannel,
} from '../types/project';
import { inferSongMetadataFromFiles } from '../audio/smartAnalyzer';
import {
  findSavedProjectPreset,
  mergeSavedProjectMetadata,
  registerProjectDirHandle,
  saveProjectToDb,
  saveStemsBatchToDb,
  StoredAudioStem,
} from '../storage/projectDb';
import { ensureStoragePersist, isOpfsSupported } from '../storage/opfsStorage';
import {
  extractAudioFilesFromFileList,
  extractSidecarFromFileList,
  parseWavHeaderFast,
} from '../utils/fileImportHelper';
import { inferTrackRoleAndColor } from '../components/LibraryAndModals';
import {
  findSongFingerprintMatches,
  FingerprintCandidate,
  TrackSummary,
} from '../audio/fingerprint';
import {
  scanNativeFolder,
  scanNativeFiles,
  importTrackBytesRaw,
  ScannedFolderInfo,
} from '../utils/nativeDialog';
import { getRegisteredHandle } from '../storage/sourceFiles';
import { audioEngine } from '../audio/audioEngine';
import { nativeAudioEngine } from '../audio/nativeAudioEngine';

const MARKER_PALETTE = [
  '#06B6D4',
  '#3B82F6',
  '#10B981',
  '#F59E0B',
  '#8B5CF6',
  '#EC4899',
  '#EF4444',
];

interface UseImportFlowDeps {
  projects: SongProject[];
  projectsRef: React.MutableRefObject<SongProject[]>;
  currentProjectRef: React.MutableRefObject<SongProject | null>;
  setProjects: React.Dispatch<React.SetStateAction<SongProject[]>>;
  setCurrentProject: React.Dispatch<React.SetStateAction<SongProject | null>>;
  showToast: (msg: string) => void;
  setImportStatusText: React.Dispatch<React.SetStateAction<string | null>>;
  setFingerprintPrompt: React.Dispatch<
    React.SetStateAction<{
      candidates: FingerprintCandidate[];
      incomingTrackCount: number;
      sourceLabel: string;
      resolve: (choice: SongProject | null | 'cancel') => void;
    } | null>
  >;
  setMissingNativeCache: React.Dispatch<React.SetStateAction<boolean>>;
  runAutoOptimizeRef: React.MutableRefObject<(projectId: string) => void>;
}

export function useImportFlow({
  projects,
  projectsRef,
  currentProjectRef,
  setProjects,
  setCurrentProject,
  showToast,
  setImportStatusText,
  setFingerprintPrompt,
  setMissingNativeCache,
  runAutoOptimizeRef,
}: UseImportFlowDeps) {
  /**
   * INSTANT NON-BLOCKING STEM & FOLDER IMPORT PIPELINE
   * Uses controlled parallel decoding (batches of 3), immediate SetlistRamCache storage,
   * and a single atomic IndexedDB transaction storing native File Blobs.
   */
  const handleInstantImportFiles = useCallback(
    async (
      fileList: FileList | File[],
      defaultBus: OutputBus = 'main',
      importMode: 'new-song' | 'current-song' = 'new-song'
    ) => {
      const t0 = performance.now();
      // Conditional branch: Desktop native audio import vs Web Audio import
      const isDesktopApp = typeof window !== 'undefined' && Boolean((window as any).__TAURI__);
      if (isDesktopApp) {
        // En escritorio (Fase 1 preparada / Fase 2 ejecución), el motor nativo
        // asume el procesamiento en Rust. La ruta web inferior se mantiene 100% intacta.
        console.info('[AudioImport][Desktop] Importación de audio en entorno nativo Tauri');
      }

      const validFiles = extractAudioFilesFromFileList(fileList);

      if (validFiles.length === 0) {
        showToast('No se encontraron archivos de audio compatibles (.wav, .mp3, .ogg, .flac, .m4a)');
        return;
      }

      const effectiveMode =
        importMode === 'current-song' && currentProjectRef.current
          ? 'current-song'
          : 'new-song';

      // Misma regla que la importación nativa: no duplicar una canción que ya está en la biblioteca.
      // Los archivos del selector o del arrastre solo traen el tamaño, así que se compara por tamaño.
      if (effectiveMode === 'new-song') {
        const incoming: TrackSummary[] = validFiles.map((f) => ({
          fileSize: f.size,
          name: f.name,
          fileName: f.name,
        }));
        const matches = findSongFingerprintMatches(incoming, projectsRef.current);
        if (matches.length > 0) {
          const top = matches[0];
          if (matches.length === 1 && top.matchRatio === 1.0) {
            showToast(`"${top.song.title}" ya está en la biblioteca: no se importó de nuevo.`);
            return;
          }
          const firstPath = (validFiles[0] as File & { webkitRelativePath?: string }).webkitRelativePath;
          const sourceLabel = (firstPath && firstPath.split('/')[0]) || validFiles[0].name;
          const userChoice = await new Promise<SongProject | null | 'cancel'>((resolve) => {
            setFingerprintPrompt({
              candidates: matches,
              incomingTrackCount: validFiles.length,
              sourceLabel,
              resolve,
            });
          });
          if (userChoice === 'cancel') return;
          if (userChoice !== null) {
            showToast(`Se conserva "${userChoice.title}" de la biblioteca: no se duplicó.`);
            return;
          }
          // userChoice === null: el usuario pidió importarla como canción nueva.
        }
      }

      const baseTimestamp = Date.now();
      const targetProjectId =
        effectiveMode === 'new-song'
          ? `song-${baseTimestamp}`
          : currentProjectRef.current!.id;

      const { songTitle, detectedBpm, detectedKey, cleanTrackNames } =
        inferSongMetadataFromFiles(validFiles);

      // Check if the imported folder contains an omnitracks.project.json sidecar (or local preset memory)
      const folderSidecar =
        effectiveMode === 'new-song' ? await extractSidecarFromFileList(fileList) : null;
      const savedMetadata =
        effectiveMode === 'new-song'
          ? folderSidecar ||
            findSavedProjectPreset(
              songTitle,
              validFiles.map((f) => f.name)
            )
          : null;

      const bpm =
        effectiveMode === 'new-song'
          ? savedMetadata?.bpm || detectedBpm || 120
          : currentProjectRef.current!.bpm;
      const beatsPerBar =
        effectiveMode === 'new-song'
          ? savedMetadata?.beatsPerBar || 4
          : currentProjectRef.current!.beatsPerBar;
      const secPerBar = (60 / bpm) * beatsPerBar;

      // Request storage persistence in background without blocking
      ensureStoragePersist().catch(() => {});

      // =========================================================================
      // PHASE 1: SUB-MILLISECOND WAV HEADER INSPECTION & INSTANT UI/ENGINE MOUNT
      // =========================================================================
      const wavHeaders = await Promise.all(validFiles.map((f) => parseWavHeaderFast(f)));

      const initialTracks: TrackChannel[] = [];
      const stemsToSaveBatch: StoredAudioStem[] = [];
      let headerMaxDurationSec = 0;

      for (let idx = 0; idx < validFiles.length; idx++) {
        const file = validFiles[idx];
        const trackId = `stem-${baseTimestamp}-${String(idx).padStart(2, '0')}`;
        const trackLabel = cleanTrackNames[idx] || file.name.replace(/\.[^/.]+$/, '');
        const inferred = inferTrackRoleAndColor(trackLabel, idx);
        const wavInfo = wavHeaders[idx];
        const estDuration = wavInfo?.durationSec || 0;

        if (estDuration > headerMaxDurationSec) {
          headerMaxDurationSec = estDuration;
        }

        const newTrack: TrackChannel = {
          id: trackId,
          name: trackLabel,
          role: inferred.role,
          color: inferred.color,
          gain: 1.0,
          pan: 0,
          muted: false,
          soloed: false,
          bus: inferred.bus === 'cue-click' ? 'cue-click' : defaultBus,
          peaks: [],
          isCustomAudio: true,
          fileName: file.name,
          // El tamaño permite reconocer la misma canción si se vuelve a importar.
          fileSize: file.size,
          durationSec: estDuration > 0 ? estDuration : undefined,
        };

        initialTracks.push(newTrack);
        // Reference-based library: keep a handle to the original file when the browser gives
        // one (Chrome/Edge); otherwise fall back to copying the Blob into IndexedDB.
        const sourceHandle = getRegisteredHandle(file);
        if (sourceHandle?.dir) {
          registerProjectDirHandle(targetProjectId, sourceHandle.dir);
        }
        stemsToSaveBatch.push(
          sourceHandle
            ? {
                key: `${targetProjectId}:${trackId}`,
                projectId: targetProjectId,
                trackId,
                fileHandle: sourceHandle.file,
                dirHandle: sourceHandle.dir,
                mimeType: file.type || 'audio/wav',
                fileName: file.name,
              }
            : {
                key: `${targetProjectId}:${trackId}`,
                projectId: targetProjectId,
                trackId,
                blob: file,
                mimeType: file.type || 'audio/wav',
                fileName: file.name,
              }
        );
      }

      // Desktop Native Audio Import Pipeline (Fase 2: Decodificación y Caché en Rust)
      if (isDesktopApp) {
        try {
          const invoke = (window as any).__TAURI__?.core?.invoke;
          if (invoke) {
            const hasPaths = validFiles.some((f) => Boolean((f as any).path));
            if (hasPaths) {
              const filesToImport = validFiles
                .filter((f) => Boolean((f as any).path))
                .map((f, idx) => ({
                  filePath: (f as any).path as string,
                  trackId: initialTracks[idx].id,
                }));

              const importResult: { tracks: any[]; errors: string[] } = await invoke('audio_import_tracks', {
                projectId: targetProjectId,
                files: filesToImport,
                targetSampleRate: null,
              });

              for (const meta of importResult.tracks) {
                const matchedTrack = initialTracks.find((t) => t.id === meta.trackId);
                if (matchedTrack) {
                  matchedTrack.peaks = meta.peaks;
                  matchedTrack.durationSec = meta.durationSec;
                  matchedTrack.pcm = {
                    sampleRate: meta.targetSampleRate,
                    channels: meta.channels,
                    frames: meta.frameCount,
                    version: 1,
                  };
                  if (meta.durationSec > headerMaxDurationSec) {
                    headerMaxDurationSec = meta.durationSec;
                  }
                }
              }
            } else {
              // Si los archivos se seleccionaron mediante el selector HTML o drag-and-drop sin path nativo en Chromium:
              // No se omite: enviamos los bytes directamente a Rust (audio_import_track_bytes) para asegurar la caché nativa!
              console.info('[AudioImport][Desktop] Transfiriendo stems a Rust para generar caché nativa...');
              for (let idx = 0; idx < validFiles.length; idx++) {
                const file = validFiles[idx];
                const trackId = initialTracks[idx].id;
                try {
                  const arrayBuf = await file.arrayBuffer();
                  const rawBytes = new Uint8Array(arrayBuf);
                  const meta: any = await importTrackBytesRaw(targetProjectId, trackId, file.name, rawBytes);
                  const matchedTrack = initialTracks.find((t) => t.id === trackId);
                  if (matchedTrack && meta) {
                    matchedTrack.peaks = meta.peaks;
                    matchedTrack.durationSec = meta.durationSec;
                    matchedTrack.pcm = {
                      sampleRate: meta.targetSampleRate,
                      channels: meta.channels,
                      frames: meta.frameCount,
                      version: 1,
                    };
                    if (meta.durationSec > headerMaxDurationSec) {
                      headerMaxDurationSec = meta.durationSec;
                    }
                  }
                } catch (byteErr) {
                  console.warn(`[AudioImport][Desktop] Error importando pista ${trackId} por bytes:`, byteErr);
                }
              }
            }
          }
        } catch (desktopErr) {
          console.warn('[AudioImport][Desktop] Fallo en decodificación nativa Rust:', desktopErr);
        }
      }

      const initialDurationSec =
        headerMaxDurationSec > 1
          ? headerMaxDurationSec
          : effectiveMode === 'current-song'
          ? currentProjectRef.current?.durationSec || 180
          : savedMetadata?.durationSec && savedMetadata.durationSec > 1
          ? savedMetadata.durationSec
          : 180;

      const initialBars = Math.max(4, Math.ceil(initialDurationSec / secPerBar));
      let effectiveSongTitle = songTitle;
      let restoredSectionsCount = 0;

      if (effectiveMode === 'new-song') {
        const baseSongProject: SongProject = {
          id: targetProjectId,
          title: songTitle,
          artist: 'Sesión Importada',
          folder: 'imported',
          inSetlist: false,
          setlistOrder: undefined,
          bpm,
          beatsPerBar: 4,
          beatUnit: 4,
          keySignature: detectedKey || 'C Major',
          totalBars: initialBars,
          durationSec: initialDurationSec,
          quantizeMode: 'immediate',
          splitRoutingMode: 'stereo',
          clickEnabled: false,
          clickGain: 1.0,
          clickSubdivision: 1,
          guideCuesEnabled: true,
          guideVoiceReadout: true,
          guideGain: 1.0,
          masterGain: 1.0,
          cueMasterGain: 1.0,
          pitchSemitones: 0,
          sections: [],
          tracks: initialTracks,
          updatedAt: Date.now(),
        };

        const newSongProject: SongProject = savedMetadata
          ? mergeSavedProjectMetadata(baseSongProject, savedMetadata)
          : baseSongProject;

        effectiveSongTitle = newSongProject.title;
        restoredSectionsCount = newSongProject.sections.length;

        // Mount project shell and mixer nodes in < 1 ms
        audioEngine.prepareProjectShell(newSongProject);
        setCurrentProject(newSongProject);
        setProjects((prev) => [newSongProject, ...prev]);
        saveProjectToDb(newSongProject).catch(() => {});
      } else {
        const current = currentProjectRef.current!;
        const combinedTracks = [...current.tracks, ...initialTracks];
        const nextDurationSec = Math.max(current.durationSec || 0, initialDurationSec);
        const nextTotalBars = Math.max(current.totalBars, initialBars);

        const updatedProject: SongProject = {
          ...current,
          totalBars: nextTotalBars,
          durationSec: nextDurationSec,
          tracks: combinedTracks,
          updatedAt: Date.now(),
        };

        audioEngine.updateProjectConfig(updatedProject);
        setCurrentProject(updatedProject);
        setProjects((prev) =>
          prev.map((p) => (p.id === updatedProject.id ? updatedProject : p))
        );
        saveProjectToDb(updatedProject).catch(() => {});
      }

      // Save native File Blob pointers to IndexedDB in background (zero re-encoding)
      const stemsSavePromise = saveStemsBatchToDb(stemsToSaveBatch).catch((err) =>
        console.warn('Background IndexedDB batch stem save warning:', err)
      );

      const mountMs = performance.now() - t0;
      console.info(
        `[AudioEngine][InstantImport] "${effectiveSongTitle}" (${initialTracks.length} pistas, ${restoredSectionsCount} marcadores) montada en consola en ${mountMs.toFixed(1)} ms`
      );

      // Desktop Native: Registramos la disponibilidad de la caché PCM nativa generada en Rust.
      // Hasta la Fase 6 (cuando el reproductor nativo reemplace por completo al Web Audio),
      // se conserva la ruta de optimización OPFS para que WebView2 siga sonando sin caídas a RAM.
      const isNativePcmReady =
        isDesktopApp &&
        initialTracks.length > 0 &&
        initialTracks.every((t) => Boolean(t.pcm) && t.pcm!.frames > 0);

      if (isNativePcmReady) {
        console.info(
          `[AudioImport][Desktop] Caché PCM nativa en Rust lista para "${effectiveSongTitle}" (${initialTracks.length} pistas).`
        );
      }

      // Single-pass pipeline: decode each stem ONCE, straight into the OPFS cache (peaks and
      // duration come from the same pass). No RAM decode of the whole song at import time.
      // En escritorio (isDesktopApp), la caché OPFS se omite por completo: el motor nativo usa su propia caché PCM en disco.
      if (isDesktopApp) {
        showToast(
          restoredSectionsCount > 0
            ? `"${effectiveSongTitle}" importada en motor nativo (${initialTracks.length} pistas · ${restoredSectionsCount} marcadores restaurados).`
            : `"${effectiveSongTitle}" importada en motor nativo (${initialTracks.length} pistas).`
        );
        await stemsSavePromise;
        return;
      }

      if (effectiveMode === 'new-song' && isOpfsSupported()) {
        showToast(
          restoredSectionsCount > 0
            ? `"${effectiveSongTitle}" importada (${initialTracks.length} pistas · ${restoredSectionsCount} marcadores restaurados). Preparando audio…`
            : `"${effectiveSongTitle}" importada (${initialTracks.length} pistas). Preparando el audio en segundo plano…`
        );
        await stemsSavePromise;
        runAutoOptimizeRef.current(targetProjectId);
        return;
      }

      showToast(
        effectiveMode === 'new-song'
          ? restoredSectionsCount > 0
            ? `Canción "${effectiveSongTitle}" montada (${initialTracks.length} pistas · ${restoredSectionsCount} marcadores restaurados)`
            : `Canción "${effectiveSongTitle}" montada en ${Math.max(1, Math.round(mountMs))} ms (${initialTracks.length} pistas)`
          : `${initialTracks.length} stem(s) montado(s) en ${Math.max(1, Math.round(mountMs))} ms`
      );

      // =========================================================================
      // PHASE 2: PARALLEL NATIVE C++ AUDIO BUFFER HYDRATION (ZERO OPFS WRITES)
      // =========================================================================
      let completedCount = 0;
      let maxDecodedDurationSec = headerMaxDurationSec;
      let anyDecoded = false;

      setImportStatusText(
        `Preparando audio 0/${validFiles.length} en segundo plano...`
      );

      const BATCH_SIZE = 4;
      for (let i = 0; i < validFiles.length; i += BATCH_SIZE) {
        const batchFiles = validFiles.slice(i, i + BATCH_SIZE);
        const batchTracks = initialTracks.slice(i, i + BATCH_SIZE);

        await Promise.all(
          batchFiles.map(async (file, batchIdx) => {
            const trk = batchTracks[batchIdx];
            try {
              const rawBuf = await file.arrayBuffer();
              const { audioBuffer, peaks, durationSec } =
                await audioEngine.decodeStemBuffer(rawBuf, trk.name, false);

              anyDecoded = true;
              completedCount++;
              if (durationSec > maxDecodedDurationSec) {
                maxDecodedDurationSec = durationSec;
              }

              setImportStatusText(
                completedCount < validFiles.length
                  ? `Preparando audio ${completedCount}/${validFiles.length}: ${trk.name}`
                  : null
              );

              const enrichedTrack: TrackChannel = {
                ...trk,
                peaks,
                durationSec,
              };

              // If this project is still the active project in the console, mount buffer live
              if (currentProjectRef.current?.id === targetProjectId) {
                audioEngine.mountDecodedTrack(enrichedTrack, audioBuffer);
              } else {
                // Otherwise store in RAM cache for instant switching
                const cachedMap =
                  audioEngine.getCachedProjectBuffers(targetProjectId) ||
                  new Map<string, AudioBuffer>();
                cachedMap.set(trk.id, audioBuffer);
                audioEngine.storeProjectBuffersInRamCache(targetProjectId, cachedMap);
              }

              // Update track peaks & duration progressively in React state
              const updateProjectWithTrack = (proj: SongProject): SongProject => {
                if (proj.id !== targetProjectId) return proj;
                const nextDur = Math.max(
                  headerMaxDurationSec > 0 ? proj.durationSec || 0 : 0,
                  maxDecodedDurationSec
                );
                const finalDur = nextDur > 0 ? nextDur : proj.durationSec || 180;
                const finalBars = Math.max(4, Math.ceil(finalDur / secPerBar));
                return {
                  ...proj,
                  durationSec: finalDur,
                  totalBars: finalBars,
                  tracks: proj.tracks.map((t) =>
                    t.id === enrichedTrack.id
                      ? { ...t, peaks, durationSec }
                      : t
                  ),
                };
              };

              setCurrentProject((prev) =>
                prev && prev.id === targetProjectId ? updateProjectWithTrack(prev) : prev
              );
              setProjects((prev) =>
                prev.map((p) =>
                  p.id === targetProjectId ? updateProjectWithTrack(p) : p
                )
              );
            } catch (err) {
              completedCount++;
              console.error(
                `[AudioEngine][Import Decode Error] Falló "${trk.name}":`,
                err
              );
            }
          })
        );
      }

      setImportStatusText(null);

      if (!anyDecoded) {
        showToast('No se pudo decodificar el audio seleccionado');
        return;
      }

      // Persist final peaks and exact duration to IndexedDB
      if (currentProjectRef.current?.id === targetProjectId) {
        saveProjectToDb(currentProjectRef.current).catch(() => {});
      }

      // One-time background copy into the OPFS cache (the song is in the setlist from import)
      await stemsSavePromise;
      runAutoOptimizeRef.current(targetProjectId);
    },
    [projects.length, showToast, setFingerprintPrompt]
  );

  // Desktop Native Import: Passes folder/file paths directly to Rust native engine.
  // JavaScript never reads audio file bytes; song appears immediately in the library (< 5 ms)
  // and conversion executes non-blocking in the background.
  const handleImportNative = useCallback(
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

        const bpm = scanned.bpm || (effectiveMode === 'current-song' ? currentProjectRef.current?.bpm || 120 : 120);
        const beatsPerBar = 4;
        const secPerBar = (60 / bpm) * beatsPerBar;

        let maxDurationSec = 0;
        const initialTracks: TrackChannel[] = scanned.files.map((file, idx) => {
          const trackLabel = file.trackName;
          const inferred = inferTrackRoleAndColor(trackLabel, idx);
          const estDuration = file.estDurationSec || 0;
          if (estDuration > maxDurationSec) {
            maxDurationSec = estDuration;
          }

          return {
            id: file.trackId,
            name: trackLabel,
            role: inferred.role,
            color: inferred.color,
            gain: 1.0,
            pan: 0,
            muted: false,
            soloed: false,
            bus: inferred.bus === 'cue-click' ? 'cue-click' : defaultBus,
            peaks: [],
            isCustomAudio: true,
            fileName: file.fileName,
            filePath: file.filePath,
            fileSize: file.fileSize ?? undefined,
            durationSec: estDuration > 0 ? estDuration : undefined,
          };
        });

        const initialDurationSec = maxDurationSec > 1 ? maxDurationSec : 180;
        const initialBars = Math.max(4, Math.ceil(initialDurationSec / secPerBar));

        const initialSections: SongSection[] = scanned.sections.map((s, idx) => ({
          id: s.id || `sec-${idx}`,
          name: s.name,
          code: s.code || `S${idx + 1}`,
          color: MARKER_PALETTE[idx % MARKER_PALETTE.length],
          startTimeSec: s.startSec,
          endTimeSec: s.endSec,
          vampByDefault: false,
          cueName: s.name,
        }));

        let newSongProject: SongProject;
        if (effectiveMode === 'new-song') {
          if (existingCandidate) {
            // Re-importing existing song: keep user edits, sections and mix settings!
            const mergedTracks: TrackChannel[] = initialTracks.map((it) => {
              const prev = existingCandidate.tracks.find(
                (pt) =>
                  pt.id === it.id ||
                  pt.name.toLowerCase() === it.name.toLowerCase() ||
                  (pt.fileName && it.fileName && pt.fileName.toLowerCase() === it.fileName.toLowerCase())
              );
              if (prev) {
                return {
                  ...it,
                  id: prev.id,
                  gain: prev.gain,
                  pan: prev.pan,
                  muted: prev.muted,
                  soloed: prev.soloed,
                  bus: prev.bus,
                  role: prev.role,
                  color: prev.color,
                  filePath: it.filePath || prev.filePath,
                  fileName: it.fileName || prev.fileName,
                  fileSize: it.fileSize ?? prev.fileSize,
                  durationSec: it.durationSec ?? prev.durationSec,
                };
              }
              return it;
            });

            newSongProject = {
              ...existingCandidate,
              title: existingCandidate.isTitleCustom ? existingCandidate.title : (scanned.title || existingCandidate.title),
              artist: existingCandidate.isTitleCustom ? existingCandidate.artist : (scanned.artist || existingCandidate.artist),
              keySignature: existingCandidate.isTitleCustom ? existingCandidate.keySignature : (scanned.key || existingCandidate.keySignature),
              bpm: existingCandidate.isTitleCustom ? existingCandidate.bpm : bpm,
              totalBars: initialBars,
              durationSec: initialDurationSec,
              tracks: mergedTracks,
              sections: existingCandidate.sections.length > 0 ? existingCandidate.sections : initialSections,
              inSetlist: existingCandidate.inSetlist ?? false,
              setlistOrder: existingCandidate.setlistOrder,
              folderPath: scanned.folderPath || existingCandidate.folderPath,
              updatedAt: Date.now(),
            };

            audioEngine.prepareProjectShell(newSongProject);
            setMissingNativeCache(false);
            if (newSongProject.inSetlist) {
              setCurrentProject(newSongProject);
            }
            setProjects((prev) =>
              prev.map((p) => (p.id === newSongProject.id ? newSongProject : p))
            );
            saveProjectToDb(newSongProject).catch(() => {});
          } else {
            newSongProject = {
              id: targetProjectId,
              title: scanned.title || 'Nueva Sesión',
              artist: scanned.artist || 'Sesión Importada',
              folderPath: scanned.folderPath,
              folder: 'imported',
              inSetlist: false,
              setlistOrder: undefined,
              bpm,
              beatsPerBar,
              beatUnit: 4,
              keySignature: scanned.key || 'C Major',
              totalBars: initialBars,
              durationSec: initialDurationSec,
              quantizeMode: 'immediate',
              splitRoutingMode: 'stereo',
              clickEnabled: false,
              clickGain: 1.0,
              clickSubdivision: 1,
              guideCuesEnabled: true,
              guideVoiceReadout: true,
              guideGain: 1.0,
              masterGain: 1.0,
              cueMasterGain: 1.0,
              pitchSemitones: 0,
              sections: initialSections,
              tracks: initialTracks,
              updatedAt: Date.now(),
            };

            audioEngine.prepareProjectShell(newSongProject);
            setMissingNativeCache(false);
            if (newSongProject.inSetlist) {
              setCurrentProject(newSongProject);
            }
            setProjects((prev) => [newSongProject, ...prev]);
            saveProjectToDb(newSongProject).catch(() => {});
          }
        } else {
          const current = currentProjectRef.current!;
          const combinedTracks = [...current.tracks, ...initialTracks];
          const nextDurationSec = Math.max(current.durationSec || 0, initialDurationSec);
          const nextTotalBars = Math.max(current.totalBars, initialBars);

          newSongProject = {
            ...current,
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
          saveProjectToDb(newSongProject).catch(() => {});
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

        const filesToImport = scanned.files.map((f) => ({
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
              let updatedDuration = newSongProject.durationSec || 0;
              const updatedTracks = newSongProject.tracks.map((t) => {
                const meta = importResult.tracks.find((m: any) => m.trackId === t.id);
                if (meta) {
                  if (meta.durationSec > updatedDuration) {
                    updatedDuration = meta.durationSec;
                  }
                  return {
                    ...t,
                    peaks: meta.peaks || t.peaks,
                    durationSec: meta.durationSec || t.durationSec,
                    fileSize: t.fileSize,
                    pcm: {
                      sampleRate: meta.targetSampleRate,
                      channels: meta.channels,
                      frames: meta.frameCount,
                      version: 1 as const,
                    },
                  };
                }
                return t;
              });

              const completedProject: SongProject = {
                ...newSongProject,
                durationSec: updatedDuration,
                tracks: updatedTracks,
                updatedAt: Date.now(),
              };

              setProjects((prev) =>
                prev.map((p) => (p.id === targetProjectId ? completedProject : p))
              );
              saveProjectToDb(completedProject).catch(() => {});

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

  return {
    handleInstantImportFiles,
    handleImportNative,
  };
}
