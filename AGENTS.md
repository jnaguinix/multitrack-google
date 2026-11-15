# OmniTracks — Guía de Arquitectura y Reglas de Desarrollo

## 1. Qué es OmniTracks
Reproductor de multitracks optimizado para cultos y música en vivo. Dispone de dos entornos:
- **Web (interfaz)**: React 19 (^19.0.1), TypeScript, Tailwind CSS 4 (^4.3.3) y Vite, con almacenamiento en IndexedDB. El motor Web Audio se retiró: el audio solo suena en la app de escritorio.
- **Escritorio**: Tauri v2 para Windows x64 con WebView2 Evergreen y motor de audio nativo multihilo de alto rendimiento implementado en Rust (CPAL, Symphonia, rubato y rtrb).

---

## 2. Dónde está cada cosa
- `src/App.tsx`: Componente raíz, orquestador de vistas, modales globales, layout y referencias principales.
- `src/hooks/*`: Custom hooks desacoplados (`useImportFlow`, `useOptimization`, `useSetlist`, `useProjectActions`, `useMixerActions`, `useDawDragDrop`, `useStudioShortcuts`).
- `src/components/AppDialogs.tsx`: Diálogos y avisos globales de `App` (eliminar de la biblioteca, carpeta no encontrada, aviso de acción).
- `src/hooks/useSetlistMeta.ts`: Nombre y fecha del servicio (almacenamiento local de la app).
- `src/components/SetlistStrip.tsx`: Fila de fichas del setlist con la flecha de transición por canción y el modo editar.
- `src/utils/setlistTransition.ts` y `src/utils/sectionTemplates.ts`: Transición por canción (con respaldo en el ajuste general) y plantillas de sección (Intro, Verso 1, Coro…).
- `src/components/SongPickerModal.tsx`: Explorador de canciones superpuesto de la página Setlist (buscar en la biblioteca, ordenar, añadir o quitar del setlist e importar).
- `src/components/LibraryView.tsx`: Página Biblioteca (lista a una columna con buscador, orden y carga por tandas).
- `src/components/modals/*`: Modales: `ConfirmSongActionModal` (confirmar montaje), `SongFingerprintPromptModal` (huella ambigua), `SongMetadataEditModal`, `StemImporterModal`, `SectionEditorModal` y `OptimizationProgressModal`. `src/utils/trackRole.ts`: `inferTrackRoleAndColor`.
- `src/components/LiveSetView.tsx`: Página En vivo (reloj, mapa proporcional de secciones, saltos cuantizados, cola del setlist).
- `src/utils/songSearch.ts` y `src/hooks/useProgressiveList.ts`: Búsqueda sin acentos ni mayúsculas (título, artista, tono, BPM) y render de listas largas por tandas, compartidos por la Biblioteca y el explorador del Setlist.
- `desktop/frontend/*`: Puentes de la UI con Tauri: `RemoteConnectionBridge.tsx` (diálogo «Conexión remota», botón fijo en la barra superior), `DesktopAudioSettings.tsx`, `DesktopUpdates.tsx` y `previewInvoke.ts` (simulación del servidor LAN solo en `npm run dev`, excluida de producción).
- `src/audio/nativeAudioEngine.ts`: Adaptador puente TypeScript para invocar los comandos Tauri del motor nativo en Rust (`audio_*`).
- `src/utils/storagePersist.ts`: `ensureStoragePersist` (pide almacenamiento persistente para IndexedDB). La copia de audio a OPFS, su optimizador y el lector PCM del navegador se retiraron.
- `src/utils/asyncErrors.ts`: `logAsyncError(contexto)`, el manejador de las promesas lanzadas sin esperar (guardar, sincronizar, controles al motor). Sustituye a `.catch(() => {})`: registra el fallo con su contexto, como mucho un aviso cada 5 s por contexto. `src/utils/markerPalette.ts`: paleta de colores de secciones.
- `src/audio/statePoller.ts`: Sondeo del estado nativo con una sola petición pendiente, respuestas obsoletas descartadas por generación y errores sin silenciar (lo usa `nativeAudioEngine.ts`).
- `src/audio/meterFeed.ts` y `src/audio/liveMeters.ts`: Ciclo único de lectura de medidores (20 fps, solo mientras haya medidores suscritos) y el hook `useLiveMeters`; `src/utils/mixerLevels.ts` calcula los niveles de pista y de bus. Los medidores son componentes hoja: no re-renderizan la consola.
- `src/audio/meterBallistics.ts`: Balística (caída ~20 dB/s, retención de recorte) de los picos reales que mide el motor nativo para los medidores de Arreglo y Mezcla.
- `src/audio/audioEngine.ts`: Fachada de 17 líneas: exporta `audioEngine` (el adaptador `nativeAudioEngine`) y el tipo `AudioEngine`. El motor Web Audio y `streamingTrack.ts` (≈3 100 líneas) se retiraron; siguen en la etiqueta `main-web-final`. Sin Tauri (navegador) el adaptador no tiene `invoke` y las acciones de audio no hacen nada.
- `src/storage/*`: Persistencia en IndexedDB (`projectDb.ts`), File System Access (`sourceFiles.ts`) y puente desktop (`desktopLibrary.ts`).
- `desktop/src-tauri/src/audio/*`: Motor nativo: `playback/` (transporte, buffers `rtrb`, callback CPAL, reloj `clock.rs`, lógica por bloque `block.rs`), `cache.rs` (caché PCM i16 y picos), `import.rs` (decodificación Symphonia/Hound), `output.rs` (dispositivos WASAPI y `resolve_output_config`), `track_ids.rs` (IDs únicos de pista al escanear o importar), `resampler.rs` (remuestreo `rubato`), `metronome.rs` (click sintético), `mod.rs` (comandos `audio_*`).
- `desktop/src-tauri/src/library/`: Gestión de `library.json`, persistencia atómica y sidecars `omnitracks.project.json` (comandos `library_*`).
- `desktop/src-tauri/src/lan.rs`: Servidor HTTP/WebSocket local para control remoto desde móviles (músicos y sonidistas) en la LAN (puerto 8765 definido como `const PORT` en `desktop/src-tauri/src/main.rs:14`).
- `desktop/src-tauri/tests/`: Pruebas de integración de Rust (`lan_protocol.rs`, `verify_manual_flow.rs`, `import_flow.rs`, `benchmark_import.rs`).
- `docs/AUDITORIA.md`: Guía para auditar el código (orden, reglas, lo ya conocido, formato del informe).
- `test/`: Pruebas unitarias en Node/TypeScript (`titleCleaning.test.ts`, `trackFingerprint.test.ts`, `nativeCacheGeneration.test.ts`, `meterBallistics.test.ts`, `setlistPlan.test.ts`, `songSearch.test.ts`, `statePoller.test.ts`, `liveMeters.test.ts`).

---

## 3. Cosas que NO se pueden romper
1. **Callback de audio en tiempo real**: Prohibido hacer logging (`println!`, `tracing`), alocaciones dinámicas (`vec![]`, `clone()`) o bloqueos `lock().unwrap()` en el hilo de audio. Implementado en la función `ensure_stream` de `desktop/src-tauri/src/audio/playback/mod.rs` con buffers preasignados.
2. **Micro-fundidos de 8 ms**: Constante `FADE_MS = 8.0` en `desktop/src-tauri/src/audio/playback/fade.rs`. Se aplican única y exclusivamente al iniciar, pausar, detener, hacer seek, saltar de sección, alternar bucle vamp y al llegar al final natural de la canción (`end_of_song_gain` en `playback/block.rs`: los últimos 8 ms terminan 64 fotogramas antes del final; no se aplica en el vamp) para evitar clics. El audio continuo recibe ganancia 1.0 exacta.
3. **Drag & Drop en escritorio**: `"dragDropEnabled": false` obligatorio en `desktop/src-tauri/tauri.conf.json` para evitar que WebView2 intercepte el drop nativo de archivos en HTML5.
4. **Declaración triple de comandos Tauri**: Todo comando Tauri debe registrarse en:
   - `tauri::generate_handler![...]` en `desktop/src-tauri/src/main.rs`.
   - `.commands(&[...])` en `desktop/src-tauri/build.rs`.
   - `"permissions": ["allow-..."]` en `desktop/src-tauri/capabilities/desktop-remote.json`.
5. **Nombre del sidecar**: Debe escribirse estrictamente como `omnitracks.project.json`. El nombre heredado `.omnitracks.json` solo se acepta como fallback de lectura para retrocompatibilidad (`desktop/src-tauri/src/library/mod.rs`).
6. **Escrituras atómicas de biblioteca**: `library.json` se escribe en archivo temporal (`.tmp`), se renombra de forma atómica y se preserva copia en `.backup.json` (`atomic_write_file` en `desktop/src-tauri/src/library/mod.rs`).
7. **Codificación universal**: Todos los archivos del repositorio deben leerse y escribirse en UTF-8 sin BOM.

---

## 4. Decisiones cerradas
- **WASAPI en modo compartido**: Salida estándar por defecto en Windows.
- **ASIO diferido, sin decidir**: Depende de la licencia del SDK de Steinberg y de la decisión del dueño.
- **Orden de los mutex de proyecto**: `loaded_project_id` primero y `tracks` después, en `load_project` y en `unload_project_if_matches`. Cualquier código nuevo que tome ambos debe respetarlo (el orden inverso produce deadlock).
- **Salida a la frecuencia de la caché**: con un proyecto cargado, `ensure_stream` abre la salida a la frecuencia de su caché (`resolve_output_config`); si el dispositivo no la admite devuelve un error explícito en lugar de reproducir a otra velocidad. La apertura real con WASAPI no está medida.
- **Cachés PCM anteriores a la Fase 3**: las generadas al remuestrear desde otra frecuencia (p. ej. 44,1 → 48 kHz) llevan el retardo del filtro (~560 fotogramas) y deben regenerarse con «Generar caché nativa»; las que no se remuestrearon no cambian.
- **Cero asignaciones en el callback**: `crate::alloc_probe` (solo en pruebas) cuenta las asignaciones de un hilo; el metrónomo tiene una prueba que exige 0. Los búferes de mezcla se dimensionan a `MAX_CALLBACK_FRAMES` (32 768) al abrir el stream; un bloque mayor suena en silencio y cuenta como underrun.
- **Caché PCM al sample rate del dispositivo**: Al decodificar pistas con `import.rs`, el audio se remuestrea a la frecuencia nativa del hardware (`target_sample_rate`) para evitar convertir de frecuencia durante la reproducción. Matiz: cada feeder pasa siempre por `TrackResampler` (rubato) aunque la frecuencia origen y destino coincidan y el pitch sea cero, con coste no medido.
- **Biblioteca como índice ligero**: `library.json` contiene únicamente metadatos. Las carpetas de caché PCM (`pcm/<id>/`) solo existen para canciones que forman parte del setlist o están activas en consola.
- **Páginas de la app**: Setlist, En vivo, Arreglo, Mezcla y Biblioteca. La página «Control rápido» y el panel lateral de la Biblioteca se eliminaron el 2026-11-13.
- **Fuente incluida en la app**: Inter variable (`@fontsource-variable/inter`, importada en `src/main.tsx`). El CSP de `tauri.conf.json` solo permite fuentes propias (`font-src 'self'`): no se cargan recursos remotos. Tamaño mínimo de texto: 12 px.
- **Escala en pantallas grandes**: `src/index.css` define `--ui-zoom` (1,2 / 1,45 / 1,8 desde 1800 / 2300 / 3000 px de ancho) y aplica `zoom` a `html`; `.app-shell` compensa las unidades de viewport.
- **Licencia LibreTracks (AGPL)**: Prohibido copiar o portar su código; las ideas generales sí se pueden usar.

---

## 5. Reglas de trabajo
- **Rama principal**: `main` contiene el motor nativo de escritorio desde la versión 0.3.0 (migración del 2026-11-12). La antigua rama `motor-nativo` se conserva como la etiqueta `archivo/motor-nativo` (referencia congelada). El repositorio trabaja solo con `main` y ramas de trabajo temporales, que se borran al fusionarlas; las etiquetas `archivo/*` guardan lo que hubo en ramas antiguas. Las ramas nuevas salen de `main`.
- **Versión web anterior**: conservada en la etiqueta `main-web-final`. Es el punto de retorno si hiciera falta.
- Trabajar siempre en rama aparte creada a partir de la rama indicada. Nunca realizar commits ni merges directos a `main`, salvo que el dueño lo pida de forma expresa (como en la migración a 0.3.0).
- No lanzar `verify.ps1 -Completo` por iniciativa propia: tarda cerca de una hora. Por commit basta el verify rápido; el completo lo pide el dueño.
- Un cambio lógico por commit, con mensaje descriptivo y preciso.
- Nunca tragar errores: terminantemente prohibido `.catch(() => {})` o silenciar excepciones sin log o notificación visual al usuario.
- En reportes de verificación, marcar explícitamente como «No medido» toda prueba o métrica no ejecutada.
- Actualizar este archivo (`AGENTS.md`), su original `CLAUDE.md` (idéntico salvo esa frase) y `docs/ARQUITECTURA.md` inmediatamente si se mueven, renombran o agregan módulos.

---

## 6. Pendientes conocidos
- **Decodificación de caché**: Se realiza en paralelo (3-4 hilos, `desktop/src-tauri/src/audio/mod.rs`). Medido en el `.exe` el 2026-11-12: 7 pistas de 4:20 en ~4,1 s y 10 pistas de 8:00 en ~10,7 s. El límite es el procesador. Más hilos o trabajar a 44,1 kHz serían decisiones del dueño, aún sin tomar.
- **Medidores sin medir en el callback**: Los medidores de nivel (`PeakMeter`) añaden operaciones al callback de audio. No se midieron underruns ni tiempo de callback antes y después; el dueño ensayó y no notó problemas.
- **Verificación completa sin cerrar**: `verify.ps1 -Completo` no se completó sobre `main` tras la migración (faltaron `verify_manual_flow` y `build:portable`). Las pruebas rápidas sí pasaron.
- **Importación HTML/arrastre vs nativa**: La importación por selector HTML o arrastre de archivos sigue decodificando al importar (`src/hooks/useImportFlow.ts:250, 440`); solo la ruta nativa de carpeta importa sin decodificar.
- **Pistas más cortas que la canción tras un salto de sección**: un feeder que ya llegó al final de su archivo no evalúa saltos ni vamp; si la canción salta hacia atrás, esa pista (p. ej. una guía corta) queda en silencio hasta el siguiente seek. No medido en el motor real.
- **Crossfade de empalme con tono**: el cruce de 8 ms de un salto o vuelta de vamp se lee del archivo sin pasar por el remuestreador; con tono distinto de cero esos 8 ms suenan sin transponer.
- **Saltos cuantizados tardíos**: Si el compás objetivo ya cayó dentro del audio ya encolado en el ring buffer `rtrb`, el salto se pospone al siguiente compás. Cifras reales (`playback/mod.rs`): el ring buffer tiene 500 ms de *capacidad*, el feeder lo mantiene en ~350 ms y el callback sale de buffering a partir de 150 ms disponibles por pista; no son equivalentes.
- **Archivos grandes**: `src/App.tsx` (~1490) y `src/components/modals/SectionEditorModal.tsx` (~430).
- **Ramas sin fusionar**: `diag/medidores-reales` y `diag/tiempo-cache` (trabajo ya incorporado por otra vía; sin revisar si conservan algo propio).
- **Fase 5 diferida**: Ruteo libre multicanal a más de 2 salidas físicas independientes de la tarjeta.
- **Fase 7 diferida**: Soporte de drivers de audio ASIO (diferido, sin decidir: depende de la licencia del SDK de Steinberg y de la decisión del dueño).
- **Capa web de archivos fuente**: `sourceFiles.ts` y los campos `fileHandle`/`dirHandle` de `projectDb.ts` (File System Access) siguen presentes para la importación por selector HTML. En escritorio la importación usa los diálogos nativos; retirarla exige decidir antes qué se conserva de la importación por arrastre.
- **`handleRelinkProject` en `App.tsx`**: Retenido en el componente raíz para evitar referencias circulares / hoisting temporal (`TS2448`).
- **Riesgo de contención en `try_lock`**: En callbacks bajo alta carga, si `try_lock()` sobre los consumidores falla, se emite silencio en ese bloque.
