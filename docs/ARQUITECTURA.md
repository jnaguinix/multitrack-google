# Arquitectura del Sistema OmniTracks

Este documento detalla la estructura modular de la aplicación tras la división de archivos monolíticos (`desktop/src-tauri/src/audio/playback/` y `src/hooks/`), las especificaciones de todos los módulos del backend y frontend, las reglas obligatorias de codificación y el ciclo de vida del audio.

> **Versión 0.3.0 (2026-11-12):** `main` es la rama del motor nativo de escritorio. La versión web anterior se conserva en la etiqueta `main-web-final` y ya no se mantiene. La rama `motor-nativo` quedó congelada como referencia.

---

## 1. Regla Obligatoria de Codificación (UTF-8 sin BOM)

> [!IMPORTANT]
> **Todos los archivos del repositorio se leen y escriben estrictamente en UTF-8 sin BOM (Byte Order Mark).**
> - Prohibido incluir secuencias iniciales de bytes `EF BB BF`.
> - En PowerShell, nunca utilizar `Set-Content` o `Out-File` sin especificar codificación sin BOM. Utilizar siempre:
>   ```powershell
>   [System.IO.File]::WriteAllText($ruta, $texto, [System.Text.UTF8Encoding]::new($false))
>   ```
> - En entornos Node.js / Python, asegurar siempre codificación `utf-8` estándar.

---

## 2. Motor Nativo de Audio (Rust / Tauri)

El subsistema de audio nativo se encuentra en `desktop/src-tauri/src/audio/`:

### 2.1 Módulos de Soporte de Audio
- **`cache.rs`**: Gestión de almacenamiento y estructura de archivos PCM en disco (`%LOCALAPPDATA%\org.omnitracks.desktop\pcm\<project-id>\<sample-rate>\`). Escritura y lectura de stems (`stem-*.pcm` en formato i16 interleaved a 48 kHz o frecuencia del dispositivo), metadatos JSON (`stem-*.json`) y extracción de picos de onda (`peaks: Vec<f32>`) para la UI.
- **`import.rs`**: Decodificación multiformato con Symphonia (MP3, WAV, FLAC, AAC, OGG) y Hound. Un archivo truncado o con errores de lectura se rechaza; un paquete corrupto se sustituye por silencio de su duración para no desplazar el resto, y se rechaza el archivo si decodifica menos del 99 % de lo declarado o si más del 1 % está dañado. Conversión directa a PCM y remuestreo al sample rate de destino en hilos desacoplados sin bloquear la interfaz.
- **`routing.rs`**: ruteo de salidas por dispositivo. El callback mezcla en fuentes lógicas (música izquierda, derecha y mono, click, guía) y las reparte a los canales del dispositivo con una matriz `salida × fuente` copiada a la pila una vez por bloque (`RoutingSlot`). `propose` genera la asignación según los canales independientes que expone el dispositivo (2: click/guía/monitor a la izquierda + música mono a la derecha; 3: música L/R + click/guía/monitor; 4 o más: música L, R, click y guía con el monitor); `validate` rechaza ruteos que perderían una fuente o mezclarían click y guía con la música; `RoutingStore` guarda la elección por dispositivo en `audio_routing.json`. La salida pasa por un limitador suave para no recortar.
- **`output.rs`**: Enumeración y configuración de dispositivos WASAPI con CPAL (`audio_settings.json`), gestión del estado del motor (`AudioEngineState`) y estadísticas de streaming en tiempo real (`AudioStreamStats`: callbacks, underruns, latencia máxima). `resolve_output_config` elige la configuración de salida: con un proyecto cargado exige la frecuencia de su caché PCM.
- **`track_ids.rs`**: `assign_track_ids` reserva los IDs de pista que conoce el sidecar y numera los nuevos (`stem-NN`) sin repetir ninguno, al escanear o importar una carpeta.
- **`loudness.rs`**: Análisis de sonoridad EBU R128 (`ebur128`) de la mezcla de referencia de cada canción, en un hilo propio con cola (una canción cada vez, en pausa mientras suena algo). Lee la caché PCM por vueltas de 1 s, suma las pistas de Main con el mismo ruteo y ley de paneo del callback y guarda LUFS, rango y True Peak en `library.json` (`LibrarySong.loudness`); avisa por `audio://loudness`. Comando `audio_analyze_loudness`. Ver «Decisiones cerradas» de `CLAUDE.md`.
- **`resampler.rs`**: Conversión de frecuencia de muestreo en tiempo real con `rubato` (SincFixedIn), con su retardo informado. No cambia el tono.
- **`pitch.rs`**: `PitchShifter`: cambio de tono real (Signalsmith Stretch, crate `ssstretch`) que conserva la duración. Lo usa cada feeder después del remuestreador, solo con tono ≠ 0; compensa su retardo (120 ms) al empezar cada tramo. Ver «Decisiones cerradas» de `CLAUDE.md`.
- **`metronome.rs`**: `MetronomeEngine`: generador síncrono de pulsos de click analítico a la muestra exacta (síntesis matemática de tonos sinusoidales de 2.5 kHz para acentos y 1.25 kHz para subdivisiones).
- **`mod.rs`**: Registro y despacho de todos los comandos Tauri IPC invocables desde el frontend con prefijo `audio_*`.

### 2.2 Módulo de Reproducción (`audio/playback/`)
El archivo monolítico original fue dividido en el módulo modular `playback/`, preservando historial (`git mv`) y visibilidad de APIs públicas:

```
desktop/src-tauri/src/audio/playback/
├── mod.rs          # PlaybackEngine: estructura central, ciclo de vida, apertura del stream CPAL (ensure_stream) y simulate_callback_block (pruebas)
├── callback.rs     # BlockMixer: el bloque del callback de audio (pistas, metrónomo, ruteo, limitador, medidores, reloj). Lo ejecutan el stream CPAL y simulate_callback_block, así que las pruebas ejercitan el mismo código que suena
├── block.rs        # Piezas por bloque que usa `BlockMixer`: buffering_ready (salida de buffering), consume_track_block (lectura de un anillo con resincronía tras underrun), smoothing_alpha / smooth_toward (rampa de volumen y paneo: el callback no aplica cambios de fader de golpe, ver «Decisiones cerradas» de `CLAUDE.md`)
├── bus.rs          # TrackBus: tipos y conversión de buses de salida (main, cue, both)
├── clock.rs        # ClockJumps y advance_clock: saltos de sección y vueltas de vamp aplicados al reloj current_frame desde el callback
├── fade.rs         # FadeEnvelope, FadeType y constantes (FADE_MS = 8.0): micro-fundidos
├── feeder_io.rs    # Lectura de frames PCM desde disco, staging, drenaje con remuestreo, begin_new_segment (tras empalmes) y FeederAliveGuard
├── jumps.rs        # queue_section_jump, cancel_queued_jump, toggle_vamp (impl PlaybackEngine)
├── transport.rs    # play, pause, stop, seek (con rewind_tracks: handshake con los feeders), get_playback_state, reopen_stream (impl PlaybackEngine)
├── types.rs        # NativeSongSection, QueuedJumpInfo, ActiveTrack, PlaybackStateSnapshot, PeakMeter/BusMeters (medidores), etc.
├── ensayo.rs       # Ensayo del motor sin hardware: una sesión completa (carga, Play, mezcla, seek, salto, vamp, tono, pausa, cambio de canción, final) con audio sintético y el BlockMixer real; ver `CLAUDE.md`
└── tests.rs        # Suite completa de pruebas unitarias y benchmarks de audio (incluye pruebas con el motor real sobre una caché PCM sintética de rampas)
```

**Coherencia del transporte (Fase 1 de la auditoría)**
- **Reloj y discontinuidades**: el reloj `current_frame` solo lo avanza el callback. Al programar un salto cuantizado (`queue_section_jump`) o activar un vamp (`toggle_vamp`) se guardan en `ClockJumps` (atómicos); el callback los aplica con `advance_clock` en el instante exacto en que el feeder corta el audio. Un seek concurrente manda sobre el salto. El metrónomo se recoloca cuando un bloque no empieza donde terminó el anterior.
- **Seek con handshake por generación** (`rewind_tracks`): el transporte sube `seek_generation`, activa buffering, pide el seek a cada feeder, espera su `seek_ack`, vacía el anillo y publica `flush_done`. El feeder no empuja audio nuevo hasta ese momento y el callback no sale de buffering sin `flush_done` de la generación vigente. Si un feeder murió o no responde en 5 s, la pista se da por terminada y se registra un aviso.
- **Fin de pista**: una pista más corta que la canción no se da por terminada: su feeder sigue empujando silencio pasado el final del archivo, para que su posición siga al reloj y vuelva a sonar tras un salto o un vamp hacia atrás. `eof` solo lo marca el transporte cuando un feeder no confirma un seek (hilo caído); esa pista no cuenta para salir de buffering ni para el contador de underruns.
- **Underrun**: `consume_track_block` lee solo fotogramas completos, anota los que faltaron en `skip_frames` y descarta esa cantidad cuando el audio vuelve, para que la pista siga alineada con el reloj.
- **Empalmes**: el tramo parcial previo a un salto o vuelta de vamp se completa con ceros y solo se emiten los fotogramas con señal (no el bloque entero que devuelve `process_partial` de rubato); tras el empalme el remuestreador empieza un tramo nuevo (`begin_new_segment`).

---

## 3. Módulo de Biblioteca y Persistencia (`desktop/src-tauri/src/library/`)

Gestiona el catálogo de canciones y la integridad de metadatos locales:
- **`mod.rs`**:
  - Implementa la persistencia atómica de `library.json` mediante `atomic_write_file` (escritura en `.tmp`, reemplazo atómico y copia de seguridad en `.backup.json`).
  - Manejo del archivo sidecar `omnitracks.project.json` en la carpeta de origen de cada canción (con fallback de lectura en `.omnitracks.json` para retrocompatibilidad). No guarda los picos de forma de onda (`sidecar_json`): eran ~90 % de sus líneas y se regeneran con la caché PCM.
  - Picos de forma de onda fuera de `library.json`: `peaks/<id>.json` (`store_song_peaks`, `attach_song_peaks`, `remove_song_peaks`, `read_song_peaks`). Se guardan solo si cambiaron (resumen hash en memoria). `load_library_internal` (guardados) no los trae; `load_library_for_ui` (`library_load`) los une solo a las canciones del setlist, y `library_get_song_peaks` entrega los de una canción cuando se añade al setlist. Una biblioteca antigua con los picos dentro se migra sola; si no se pueden escribir, se quedan en `library.json`.
  - Comandos Tauri IPC expuestos: `library_load`, `library_get_song_peaks`, `library_save`, `library_save_song`, `library_delete_song`, `library_update_song_folder`, `library_write_sidecar`, `library_read_sidecar`.

---

## 4. Servidor Remoto LAN (`desktop/src-tauri/src/lan.rs`)

Servidor HTTP y WebSocket local embebido (basado en Axum y Tokio, puerto 8765):
- **Funcionalidad**: Permite el control remoto en vivo desde smartphones de músicos (monitoreo personal) y sonidistas (ganancia, paneo, mute y solo por canal).
- **Seguridad**: Emparejamiento por token en un enlace que se copia desde la pantalla (sin QR), con roles estrictos (`Musician`, `SoundEngineer`) y límite de 16 sesiones concurrentes con reciclaje FIFO de sesiones desconectadas.
- **Sincronización**: Intercambio de snapshots de transporte y deltas de mezcla (`remote_exchange`), desacoplado del motor de audio principal.

---

## 5. Frontend Web & Desktop (React / TypeScript)

`src/App.tsx` (~710 líneas) guarda el estado compartido (canciones, canción actual, transporte), elige la página y reparte las acciones. La lógica está en custom hooks en `src/hooks/` y las piezas de pantalla de `App` en `src/components/app/`:

```
src/hooks/
├── useProjectPersistence.ts # Carga inicial, updateCurrentProject (motor + guardado en orden), guardar al ocultar, IDs repetidos
├── useProjectActivation.ts  # Montar una canción en el motor, anterior/siguiente del setlist, qué hacer al terminar
├── useSetlistCaching.ts     # Estado real de la caché de cada canción del setlist, precarga y prioridad
├── useNativeCacheBanner.ts  # Avisos: dispositivo desconectado y canción sin caché («Generar caché nativa»)
├── useTrackInstruments.ts   # «Editar pistas» y «Cambiar instrumento» (renumera las demás)
├── useSongEditing.ts        # Notas, transición por canción, plantilla de sección y marcador en el cursor
├── useAlwaysMountedSong.ts  # Monta una canción cuando el DAW queda vacío (abrir app, primera importación, borrar la actual)
├── useRelinkProject.ts      # «Reubicar carpeta» de una canción
├── useLibraryDeletion.ts    # Eliminar de la biblioteca (tras confirmar)
├── useToast.ts              # Aviso breve en pantalla
├── useImportFlow.ts         # Compone las dos rutas de importación:
│   ├── useNativeImport.ts   #   diálogos del sistema (escritorio): escaneo, asistente, sin decodificar
│   └── useHtmlImport.ts     #   selector HTML o arrastre: decodifica al importar
├── useOptimization.ts       # Generación de la caché PCM nativa de una canción (botón «Generar caché»)
├── useProjectActions.ts     # Carga inmediata, creación, edición de metadatos, borrado y JSON export/import
├── useSetlist.ts            # Gestión de lista de canciones (setlist), reorden, precarga y expulsión de RAM
├── useSetlistMeta.ts        # Nombre y fecha del servicio (almacenamiento local)
├── useProgressiveList.ts    # Render por tandas de listas largas (Biblioteca y explorador del Setlist)
├── useMixerActions.ts       # Control de transporte, volumen, mute, solo, paneo, bus y secciones
└── useDawDragDrop.ts        # Manejo de eventos Drag & Drop de archivos y canciones sobre la DAW

src/components/app/
├── StatusBanners.tsx        # Avisos de dispositivo desconectado y caché faltante
├── WorkspacePlaceholders.tsx# Capa de arrastre y páginas Arreglo/Mezcla sin canción
├── DockedMixerDialog.tsx    # Consola flotante del Arreglo y MixerHandlers (acciones de consola compartidas)
└── TrackEditDialogs.tsx     # «Editar pistas» y «Cambiar instrumento»
```

La parte de la importación nativa que no depende de React (filas y datos del asistente, pistas numeradas, secciones, reimportación, resultado de la decodificación) está en `src/utils/nativeImportPlan.ts`. En el adaptador del motor, `nativeAudioEngine.ts` delega la caché PCM en `nativeCacheManager.ts` y el cálculo de compás y pulso en `nativeTransport.ts`.

Páginas (`WorkspaceView` en `TopBar.tsx`): Setlist (`SetlistPageView.tsx`, `SetlistStrip.tsx`, `SongPickerModal.tsx`), En vivo (`LiveSetView.tsx`), Mezcla (`MultitrackMixer.tsx` con el mapa compacto `SongMapStrip.tsx`: clic mueve el cursor), Arreglo (`TimelineArranger.tsx`), Mezcla (`MultitrackMixer.tsx`) y Biblioteca (`LibraryView.tsx`; modales en `components/modals/`). La búsqueda de canciones está en `src/utils/songSearch.ts`.

**Modo diagnóstico** (`src/utils/debugMode.ts`, `invokeTrace.ts`, `debugExport.ts`, `DebugBadge.tsx`): interruptor en Ajustes de audio → Diagnóstico o Ctrl+Mayús+D. Encendido registra con categoría cada comando a Tauri (`invokeTraceInstall` envuelve `core.invoke`, importado antes que `App`), los cambios de canción, el control remoto y los errores globales; las alarmas (comando lento, Play con la cola de controles sin vaciar, carga que termina tras cambiar de canción, puente remoto caído) quedan siempre, también en la caja negra. Solo interfaz: nada corre en el callback de Rust.

Puentes con el escritorio en `desktop/frontend/`: `bridgeLoop.ts` (bucle de intercambio con el servidor LAN: reintento con espera creciente ante errores pasajeros, corte solo con `LAN_APAGADO`), `remoteState.ts` (estado que se manda a los teléfonos; `receiptFor` decide los acuses: `applied` solo con el estado actualizado y el acuse del motor), `DesktopAudioSettings.tsx` (diálogo «Audio») con `AudioDiagnostics.tsx` (su sección «Diagnóstico») y `AudioRoutingPanel.tsx` (ruteo); `RemoteConnectionBridge.tsx` monta el diálogo «Conexión remota» y el botón de la barra superior mediante un portal; en `npm run dev` usa `previewInvoke.ts` (datos simulados, descartado de la compilación de producción) para poder ver el diseño sin Tauri.

---

## 6. Ciclo de Vida del Audio: Flujo Integral de Extremo a Extremo

```
[Importar Carpeta / Archivos]
          │
          ▼
   audio_scan_folder / audio_scan_files (audio/mod.rs)
          │ Extrae metadatos y duraciones (sin decodificar a PCM)
          ▼
   library_save_song & library_write_sidecar (library/mod.rs)
          │ Persiste en library.json y omnitracks.project.json
          ▼
[Biblioteca de Repertorio] (library_load)
          │
          ▼ Usuario añade canción al setlist
   handleAddToSetlist (useSetlist.ts)
          │ Consulta checkProjectCacheStatus (audio_get_project_cache_status)
          ▼ ¿Existe caché a la frecuencia del dispositivo?
     ┌────┴────────────────────────┐
     │ No                          │ Sí
     ▼                             ▼
   generateNativeCacheForProject   Canción lista en Setlist
   -> audio_import_tracks (Rust)
   -> decode_and_cache_track (import.rs)
   -> write_track_pcm_and_metadata (cache.rs)
     │ (Emite eventos audio://import-progress)
     ▼
[Carga en Consola / Playback]
   handleLoadProjectImmediately -> audio_load_project (audio/mod.rs)
   -> PlaybackEngine::load_project (playback/mod.rs)
   -> Inicializa feeders y prellena ring buffers rtrb (capacidad 500 ms; objetivo ~350 ms; salida de buffering con >= 150 ms por pista)
          │
          ▼ Play
   audio_play -> PlaybackEngine::play (fade-in 8 ms en fade.rs)
          │
          ▼ Callback de Audio en Tiempo Real (BlockMixer en playback/callback.rs, creado por ensure_stream)
   Drena rtrb buffers + mezcla click (metronome.rs) -> CPAL WASAPI
```

1. **Importar**: `handleImportNative` (TS, `useNativeImport.ts`) invoca `audio_scan_folder` o `audio_scan_files` (Rust, `audio/mod.rs`), extrae metadatos y guarda la canción en `library.json` mediante `library_save_song` y el sidecar `omnitracks.project.json` mediante `library_write_sidecar`. **No se genera caché PCM en este paso**. Entre el escaneo y la creación de pistas se abre el asistente (`ImportWizardModal`): el usuario escribe nombre, artista, tono, BPM y pulsos por compás, y elige a mano el instrumento de cada archivo (catálogo en `instrumentCatalog.ts`; sin adivinar nombres). Cada pista se guarda con el nombre del catálogo (numerado si se repite); el archivo original queda en `fileName`/`filePath`.
2. **Biblioteca**: `library_load` carga `library.json` al iniciar. La UI lista las canciones en `LibraryView.tsx` (`LibraryView.tsx`; modales en `components/modals/`, todos sobre `components/ui/Dialog.tsx`; menús sobre `components/ui/Menu.tsx`).
3. **Añadir al Setlist**: `handleAddToSetlist` (TS, `useSetlist.ts`) añade la canción a `setlistQueue`. Verifica la caché con `nativeAudioEngine.checkProjectCacheStatus` (`audio_get_project_cache_status`). Si `isReady == false`, invoca `nativeAudioEngine.generateNativeCacheForProject`.
4. **Caché PCM**: `audio_import_tracks` (`audio/mod.rs`) decodifica cada stem con `import::decode_and_cache_track` (`audio/import.rs`), remuestrea al `target_sample_rate` y escribe `stem-*.pcm` y `stem-*.json` en disco vía `cache::write_track_pcm_and_metadata` (`audio/cache.rs`), emitiendo eventos `audio://import-progress`.
5. **Reproducir**: `activateProject` invoca `nativeAudioEngine.loadProject` (`audio_load_project`). `PlaybackEngine::load_project` prellena los buffers circulares `rtrb` mediante los hilos feeder (`playback/feeder_io.rs`). `audio_play` inicia el micro-fundido de 8 ms y el callback de salida CPAL en `ensure_stream` (`playback/mod.rs`) entrega las muestras a WASAPI sin alocaciones ni bloqueos.
6. **Medidores**: el callback guarda el pico post-fader de cada pista y de los buses (Main, Cue, salida, click) en `PeakMeter` atómicos (`playback/types.rs`), una vez por bloque. `get_playback_state` (`playback/transport.rs`) los lee y pone a cero sin tocar `stream_tracks`, y viajan en el campo `meters` de `audio_get_playback_state`. En TS, `MeterBallistics` (`src/audio/meterBallistics.ts`) aplica una caída de ~20 dB/s y `nativeAudioEngine.getTrackMeters` los entrega a Arreglo y Mezcla. Los medidores de la interfaz se suscriben al ciclo compartido de `meterFeed.ts` mediante `useLiveMeters`: cada lectura solo renderiza los componentes hoja del medidor, no la consola. El estado de reproducción se consulta con `StatePoller` (`statePoller.ts`): una petición pendiente, siguiente consulta al terminar la anterior, 33 ms reproduciendo y 200 ms en pausa, y consulta inmediata tras play, pausa, seek, saltos y carga. Las ondas de Arreglo se dibujan en dos canvas estáticos (base y reproducido, recortado con `clip-path`) y el cursor se mueve con `transform`: avanzar la posición no redibuja ningún canvas.

---

## 7. Deuda Técnica Registrada

1. **Archivos grandes**: `SectionEditorModal.tsx` (~430); en el motor, `audio/mod.rs` (~1140) y `playback/mod.rs` (~950). La mezcla del callback ya no está duplicada (`playback/callback.rs`).
