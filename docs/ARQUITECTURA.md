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
- **`import.rs`**: Decodificación multiformato con Symphonia (MP3, WAV, FLAC, AAC, OGG) y Hound. Conversión directa a PCM y remuestreo al sample rate de destino en hilos desacoplados sin bloquear la interfaz.
- **`output.rs`**: Enumeración y configuración de dispositivos WASAPI con CPAL (`audio_settings.json`), gestión del estado del motor (`AudioEngineState`) y estadísticas de streaming en tiempo real (`AudioStreamStats`: callbacks, underruns, latencia máxima).
- **`resampler.rs`**: Adaptador de remuestreo en tiempo real basado en la librería `rubato` (SincFixedIn / varispeed) para alineación de fases entre pistas y modulación de pitch/tempo.
- **`metronome.rs`**: `MetronomeEngine`: generador síncrono de pulsos de click analítico a la muestra exacta (síntesis matemática de tonos sinusoidales de 2.5 kHz para acentos y 1.25 kHz para subdivisiones).
- **`mod.rs`**: Registro y despacho de todos los comandos Tauri IPC invocables desde el frontend con prefijo `audio_*`.

### 2.2 Módulo de Reproducción (`audio/playback/`)
El archivo monolítico original fue dividido en el módulo modular `playback/`, preservando historial (`git mv`) y visibilidad de APIs públicas:

```
desktop/src-tauri/src/audio/playback/
├── mod.rs          # PlaybackEngine: estructura central, ciclo de vida, buffers y callback CPAL (ensure_stream)
├── block.rs        # Lógica por bloque compartida por el callback real y su simulación en pruebas: buffering_ready (salida de buffering), consume_track_block (lectura de un anillo con resincronía tras underrun)
├── bus.rs          # TrackBus: tipos y conversión de buses de salida (main, cue, both)
├── clock.rs        # ClockJumps y advance_clock: saltos de sección y vueltas de vamp aplicados al reloj current_frame desde el callback
├── fade.rs         # FadeEnvelope, FadeType y constantes (FADE_MS = 8.0): micro-fundidos
├── feeder_io.rs    # Lectura de frames PCM desde disco, staging, drenaje con remuestreo, begin_new_segment (tras empalmes) y FeederAliveGuard
├── guide.rs        # GuideCueEngine: síntesis y renderizado de cues vocales de guía para saltos de sección
├── jumps.rs        # queue_section_jump, cancel_queued_jump, toggle_vamp (impl PlaybackEngine)
├── transport.rs    # play, pause, stop, seek (con rewind_tracks: handshake con los feeders), get_playback_state, reopen_stream (impl PlaybackEngine)
├── types.rs        # NativeSongSection, QueuedJumpInfo, ActiveTrack, PlaybackStateSnapshot, PeakMeter/BusMeters (medidores), etc.
└── tests.rs        # Suite completa de pruebas unitarias y benchmarks de audio (incluye pruebas con el motor real sobre una caché PCM sintética de rampas)
```

**Coherencia del transporte (Fase 1 de la auditoría)**
- **Reloj y discontinuidades**: el reloj `current_frame` solo lo avanza el callback. Al programar un salto cuantizado (`queue_section_jump`) o activar un vamp (`toggle_vamp`) se guardan en `ClockJumps` (atómicos); el callback los aplica con `advance_clock` en el instante exacto en que el feeder corta el audio. Un seek concurrente manda sobre el salto. El metrónomo se recoloca cuando un bloque no empieza donde terminó el anterior.
- **Seek con handshake por generación** (`rewind_tracks`): el transporte sube `seek_generation`, activa buffering, pide el seek a cada feeder, espera su `seek_ack`, vacía el anillo y publica `flush_done`. El feeder no empuja audio nuevo hasta ese momento y el callback no sale de buffering sin `flush_done` de la generación vigente. Si un feeder murió o no responde en 5 s, la pista se da por terminada y se registra un aviso.
- **Fin de pista**: cada feeder marca `eof` cuando ya empujó todo lo que le quedaba; esa pista no cuenta para salir de buffering ni para el contador de underruns.
- **Underrun**: `consume_track_block` lee solo fotogramas completos, anota los que faltaron en `skip_frames` y descarta esa cantidad cuando el audio vuelve, para que la pista siga alineada con el reloj.
- **Empalmes**: el tramo parcial previo a un salto o vuelta de vamp se completa con ceros y solo se emiten los fotogramas con señal (no el bloque entero que devuelve `process_partial` de rubato); tras el empalme el remuestreador empieza un tramo nuevo (`begin_new_segment`).

---

## 3. Módulo de Biblioteca y Persistencia (`desktop/src-tauri/src/library/`)

Gestiona el catálogo de canciones y la integridad de metadatos locales:
- **`mod.rs`**:
  - Implementa la persistencia atómica de `library.json` mediante `atomic_write_file` (escritura en `.tmp`, reemplazo atómico y copia de seguridad en `.backup.json`).
  - Manejo del archivo sidecar `omnitracks.project.json` en la carpeta de origen de cada canción (con fallback de lectura en `.omnitracks.json` para retrocompatibilidad).
  - Comandos Tauri IPC expuestos: `library_load`, `library_save`, `library_save_song`, `library_delete_song`, `library_update_song_folder`, `library_write_sidecar`, `library_read_sidecar`.

---

## 4. Servidor Remoto LAN (`desktop/src-tauri/src/lan.rs`)

Servidor HTTP y WebSocket local embebido (basado en Axum y Tokio, puerto 8765):
- **Funcionalidad**: Permite el control remoto en vivo desde smartphones de músicos (monitoreo personal) y sonidistas (ganancia, paneo, mute y solo por canal).
- **Seguridad**: Emparejamiento por token y código QR en pantalla, con roles estrictos (`Musician`, `SoundEngineer`) y límite de 16 sesiones concurrentes con reciclaje FIFO de sesiones desconectadas.
- **Sincronización**: Intercambio de snapshots de transporte y deltas de mezcla (`remote_exchange`), desacoplado del motor de audio principal.

---

## 5. Frontend Web & Desktop (React / TypeScript)

La lógica de control de `src/App.tsx` se encuentra desacoplada en custom hooks en `src/hooks/`:

```
src/hooks/
├── useOptimization.ts     # Poda y optimización PCM en navegador / OPFS (Web Audio)
├── useProjectActions.ts   # Carga inmediata, creación, edición de metadatos, borrado y JSON export/import
├── useSetlist.ts          # Gestión de lista de canciones (setlist), reorden, precarga y expulsión de RAM
├── useSetlistMeta.ts      # Nombre y fecha del servicio (almacenamiento local)
├── useProgressiveList.ts  # Render por tandas de listas largas (Biblioteca y explorador del Setlist)
├── useImportFlow.ts       # Importación instantánea (Drop / Selector), escaneo y decodificación nativa
├── useMixerActions.ts     # Control de transporte, volumen, mute, solo, paneo, bus y secciones
└── useDawDragDrop.ts      # Manejo de eventos Drag & Drop de archivos y canciones sobre la DAW
```

Páginas (`WorkspaceView` en `TopBar.tsx`): Setlist (`SetlistPageView.tsx`, `SetlistStrip.tsx`, `SongPickerModal.tsx`), En vivo (`LiveSetView.tsx`), Arreglo (`TimelineArranger.tsx`), Mezcla (`MultitrackMixer.tsx`) y Biblioteca (`LibraryAndModals.tsx`). La búsqueda de canciones está en `src/utils/songSearch.ts`.

Puentes con el escritorio en `desktop/frontend/`: `RemoteConnectionBridge.tsx` monta el diálogo «Conexión remota» y el botón de la barra superior mediante un portal; en `npm run dev` usa `previewInvoke.ts` (datos simulados, descartado de la compilación de producción) para poder ver el diseño sin Tauri.

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
          ▼ Callback de Audio en Tiempo Real (ensure_stream en playback/mod.rs)
   Drena rtrb buffers + mezcla click (metronome.rs) + cues (guide.rs) -> CPAL WASAPI
```

1. **Importar**: `handleImportNative` (TS, `useImportFlow.ts`) invoca `audio_scan_folder` o `audio_scan_files` (Rust, `audio/mod.rs`), extrae metadatos y guarda la canción en `library.json` mediante `library_save_song` y el sidecar `omnitracks.project.json` mediante `library_write_sidecar`. **No se genera caché PCM en este paso**.
2. **Biblioteca**: `library_load` carga `library.json` al iniciar. La UI lista las canciones en `LibraryView.tsx` (`LibraryAndModals.tsx`).
3. **Añadir al Setlist**: `handleAddToSetlist` (TS, `useSetlist.ts`) añade la canción a `setlistQueue`. Verifica la caché con `nativeAudioEngine.checkProjectCacheStatus` (`audio_get_project_cache_status`). Si `isReady == false`, invoca `nativeAudioEngine.generateNativeCacheForProject`.
4. **Caché PCM**: `audio_import_tracks` (`audio/mod.rs`) decodifica cada stem con `import::decode_and_cache_track` (`audio/import.rs`), remuestrea al `target_sample_rate` y escribe `stem-*.pcm` y `stem-*.json` en disco vía `cache::write_track_pcm_and_metadata` (`audio/cache.rs`), emitiendo eventos `audio://import-progress`.
5. **Reproducir**: `activateProject` invoca `nativeAudioEngine.loadProject` (`audio_load_project`). `PlaybackEngine::load_project` prellena los buffers circulares `rtrb` mediante los hilos feeder (`playback/feeder_io.rs`). `audio_play` inicia el micro-fundido de 8 ms y el callback de salida CPAL en `ensure_stream` (`playback/mod.rs`) entrega las muestras a WASAPI sin alocaciones ni bloqueos.
6. **Medidores**: el callback guarda el pico post-fader de cada pista y de los buses (Main, Cue, salida, click, guía) en `PeakMeter` atómicos (`playback/types.rs`), una vez por bloque. `get_playback_state` (`playback/transport.rs`) los lee y pone a cero sin tocar `stream_tracks`, y viajan en el campo `meters` de `audio_get_playback_state`. En TS, `MeterBallistics` (`src/audio/meterBallistics.ts`) aplica una caída de ~20 dB/s y `nativeAudioEngine.getTrackMeters` los entrega a Arreglo y Mezcla.

---

## 7. Deuda Técnica Registrada

1. **`MARKER_PALETTE` duplicada**:
   - Definida actualmente de manera idéntica en `src/App.tsx` (línea 119) y en `src/hooks/useImportFlow.ts` (línea 39).
   - *Acción recomendada*: Centralizar en un módulo compartido de constantes de UI (`src/constants/ui.ts` o `src/types/project.ts`).
2. **`handleRelinkProject` en `src/App.tsx`**:
   - Se mantuvo directamente en `App.tsx` para respetar el orden de declaración y evitar errores de hoisting temporal (`TS2448`) con `activateProject` y `handleSelectView`.
   - *Acción recomendada*: Pasar las dependencias como callbacks a un submódulo específico durante una próxima fase de refactorización de vistas.
3. **Errores silenciados**: `.catch(() => {})` en `App.tsx`, `useSetlist.ts:97`, `audioEngine.ts` y `nativeAudioEngine.ts` (lista exacta en `CLAUDE.md` §6). Incumplen la regla «nunca tragar errores».
4. **Código sin interfaz**: `handleCreateNewProject` y `handleImportJsonFile` en `useProjectActions.ts`.
5. **Archivos grandes**: `audioEngine.ts` (~2600 líneas), `App.tsx` (~1700), `LibraryAndModals.tsx` (~1550).
