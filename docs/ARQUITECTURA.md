# Arquitectura del Sistema OmniTracks

Este documento detalla la estructura modular de la aplicación tras la división de archivos monolíticos (`desktop/src-tauri/src/audio/playback/` y `src/hooks/`), las especificaciones de todos los módulos del backend y frontend, las reglas obligatorias de codificación y el ciclo de vida del audio.

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
├── bus.rs          # TrackBus: tipos y conversión de buses de salida (main, cue, both)
├── fade.rs         # FadeEnvelope, FadeType y constantes (FADE_MS = 8.0): micro-fundidos
├── feeder_io.rs    # Lectura de frames PCM desde disco, staging y drenaje con remuestreo
├── guide.rs        # GuideCueEngine: síntesis y renderizado de cues vocales de guía para saltos de sección
├── jumps.rs        # queue_section_jump, cancel_queued_jump, toggle_vamp (impl PlaybackEngine)
├── transport.rs    # play, pause, stop, seek, get_playback_state, reopen_stream (impl PlaybackEngine)
├── types.rs        # NativeSongSection, QueuedJumpInfo, ActiveTrack, PlaybackStateSnapshot, etc.
└── tests.rs        # Suite completa de pruebas unitarias y benchmarks de audio
```

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
├── useImportFlow.ts       # Importación instantánea (Drop / Selector), escaneo y decodificación nativa
├── useMixerActions.ts     # Control de transporte, volumen, mute, solo, paneo, bus y secciones
└── useDawDragDrop.ts      # Manejo de eventos Drag & Drop de archivos y canciones sobre la DAW
```

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
   -> Inicializa feeders y prellena ring buffers rtrb (>= 500 ms)
          │
          ▼ Play
   audio_play -> PlaybackEngine::play (fade-in 8 ms en fade.rs)
          │
          ▼ Callback de Audio en Tiempo Real (ensure_stream en playback/mod.rs)
   Drena rtrb buffers + mezcla click (metronome.rs) + cues (guide.rs) -> CPAL WASAPI
```

1. **Importar**: `handleImportNative` (TS, `useImportFlow.ts`) invoca `audio_scan_folder` o `audio_scan_files` (Rust, `audio/mod.rs`), extrae metadatos y guarda la canción en `library.json` mediante `library_save_song` y el sidecar `omnitracks.project.json` mediante `library_write_sidecar`. **No se genera caché PCM en este paso**.
2. **Biblioteca**: `library_load` carga `library.json` al iniciar. La UI lista las canciones en `RepertoireTreeSidebar.tsx` y `LibraryView.tsx`.
3. **Añadir al Setlist**: `handleAddToSetlist` (TS, `useSetlist.ts`) añade la canción a `setlistQueue`. Verifica la caché con `nativeAudioEngine.checkProjectCacheStatus` (`audio_get_project_cache_status`). Si `isReady == false`, invoca `nativeAudioEngine.generateNativeCacheForProject`.
4. **Caché PCM**: `audio_import_tracks` (`audio/mod.rs`) decodifica cada stem con `import::decode_and_cache_track` (`audio/import.rs`), remuestrea al `target_sample_rate` y escribe `stem-*.pcm` y `stem-*.json` en disco vía `cache::write_track_pcm_and_metadata` (`audio/cache.rs`), emitiendo eventos `audio://import-progress`.
5. **Reproducir**: `activateProject` invoca `nativeAudioEngine.loadProject` (`audio_load_project`). `PlaybackEngine::load_project` prellena los buffers circulares `rtrb` mediante los hilos feeder (`playback/feeder_io.rs`). `audio_play` inicia el micro-fundido de 8 ms y el callback de salida CPAL en `ensure_stream` (`playback/mod.rs`) entrega las muestras a WASAPI sin alocaciones ni bloqueos.

---

## 7. Deuda Técnica Registrada

1. **`MARKER_PALETTE` duplicada**:
   - Definida actualmente de manera idéntica en `src/App.tsx` (línea 119) y en `src/hooks/useImportFlow.ts` (línea 39).
   - *Acción recomendada*: Centralizar en un módulo compartido de constantes de UI (`src/constants/ui.ts` o `src/types/project.ts`).
2. **`handleRelinkProject` en `src/App.tsx`**:
   - Se mantuvo directamente en `App.tsx` para respetar el orden de declaración y evitar errores de hoisting temporal (`TS2448`) con `activateProject` y `handleSelectView`.
   - *Acción recomendada*: Pasar las dependencias como callbacks a un submódulo específico durante una próxima fase de refactorización de vistas.
