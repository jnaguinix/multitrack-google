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
- `src/components/modals/*`: Modales: `ConfirmSongActionModal` (confirmar montaje), `SongFingerprintPromptModal` (huella ambigua), `SongMetadataEditModal`, `StemImporterModal` (elige carpeta o archivos), `ImportWizardModal` (asistente de importación y «Editar pistas») e `InstrumentPickerModal` (cambiar el instrumento de una sola pista: clic en su nombre en Mezcla o Arreglo; `handleChangeTrackInstrument` en `App.tsx` renumera las demás) y `SectionEditorModal`.
- `src/components/LiveSetView.tsx`: Página En vivo (reloj, mapa proporcional de secciones, saltos cuantizados, cola del setlist).
- `src/utils/songSearch.ts` y `src/hooks/useProgressiveList.ts`: Búsqueda sin acentos ni mayúsculas (título, artista, tono, BPM) y render de listas largas por tandas, compartidos por la Biblioteca y el explorador del Setlist.
- `desktop/frontend/*`: Puentes de la UI con Tauri: `RemoteConnectionBridge.tsx` (diálogo «Conexión remota», botón fijo en la barra superior), `DesktopAudioSettings.tsx`, `DesktopUpdates.tsx` y `previewInvoke.ts` (simulación del servidor LAN solo en `npm run dev`, excluida de producción).
- `src/audio/nativeAudioEngine.ts`: Adaptador puente TypeScript para invocar los comandos Tauri del motor nativo en Rust (`audio_*`).
- `src/preview/*`: Vista previa en el navegador, solo desarrollo. `npm run dev` + `http://localhost:3000` instala un `window.__TAURI__` simulado (`installPreview.ts`, importado el primero en `main.tsx`) con tres canciones de ejemplo, transporte con reloj, saltos, vamp y medidores animados; no suena nada. `?sinvista` lo desactiva. `main.tsx` también cuenta renderizados en `window.__render` (Profiler, solo desarrollo). Nada de esto entra en producción.
- `src/utils/instrumentCatalog.ts`: catálogo cerrado de instrumentos (Bajo, Batería, Cuerdas, Guitarra acústica/eléctrica, Loop, Metales, Órgano, Percusión, Piano, Sintetizador / Pad, Teclado, Voces; más Click y Guía fijos) con su rol y color; `numberedNames` (numera los repetidos), `sortInstrumentTracks` / `orderTracksForDisplay` (orden alfabético en español), `isClickTrack` / `isGuideTrack` y `effectiveBus` (instrumentos a Main, Click y Guía a Cue: ya no hay ruteo por pista). `src/utils/trackMapMemory.ts`: memoria del mapeo, solo por nombre de archivo exacto.
- Importación: no hay mapeo inteligente de nombres. `handleImportNative` escanea y abre `ImportWizardModal` (paso 1 datos de la canción, paso 2 instrumento de cada archivo, elegido a mano); la pista se guarda con el nombre del catálogo y el nombre de archivo queda en `fileName`/`filePath`. «Editar pistas» (Mezcla, Arreglo y Setlist) reabre el paso 2 para canciones ya importadas. En Mezcla, Click y Guía van fijos a la derecha junto a Main (un solo control cada uno) y no hay master de Cue en pantalla.
- `src/audio/controlQueue.ts`, `src/audio/controlSync.ts`, `src/storage/saveScheduler.ts` + `projectSaves.ts`, `src/utils/flightRecorder.ts`: **los controles de la mezcla (volumen, paneo, mute, solo, bus, ganancias maestras, tono, metrónomo) nunca se envían al motor con `invoke` suelto.** Pasan por una cola serie (`ControlQueue`): los comandos de Tauri se ejecutan como tareas independientes y dos órdenes seguidas pueden aplicarse al revés (medido: 5 de 3000). `ControlSync` envía solo la diferencia (`applyProjectChange`) o todo (`updateProjectConfig`), y en cada sondeo compara con lo que el motor informa en `trackControls`: tras 2 sondeos con la misma discrepancia, con la cola en reposo, reenvía lo correcto (máx. 3 veces por 5 s) y lo anota en la caja negra. «Copiar diagnóstico» (Ajustes de audio, Diagnóstico) vuelca los últimos 500 eventos. Los cambios continuos (fader, pan) se guardan con 400 ms de retraso; el resto, al momento. El solo no se guarda (`withoutSolos` en `projectDb.ts`).
- `desktop/src-tauri/src/audio/routing.rs`: ruteo de salidas **por dispositivo**. Fuentes lógicas (música L, R y mono, click, guía) → matriz `salida × fuente` que el callback copia a la pila (`RoutingSlot`, sin bloqueos ni asignaciones); `propose(canales)`, `validate`, limitador suave (`soft_limit`) y almacén `audio_routing.json` (`RoutingStore`). Comandos `audio_get_routing` / `audio_set_routing` / `audio_reset_routing`. UI: `desktop/frontend/AudioRoutingPanel.tsx` (en Ajustes de audio) y `desktop/frontend/routing.ts` (copia de las reglas para avisar al editar; el motor es la autoridad y vuelve a validar).
- `src/utils/storagePersist.ts`: `ensureStoragePersist` (pide almacenamiento persistente para IndexedDB). La copia de audio a OPFS, su optimizador y el lector PCM del navegador se retiraron.
- `src/utils/asyncErrors.ts`: `logAsyncError(contexto)`, el manejador de las promesas lanzadas sin esperar (guardar, sincronizar, controles al motor). Sustituye a `.catch(() => {})`: registra el fallo con su contexto, como mucho un aviso cada 5 s por contexto. `src/utils/markerPalette.ts`: paleta de colores de secciones.
- `src/utils/panScale.ts`: `panToEngine` convierte el pan de la interfaz (-1..+1) al entero -100..100 que espera `audio_set_track_controls`; todo envío de pan al motor debe pasar por ahí.
- `src/audio/statePoller.ts`: Sondeo del estado nativo con una sola petición pendiente, respuestas obsoletas descartadas por generación y errores sin silenciar (lo usa `nativeAudioEngine.ts`).
- `src/audio/meterFeed.ts` y `src/audio/liveMeters.ts`: Ciclo único de lectura de medidores (20 fps, solo mientras haya medidores suscritos) y el hook `useLiveMeters`; `src/utils/mixerLevels.ts` calcula los niveles de pista y de bus. Los medidores son componentes hoja: no re-renderizan la consola.
- `src/audio/meterBallistics.ts`: Balística (caída ~20 dB/s, retención de recorte) de los picos reales que mide el motor nativo para los medidores de Arreglo y Mezcla.
- `src/audio/audioEngine.ts`: Fachada de 17 líneas: exporta `audioEngine` (el adaptador `nativeAudioEngine`) y el tipo `AudioEngine`. El motor Web Audio y `streamingTrack.ts` (≈3 100 líneas) se retiraron; siguen en la etiqueta `main-web-final`. Sin Tauri (navegador) el adaptador no tiene `invoke` y las acciones de audio no hacen nada.
- `src/storage/*`: Persistencia en IndexedDB (`projectDb.ts`), File System Access (`sourceFiles.ts`) y puente desktop (`desktopLibrary.ts`).
- `desktop/src-tauri/src/audio/*`: Motor nativo: `playback/` (transporte, buffers `rtrb`, callback CPAL, reloj `clock.rs`, lógica por bloque `block.rs`), `cache.rs` (caché PCM i16 y picos), `import.rs` (decodificación Symphonia/Hound), `output.rs` (dispositivos WASAPI y `resolve_output_config`), `track_ids.rs` (IDs únicos de pista al escanear o importar), `resampler.rs` (remuestreo `rubato`), `metronome.rs` (click sintético), `mod.rs` (comandos `audio_*`).
- `desktop/src-tauri/src/library/`: Gestión de `library.json`, persistencia atómica y sidecars `omnitracks.project.json` (comandos `library_*`).
- `desktop/src-tauri/src/lan.rs`: Servidor HTTP/WebSocket local para control remoto desde móviles (músicos y sonidistas) en la LAN (puerto 8765 definido como `const PORT` en `desktop/src-tauri/src/main.rs:14`).
- `desktop/src-tauri/tests/`: Pruebas de integración de Rust (`lan_protocol.rs`, `verify_manual_flow.rs`, `import_flow.rs`, `benchmark_import.rs`).
- `scripts/verify-ipc.ts` (`npm run verify:ipc`, también dentro de `npm test`): comprueba sin compilar el contrato interfaz-motor: cada `invoke('x', {…})` contra el `#[tauri::command]` de Rust (existe, nombres y argumentos, enteros), los campos de las respuestas (`PlaybackStateSnapshot`…) y el registro triple de comandos. Un `i32` de Rust con un valor no entero es error salvo que esté en `REVIEWED_INTEGER`. No detecta estado duplicado ni payloads que no son objetos en línea.
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
- Actualizar este archivo (`CLAUDE.md`), su copia `AGENTS.md` (idéntica salvo esa frase) y `docs/ARQUITECTURA.md` inmediatamente si se mueven, renombran o agregan módulos.

---

## 6. Pendientes conocidos
- **Decodificación de caché**: Se realiza en paralelo (3-4 hilos, `desktop/src-tauri/src/audio/mod.rs`). Medido en el `.exe` el 2026-11-12: 7 pistas de 4:20 en ~4,1 s y 10 pistas de 8:00 en ~10,7 s. El límite es el procesador. Más hilos o trabajar a 44,1 kHz serían decisiones del dueño, aún sin tomar.
- **Medidores sin medir en el callback**: Los medidores de nivel (`PeakMeter`) añaden operaciones al callback de audio. No se midieron underruns ni tiempo de callback antes y después; el dueño ensayó y no notó problemas.
- **Verificación completa sin cerrar**: `verify.ps1 -Completo` no se completó sobre `main` tras la migración (faltaron `verify_manual_flow` y `build:portable`). Las pruebas rápidas sí pasaron.
- **Importación HTML/arrastre vs nativa**: La importación por selector HTML o arrastre de archivos sigue decodificando al importar (`src/hooks/useImportFlow.ts:250, 440`); solo la ruta nativa de carpeta importa sin decodificar.
- **Pistas más cortas que la canción tras un salto de sección**: un feeder que ya llegó al final de su archivo no evalúa saltos ni vamp; si la canción salta hacia atrás, esa pista (p. ej. una guía corta) queda en silencio hasta el siguiente seek. No medido en el motor real.
- **Crossfade de empalme con tono**: el cruce de 8 ms de un salto o vuelta de vamp se lee del archivo sin pasar por el remuestreador; con tono distinto de cero esos 8 ms suenan sin transponer.
- **Ruteo de salidas por dispositivo** (`audio/routing.rs`): con 2 salidas, la 1 lleva toda la música en mono (`(L+R)/√2`, sin perder lo que esté en un solo canal) y la 2 el click y la guía juntos; con 3, música L, música R y click+guía; con 4 o más, música L, R, click y guía por separado y el resto libre. La propuesta sale de los canales que expone el dispositivo y se puede editar y guardar por dispositivo. Click y guía nunca comparten salida con la música salvo confirmación explícita (`allow_mixed`). Un ruteo guardado para otra cantidad de canales no se aplica. `ensure_stream` valida antes de abrir: un dispositivo elegido que no está conectado da error, nunca se sustituye por el predeterminado. El ruteo no se puede cambiar mientras suena. El canal «Guía» de una pista va por su propio bus (`TrackBus::Guide`, `engineBus` en el catálogo).
- **Paneo de pistas estéreo**: `pan_law` / `apply_pan` (`playback/block.rs`): ley de potencia constante con pasaje del canal contrario. Al panear una pista estéreo, todo su contenido va hacia ese lado (en el extremo, la media de L y R); al centro la imagen no se toca, y una pista mono suena igual que con el paneo clásico. Con 2 salidas la música sale en mono y el paneo no se oye (ver «Ruteo de salidas»).
- **Salto ya empalmado**: desde que un feeder empalma el audio del salto (~350 ms antes de la transición) ya no se puede cancelar ni reprogramar (`jump_already_spliced` en `playback/jumps.rs`); cancelar se ignora y encolar otro devuelve error. Encolar un salto, o un seek fuera del bucle, desactiva el vamp.
- **Saltos cuantizados tardíos**: Si el compás objetivo ya cayó dentro del audio ya encolado en el ring buffer `rtrb`, el salto se pospone al siguiente compás. Cifras reales (`playback/mod.rs`): el ring buffer tiene 500 ms de *capacidad*, el feeder lo mantiene en ~350 ms y el callback sale de buffering a partir de 150 ms disponibles por pista; no son equivalentes.
- **Archivos grandes**: `src/App.tsx` (~1490) y `src/components/modals/SectionEditorModal.tsx` (~430).
- **Ramas sin fusionar**: `diag/medidores-reales` y `diag/tiempo-cache` (trabajo ya incorporado por otra vía; sin revisar si conservan algo propio).
- **Límite de WASAPI para el ruteo multicanal**: CPAL 0.18 abre WASAPI solo en modo compartido y solo ve los canales del formato de mezcla de Windows; una interfaz con varias salidas suele aparecer como pares estéreo separados. El motor ya soporta hasta 32 salidas, pero usar 3 o más en una interfaz así exige ASIO (SDK de Steinberg, decisión del dueño sin tomar), WASAPI exclusivo multicanal (no soportado por CPAL) o que el controlador exponga un formato multicanal en Windows. Sin medir con hardware de más de 2 canales.
- **Fase 7 diferida**: Soporte de drivers de audio ASIO (diferido, sin decidir: depende de la licencia del SDK de Steinberg y de la decisión del dueño).
- **Capa web de archivos fuente**: `sourceFiles.ts` y los campos `fileHandle`/`dirHandle` de `projectDb.ts` (File System Access) siguen presentes para la importación por selector HTML. En escritorio la importación usa los diálogos nativos; retirarla exige decidir antes qué se conserva de la importación por arrastre.
- **`handleRelinkProject` en `App.tsx`**: Retenido en el componente raíz para evitar referencias circulares / hoisting temporal (`TS2448`).
- **Riesgo de contención en `try_lock`**: En callbacks bajo alta carga, si `try_lock()` sobre los consumidores falla, se emite silencio en ese bloque.
