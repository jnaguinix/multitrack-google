# OmniTracks · Guía de Relevo y Arquitectura

OmniTracks es un reproductor multipista profesional para directores musicales y bandas en vivo (DAW en vivo ligero estilo *Ableton Live / Playback / Reaper*). Su prioridad absoluta es la estabilidad del audio en tiempo real con cero underruns, baja latencia y bajo consumo en ordenadores portátiles estándar (8 GB de RAM y 4 núcleos), funcionando 100% offline y con soporte para controles remotos en teléfonos a través de red local (LAN).

---

## 1. Empieza aquí (Contexto Rápido para Nuevos Desarrolladores o IAs)

1. **Estado del Repositorio:**
   - Repositorio remoto: `https://github.com/jnaguinix/multitrack-google.git`
   - Rama activa de desarrollo: `motor-nativo` (en transición hacia `main`).
   - Identificador de la aplicación: `org.omnitracks.desktop`
   - Nombre de la aplicación: **OmniTracks** (renombrado completamente; no usar nombres heredados).
2. **Modelo de la Aplicación (Dos Niveles):**
   - **Biblioteca Permanente (`library.json`):** Índice global de canciones ubicado en `%LOCALAPPDATA%\org.omnitracks.desktop\library.json`. Guarda metadatos, pistas, duraciones y rutas a carpetas en disco. **Nunca guarda audio crudo ni modifica/mueve los archivos originales del usuario**. Cada carpeta de canción contiene además un archivo sidecar canónico `omnitracks.project.json` (visible en el explorador de Windows) con sus secciones y ajustes.
   - **Setlist (Sesión del Día):** Lista ordenada y efímera de reproducción (`inSetlist: true`, `activeSetlist: []` en `library.json`). Las canciones importadas entran a la biblioteca con `inSetlist: false` y solo pasan al setlist si el usuario pulsa `+ Set`. Limpiar la sesión o quitar canciones del setlist las retira del escenario pero las conserva intactas en la biblioteca.
3. **Motores de Audio:**
   - **Versión Escritorio (Windows):** Utiliza un **Motor Nativo en Rust** (`CPAL` + `Symphonia` + `Rubato` + `rtrb`). Decodifica en paralelo a caché PCM local (`pcm/<song_id>/`), remuestrea con varispeed sin recrear remuestreadores, realiza saltos de sección cuantizados sin underruns y maneja ruteo Split-Mono sin pasar por Web Audio API ni OPFS.
   - **Versión Web (Navegador):** Utiliza el motor Web Audio tradicional (`src/audio/audioEngine.ts`) con modos `buffer` (RAM) y `stream` (OPFS con `SyncAccessHandle`).

---

## 2. Mapa Completo de Archivos y Responsabilidades

### 2.1. Raíz y Configuración del Proyecto
- [`package.json`](package.json): Dependencias del frontend compartido (React 19, TypeScript, Lucide, Tailwind, Vite).
- [`vite.config.ts`](vite.config.ts): Configuración de empaquetado Vite y variables de entorno.
- [`instrucciones.md`](instrucciones.md): Esta guía de relevo para desarrolladores e IAs.
- [`Manual.md`](Manual.md): Manual técnico exhaustivo de arquitectura, contratos y algoritmos.
- [`docs/MOTOR_NATIVO_DISENO.md`](docs/MOTOR_NATIVO_DISENO.md): Especificación técnica del motor nativo en Rust.

### 2.2. Frontend Compartido (`src/`)
- [`src/main.tsx`](src/main.tsx): Punto de entrada React.
- [`src/App.tsx`](src/App.tsx): Orquestador principal de estado global: biblioteca, setlist activo, canción montada, transporte, atajos de teclado y modales.
- [`src/types/project.ts`](src/types/project.ts): Tipos TypeScript clave: `SongProject`, `TrackChannel`, `SongSection`, `TransportState`, `OutputBus`, `QuantizeMode`, etc.

#### Componentes de la Interfaz (`src/components/`)
- [`src/components/TopBar.tsx`](src/components/TopBar.tsx): Barra superior con selector de vistas (`Setlist`, `En vivo`, `Arreglo`, `Mezcla`, `Control rápido`, `Biblioteca`), presupuesto de memoria y menú de audio.
- [`src/components/TransportDeck.tsx`](src/components/TransportDeck.tsx): Barra de transporte fija inferior: Play/Pausa, Detener, BPM, Pitch (tono), Vamp, Cuantización, Reloj de tiempo transcurrido y medidores maestros.
- [`src/components/RepertoireTreeSidebar.tsx`](src/components/RepertoireTreeSidebar.tsx): Barra lateral izquierda acoplable. Muestra la biblioteca completa, buscador en tiempo real, importación rápida de archivos/carpetas, badges `+ Set` / `✓` interactivos para añadir/quitar de la sesión, botón de vaciado de sesión («Limpiar sesión actual») y menú contextual de opciones (`...`).
- [`src/components/SetlistPageView.tsx`](src/components/SetlistPageView.tsx): Vista del Setlist: cabecera de la canción activa, forma de onda maestra navegable, botones de salto de sección con código de color, orden de reproducción reorganizable por Drag & Drop y botón global «Limpiar sesión». Si no hay canciones en el setlist, muestra el estado limpio «Setlist vacío».
- [`src/components/LiveSetView.tsx`](src/components/LiveSetView.tsx): Vista en vivo para escenario de alto contraste. Botones de sección grandes, temporizadores en cuenta regresiva y disparadores de siguiente canción.
- [`src/components/TimelineArranger.tsx`](src/components/TimelineArranger.tsx): Vista de Arreglo estilo DAW multipista con pistas apiladas, zoom horizontal y edición de marcadores de sección en tiempo real.
- [`src/components/MultitrackMixer.tsx`](src/components/MultitrackMixer.tsx): Mesa de mezclas profesional con faders de ganancia en decibelios (−40 a +10 dB), perillas de paneo (−100% a +100%), botones Mute/Solo, selector de bus (`MAIN`, `CUE/CLICK`, `BOTH`) y medidores estéreo Peak/RMS.
- [`src/components/StageRemoteView.tsx`](src/components/StageRemoteView.tsx): Vista de control rápido local accesible por `#remote`.
- [`src/components/LibraryAndModals.tsx`](src/components/LibraryAndModals.tsx): Modales del sistema:
  - `LibraryView`: Vista de biblioteca con gestión completa de canciones y vinculación de carpetas.
  - `ConfirmSongActionModal`: Confirmación al seleccionar una canción del repertorio (Cargar en DAW / Añadir o Quitar de la sesión).
  - `SongMetadataEditModal`: Editor en vivo de título, artista, BPM, compás y tonalidad.
  - `SongFingerprintPromptModal`: Modal de resolución de ambigüedad si una carpeta coincide $\ge 80\%$ con una canción existente.
  - `SectionEditorModal`: Editor detallado de inicio/fin de secciones, colores y modo Vamp predeterminado.
  - `StemImporterModal`: Modal de importación y asignación de pistas.

#### Almacenamiento y Utilidades (`src/storage/` y `src/utils/`)
- [`src/storage/desktopLibrary.ts`](src/storage/desktopLibrary.ts): Cliente frontend para invocar los comandos de Tauri que gestionan `library.json` y sidecars en disco (`library_load`, `library_save`, `library_save_song`, `library_delete_song`, `library_update_song_folder`, `library_read_sidecar`, `library_write_sidecar`).
- [`src/storage/projectDb.ts`](src/storage/projectDb.ts): Capa de abstracción de persistencia: bifurca a `desktopLibrary` si es escritorio, o a IndexedDB (`OmniTracksWebDB`) si es web.
- [`src/storage/opfsStorage.ts`](src/storage/opfsStorage.ts): Almacenamiento OPFS para la versión web.
- [`src/storage/pcmOptimizer.ts`](src/storage/pcmOptimizer.ts): Conversión secuencial a PCM para la versión web.
- [`src/utils/nativeDialog.ts`](src/utils/nativeDialog.ts): Diálogos nativos de Windows para seleccionar archivos de audio y carpetas, puente IPC con el motor nativo de audio y caché.
- [`src/utils/trackFingerprint.ts`](src/utils/trackFingerprint.ts): Algoritmo de huella digital de pistas (comparación de stem count $\pm 1$ y $80\%$ coincidencia de peso/duración).
- [`src/utils/titleCleaning.ts`](src/utils/titleCleaning.ts): Heurísticas de limpieza de títulos y extracción automática de BPM, artista y tono desde nombres de carpetas.
- [`src/utils/songWaveform.ts`](src/utils/songWaveform.ts): Síntesis y renderizado de la forma de onda maestra agregada.
- [`src/utils/fileImportHelper.ts`](src/utils/fileImportHelper.ts): Parser ultrarrápido de cabeceras WAV en `< 1 ms`.

#### Motor Web (`src/audio/`)
- [`src/audio/audioEngine.ts`](src/audio/audioEngine.ts): Motor de audio en Web Audio API (usado en navegador web).
- [`src/audio/streamingTrack.ts`](src/audio/streamingTrack.ts): Ring buffer y ventana deslizante para streaming OPFS web.
- [`src/audio/pcmReaderClient.ts`](src/audio/pcmReaderClient.ts) y [`src/audio/pcmReader.worker.ts`](src/audio/pcmReader.worker.ts): Lectura asíncrona de OPFS en web.

---

### 2.3. Aplicación de Escritorio Tauri v2 (`desktop/`)
- [`desktop/package.json`](desktop/package.json): Scripts de empaquetado de Tauri (`build`, `build:portable`).
- [`desktop/build-frontend.ps1`](desktop/build-frontend.ps1): Script previo que compila el frontend en `desktop/dist/` activando `VITE_OMNITRACKS_DESKTOP=1`.
- [`desktop/frontend/RemoteConnectionBridge.tsx`](desktop/frontend/RemoteConnectionBridge.tsx): Panel de control del servidor LAN (generación de QR, selección de IP y expulsión de clientes).
- [`desktop/web/`](desktop/web/): Archivos estáticos servidos a los teléfonos móviles por el servidor LAN (`remote.html`, `remote.js`, `remote.css`).

#### Backend Nativo en Rust (`desktop/src-tauri/`)
- [`desktop/src-tauri/Cargo.toml`](desktop/src-tauri/Cargo.toml): Dependencias Rust (`cpal`, `symphonia`, `rubato`, `rtrb`, `serde`, `tauri`, `warp`, `tokio`).
- [`desktop/src-tauri/tauri.conf.json`](desktop/src-tauri/tauri.conf.json): Configuración de ventana, plugins y capacidades de Tauri.
- [`desktop/src-tauri/capabilities/desktop-remote.json`](desktop/src-tauri/capabilities/desktop-remote.json): Permisos de IPC para el servidor LAN, motor de audio y biblioteca.
- [`desktop/src-tauri/src/main.rs`](desktop/src-tauri/src/main.rs): Arranque de Tauri, registro de todos los comandos IPC y estado compartido `AudioEngineState`.
- [`desktop/src-tauri/src/lan.rs`](desktop/src-tauri/src/lan.rs): Servidor HTTP y WebSocket local (puerto TCP 8765) para monitoreo y mezcla remota con teléfonos.
- [`desktop/src-tauri/src/protocol.rs`](desktop/src-tauri/src/protocol.rs): Mensajes del protocolo cliente-servidor LAN.
- [`desktop/src-tauri/src/updates.rs`](desktop/src-tauri/src/updates.rs): Verificación y descarga de actualizaciones en segundo plano.

#### Módulo de Biblioteca en Rust (`desktop/src-tauri/src/library/`)
- [`desktop/src-tauri/src/library/mod.rs`](desktop/src-tauri/src/library/mod.rs):
  - `load_library_internal` y `save_library_internal`: Carga y guardado atómico (con copia de seguridad `.backup.json`) de `library.json`.
  - `write_sidecar` y `read_sidecar`: Lectura/escritura canónica de `omnitracks.project.json` (con compatibilidad de lectura para `.omnitracks.json`).
  - `clean_song_title_and_metadata`: Algoritmo nativo de extracción de metadatos.
  - Comandos IPC: `library_load`, `library_save`, `library_save_song`, `library_delete_song`, `library_update_song_folder`, `library_write_sidecar`, `library_read_sidecar`.

#### Módulo de Audio Nativo en Rust (`desktop/src-tauri/src/audio/`)
- [`desktop/src-tauri/src/audio/mod.rs`](desktop/src-tauri/src/audio/mod.rs): Registro de comandos de audio y enlace entre el frontend y el reproductor nativo.
- [`desktop/src-tauri/src/audio/output.rs`](desktop/src-tauri/src/audio/output.rs): Enumeración de dispositivos WASAPI/DirectSound, configuración de stream de audio en tiempo real con `cpal`, recuperación ante desconexión de hardware en caliente y contadores de diagnóstico/telemetría.
- [`desktop/src-tauri/src/audio/playback.rs`](desktop/src-tauri/src/audio/playback.rs):
  - `PlaybackFeeder`: Hilo de precarga en anillo (`rtrb`) que lee PCM de disco hacia el búfer circular sin bloquear el callback de audio.
  - Varispeed continuo: remuestreadores `rubato::SincFixedIn` por pista persistentes en memoria durante la reproducción; cambio de tono con `set_resample_ratio_relative` sin clics ni reinicios.
  - Saltos cuantizados con micro-crossfades y loops *Vamp*.
  - Metrónomo / click sincronizado a nivel de muestra y síntesis de cues de guía hablada.
  - Ruteo Split-Mono (`Bus::Main`, `Bus::CueClick`, `Bus::Both`).
- [`desktop/src-tauri/src/audio/cache.rs`](desktop/src-tauri/src/audio/cache.rs): Almacenamiento PCM 16-bit signed en disco (`%LOCALAPPDATA%\org.omnitracks.desktop\pcm\<song_id>\`), detección mono/estéreo real y extracción de picos de onda.
- [`desktop/src-tauri/src/audio/import.rs`](desktop/src-tauri/src/audio/import.rs): Decodificación paralela de stems multiformato con Symphonia y remuestreo rápido al sample rate del dispositivo.

---

## 3. Instrucciones de Compilación y Ejecución

### 3.1. Requisitos Previos en Windows
- **Node.js 24 x64** y **npm**
- **Rust estable (toolchain `x86_64-pc-windows-msvc`)**
- **Visual Studio Build Tools** con carga de trabajo *Desarrollo para el escritorio con C++* y el Windows SDK correspondiente.
- Si las herramientas de Rust no están en el `PATH` global de la terminal actual, exportar las variables de entorno locales:
  ```powershell
  $env:CARGO_HOME = 'C:\Users\jpuerta\.codex\visualizations\2026\11\09\01a1be2f-be92-7153-bd62-a2684be8afbf\cargo'
  $env:RUSTUP_HOME = 'C:\Users\jpuerta\.codex\visualizations\2026\11\09\01a1be2f-be92-7153-bd62-a2684be8afbf\rustup'
  $env:PATH = "$env:CARGO_HOME\bin;$env:PATH"
  ```

### 3.2. Comandos Frecuentes

| Tarea | Comando desde la raíz | Resultado |
|---|---|---|
| **Verificar tipos TypeScript** | `npm.cmd run lint` | Ejecuta `tsc --noEmit` sobre todo el proyecto. |
| **Pruebas unitarias frontend** | `npm.cmd test` | Ejecuta pruebas de limpieza de títulos y huellas de pistas con `tsx`. |
| **Pruebas unitarias Rust** | `cargo test --manifest-path desktop/src-tauri/Cargo.toml --target x86_64-pc-windows-msvc --release` | 40+ tests unitarios y de integración de audio, caché, LAN y biblioteca. |
| **Generar binario ejecutable portátil** | `npm.cmd --prefix desktop run build:portable` | Produce `desktop/src-tauri/target/release/omnitracks-desktop.exe` (~21 MB). |
| **Generar instalador NSIS completo** | `npm.cmd --prefix desktop run build` | Produce el paquete de instalación oficial `*-setup.exe` con runtime WebView2 integrado. |
| **Construir versión Web (Netlify)** | `npm.cmd run build` | Compila los archivos estáticos en `dist/`. |

---

## 4. Reglas Críticas de Desarrollo y Buenas Prácticas

1. **Intangibilidad de archivos de audio:** La aplicación **JAMÁS** debe renombrar, mover, sobreescribir ni eliminar los archivos de audio originales del usuario en su disco duro. Solo puede escribir archivos temporales/caché en `%LOCALAPPDATA%\org.omnitracks.desktop\` y el archivo de metadatos `omnitracks.project.json` en la carpeta de la canción.
2. **Callback de audio en tiempo real de Rust (Audio Hard Real-Time):**
   - **PROHIBIDO** realizar alocaciones de memoria dinámica (`Vec::new`, `String`, `format!`, `Box`), operaciones de I/O de disco, llamadas bloqueantes (`std::sync::Mutex`, canales no acotados) o registros de logs (`tracing::info!`, `println!`) dentro del callback de audio de CPAL.
   - Todo paso de datos entre el hilo de audio y los hilos de disco/red debe realizarse mediante buffers circulares *lock-free* (`rtrb`).
3. **Persistencia y modelo de datos:**
   - Toda modificación de canciones debe guardarse a través de `saveProjectToDb(updatedSong)`, lo cual sincroniza automáticamente tanto `library.json` como el sidecar `omnitracks.project.json`.
   - Limpiar o quitar canciones del setlist solo actualiza `inSetlist = false` y `activeSetlist`, **nunca** elimina la canción de la biblioteca permanente.
