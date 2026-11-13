# OmniTracks · Guía de Relevo (Handoff)

OmniTracks es un reproductor multipista para directores musicales y bandas en vivo (DAW en vivo ligero, estilo *Ableton Live / Playback / Reaper*). Prioridades: estabilidad del audio en tiempo real (cero *underruns*), baja latencia, bajo consumo en portátiles de 8 GB de RAM / 4 núcleos, funcionamiento 100 % offline y control remoto desde teléfonos por red local (LAN).

> **Cómo usar estos documentos.** Este archivo es la **puerta de entrada**: contexto, mapa de archivos, comandos y reglas. [`Manual.md`](Manual.md) es la **referencia técnica** (arquitectura, contratos, algoritmos, protocolos). [`docs/MOTOR_NATIVO_DISENO.md`](docs/MOTOR_NATIVO_DISENO.md) es la especificación de diseño del motor Rust. [`desktop/README.md`](desktop/README.md) cubre empaquetado, firma, publicación de actualizaciones y pruebas manuales de campo.
>
> **Regla de oro:** si el código y un documento se contradicen, **gana el código**; corrige el documento en el mismo commit.

---

## 1. Empieza aquí

### 1.1. Estado del repositorio
- Remoto: `https://github.com/jnaguinix/multitrack-google.git`.
- Rama de trabajo activa: **`motor-nativo`** (sincronizada con `origin/motor-nativo`; al momento de esta revisión va 27 commits por delante de `main` y 1 por detrás, es decir, **aún no se ha fusionado a `main`**). Verifícalo con `git rev-list --left-right --count main...motor-nativo`.
- Nombre de la app: **OmniTracks**. Identificador Tauri: `org.omnitracks.desktop`. Versión de escritorio: **0.2.2**, que debe mantenerse sincronizada en `desktop/src-tauri/tauri.conf.json`, `desktop/src-tauri/Cargo.toml` y `desktop/package.json` (más sus lockfiles).
- El proyecto se renombró desde un nombre heredado: **no reintroducir nombres antiguos**. Los únicos restos aceptados son el prefijo de cookies LAN `lt_monitor` / `lt_mixer`, las clases CSS `lt-*` y el nombre de lectura-compatible `.omnitracks.json` (ver §4).
- El `package.json` raíz aún se llama `react-example` y arrastra dependencias de la plantilla de Google AI Studio (`@google/genai`, `express`, `dotenv`, `motion`) que **no se importan desde `src/`**. También existen `.env.example`, `metadata.json` y `.aistudio/` (restos de AI Studio). No son necesarios para compilar ni ejecutar la app.

### 1.2. Dos plataformas, un frontend
| | Escritorio (Windows x64) | Web (navegador) |
|---|---|---|
| Contenedor | Tauri v2 + WebView2 | Navegador (build estático `dist/`) |
| Motor de audio | **Nativo en Rust** (`cpal` + `symphonia` + `rubato` + `rtrb`) | Web Audio API |
| Fachada JS | `nativeAudioEngine` | `webAudioEngine` |
| Persistencia | `library.json` + sidecar en disco (comandos `library_*`) | IndexedDB `OmniTracksWebDB` + OPFS |
| Control remoto LAN | Sí (servidor Rust, puerto 8765) | No |

El frontend elige el motor en una sola línea: `export const audioEngine = isDesktopEnvironment ? nativeAudioEngine : webAudioEngine` al final de [`src/audio/audioEngine.ts`](src/audio/audioEngine.ts). Toda la UI habla con `audioEngine` y no sabe cuál motor hay debajo. **El producto principal es el de escritorio**; la versión web se conserva como respaldo y para pruebas.

### 1.3. Modelo de datos de dos niveles
- **Biblioteca permanente** (`library.json`, en `%LOCALAPPDATA%\org.omnitracks.desktop\`): índice de todas las canciones (metadatos, pistas, secciones, mezcla, ruta de carpeta). **No contiene audio** y **nunca** modifica ni mueve los archivos originales del usuario. Cada carpeta de canción recibe además un sidecar visible `omnitracks.project.json`.
- **Setlist** (sesión del día): subconjunto ordenado de la biblioteca. Se representa con `inSetlist: true` + `setlistOrder` en cada canción y con la lista `activeSetlist` (ids) en `library.json`. Las canciones importadas entran con `inSetlist: false`; pasan al setlist con el botón `+ Set`. Quitar una canción del setlist o «Limpiar sesión» **no la borra de la biblioteca**.
- Otros archivos en `%LOCALAPPDATA%\org.omnitracks.desktop\`: `library.backup.json`, `audio_settings.json` (dispositivo/host/buffer de audio) y `pcm\` (caché de audio decodificado; ver [`Manual.md`](Manual.md) §5).

### 1.4. Flujo de una canción (resumen)
1. **Importar** carpeta/archivos → `audio_scan_folder` / `audio_scan_files` detectan pistas, secciones y metadatos → se calcula la huella (¿ya existe?) → la canción se crea en biblioteca con `inSetlist: false` y se guarda (`library_save_song` + sidecar).
2. En segundo plano se lanza `audio_import_tracks`: decodifica todos los stems a la caché PCM y devuelve picos de onda y duración; la canción se actualiza y, si no hay otra montada, se carga en el motor.
3. **`+ Set`** la añade al setlist. Si la caché PCM no está completa se regenera (`audio_get_project_cache_status` → `audio_import_tracks`). Antes se comprueba que los archivos originales existan (`audio_check_files_exist`); si faltan, se ofrece reubicar la carpeta.
4. **Quitar del setlist** detiene la reproducción si era la activa y **borra la caché PCM nativa** de esa canción (se regenera al volver a añadirla). La canción y su sidecar permanecen.
5. **Eliminar de la biblioteca** (`library_delete_song`) la quita de `library.json`, de `activeSetlist` y borra su caché `pcm\<song_id>`. Los audios originales no se tocan.

El diagrama secuencial completo está en [`Manual.md`](Manual.md) §4.

---

## 2. Mapa de archivos y responsabilidades

### 2.1. Raíz y configuración
| Archivo | Función |
|---|---|
| [`package.json`](package.json) | Scripts y dependencias del frontend compartido (React 19, TypeScript, Tailwind 4, Vite, Lucide, `tsx` para tests). |
| [`vite.config.ts`](vite.config.ts) | Vite + React + Tailwind; alias `@`; HMR configurable con `DISABLE_HMR`. |
| [`tsconfig.json`](tsconfig.json), [`index.html`](index.html) | Configuración TypeScript y HTML de entrada. |
| [`instrucciones.md`](instrucciones.md) | Esta guía. |
| [`Manual.md`](Manual.md) | Referencia técnica profunda. |
| [`docs/MOTOR_NATIVO_DISENO.md`](docs/MOTOR_NATIVO_DISENO.md) | Diseño del motor nativo (saltos, vamp, búferes, caché por frecuencia, pruebas). Su §10 lista pendientes conocidos. |
| `test/` | Pruebas unitarias del frontend (ver §3). |
| `public/assets/aistudio/` | Imágenes y mock HTML de mezclador de referencia visual (diseño de AI Studio). |
| `scratch/` | Scripts desechables; ignorado por Git. |

### 2.2. Frontend compartido (`src/`)
- [`src/main.tsx`](src/main.tsx): punto de entrada React.
- [`src/App.tsx`](src/App.tsx): **orquestador global** (~3100 líneas). Estado de biblioteca (`projects`), canción montada (`currentProject`), `setlistQueue`, transporte y medidores; importación nativa y web; handlers `handleAddToSetlist`, `handleRemoveFromSetlist`, `handleClearSetlist`, `handleReorderSetlist`; resolución de ambigüedad por huella; atajos de teclado; vista inicial por hash (`#setlist`, `#live`, `#arranger`, `#mixer`, `#library`).
- [`src/types/project.ts`](src/types/project.ts): tipos `SongProject`, `TrackChannel`, `SongSection`, `TransportState`, `OutputBus` (`main | cue-click | both`), `QuantizeMode` (`1-bar | 2-bars | section-end | immediate`), `SplitRoutingMode`, `AudioEngineMode` (`buffer | stream`), `RemoteSyncMessage`, etc.
- [`src/index.css`](src/index.css): estilos globales (Tailwind + clases `lt-*`).

**Componentes (`src/components/`)**
| Archivo | Función |
|---|---|
| [`TopBar.tsx`](src/components/TopBar.tsx) | Barra superior; vistas `Setlist`, `En vivo`, `Arreglo`, `Mezcla`, `Biblioteca` (`WorkspaceView`). Presupuesto de memoria, ajustes de audio y conexión remota. |
| [`TransportDeck.tsx`](src/components/TransportDeck.tsx) | Barra inferior: Play/Pausa, Stop, BPM, Pitch, Vamp, cuantización, reloj y medidores maestros. |
| [`RepertoireTreeSidebar.tsx`](src/components/RepertoireTreeSidebar.tsx) | Panel lateral con la biblioteca, búsqueda, importación, badges `+ Set` / `✓`, «Limpiar sesión actual» y menú contextual. |
| [`SetlistPageView.tsx`](src/components/SetlistPageView.tsx) | Vista Setlist: canción activa, onda maestra, saltos de sección, orden con arrastrar y soltar, mezclador flotante (se cierra con `Escape`), estado «Setlist vacío». |
| [`LiveSetView.tsx`](src/components/LiveSetView.tsx) | Vista de escenario de alto contraste: botones de sección grandes, cuentas regresivas, siguiente canción. |
| [`TimelineArranger.tsx`](src/components/TimelineArranger.tsx) | Vista Arreglo: pistas apiladas, zoom, edición de marcadores de sección. |
| [`MultitrackMixer.tsx`](src/components/MultitrackMixer.tsx) | Mesa de mezcla: faders en dB (−40 a +10), pan, Mute/Solo, selector de bus, medidores. |
| [`LibraryAndModals.tsx`](src/components/LibraryAndModals.tsx) | `LibraryView`, `SongMetadataEditModal`, `ConfirmSongActionModal`, `SongFingerprintPromptModal`, `StemImporterModal`, `SectionEditorModal`, `OptimizationProgressModal` e `inferTrackRoleAndColor`. |

**Motores y análisis de audio (`src/audio/`)**
| Archivo | Función |
|---|---|
| [`audioEngine.ts`](src/audio/audioEngine.ts) | Motor Web Audio (modos `buffer`/`stream`, presupuesto de RAM 256–4096 MB, defecto 1200) **y fachada** `audioEngine` que elige motor nativo o web. |
| [`nativeAudioEngine.ts`](src/audio/nativeAudioEngine.ts) | Cliente del motor Rust: implementa la misma API que el motor web invocando comandos `audio_*` y consultando el estado de reproducción. |
| [`streamingTrack.ts`](src/audio/streamingTrack.ts), [`pcmReaderClient.ts`](src/audio/pcmReaderClient.ts), [`pcmReader.worker.ts`](src/audio/pcmReader.worker.ts) | Streaming OPFS con ring buffer y Web Worker (solo web). |
| [`fingerprint.ts`](src/audio/fingerprint.ts) | `findSongFingerprintMatches`: detecta si una carpeta importada ya existe en la biblioteca. |
| [`smartAnalyzer.ts`](src/audio/smartAnalyzer.ts) | `cleanSongTitleAndMetadata` (limpieza de título y extracción de artista/BPM/tono) e `inferSongMetadataFromFiles`. |
| [`monoDetect.ts`](src/audio/monoDetect.ts), [`demoSynthesizer.ts`](src/audio/demoSynthesizer.ts) | Detección de pistas mono (web) y síntesis/picos de demostración. |

**Almacenamiento y utilidades**
| Archivo | Función |
|---|---|
| [`src/storage/projectDb.ts`](src/storage/projectDb.ts) | Capa de persistencia unificada. `saveProjectToDb` bifurca: escritorio → `desktopLibrary.ts`; web → IndexedDB. |
| [`src/storage/desktopLibrary.ts`](src/storage/desktopLibrary.ts) | Cliente de los comandos Rust `library_load`, `library_save`, `library_save_song`, `library_delete_song`, `library_update_song_folder`, `library_read_sidecar`. (El sidecar se escribe dentro de `library_save_song`; `library_write_sidecar` existe y está registrado pero el frontend no lo invoca.) |
| [`src/storage/opfsStorage.ts`](src/storage/opfsStorage.ts), [`pcmOptimizer.ts`](src/storage/pcmOptimizer.ts), [`cachePolicy.ts`](src/storage/cachePolicy.ts) | OPFS, conversión a PCM y poda de caché (límite 6 GB para canciones fuera del setlist). Solo web. |
| [`src/storage/sourceFiles.ts`](src/storage/sourceFiles.ts) | File System Access API: handles de archivos/carpetas, permisos y sidecar en navegador. |
| [`src/utils/nativeDialog.ts`](src/utils/nativeDialog.ts) | `isDesktopApp()` (detecta `window.__TAURI__`), diálogos nativos, `scanNativeFolder/Files`, caché nativa (`deleteProjectNativeCache`, `getNativeCacheStats`, `cleanOrphanNativeCaches`), `checkFilesExist`. |
| [`src/utils/fileImportHelper.ts`](src/utils/fileImportHelper.ts) | Parser rápido de cabecera WAV, lectura del sidecar en web (`PROJECT_SIDECAR_FILENAME`), filtrado de archivos de audio. |
| [`src/utils/songWaveform.ts`](src/utils/songWaveform.ts) | Onda maestra agregada de una canción. |

### 2.3. Escritorio Tauri v2 (`desktop/`)
| Archivo | Función |
|---|---|
| [`desktop/README.md`](desktop/README.md) | Compilación, instalador NSIS, firma y publicación de actualizaciones, conexión de teléfonos, pruebas de campo. |
| [`desktop/INFORME_POC.md`](desktop/INFORME_POC.md), [`desktop/test/probe-runtime.js`](desktop/test/probe-runtime.js) | Informe y sonda del PoC que justificó la plataforma (IndexedDB/OPFS en WebView2). Histórico. |
| [`desktop/package.json`](desktop/package.json) | Scripts `build` (instalador NSIS) y `build:portable` (solo `.exe`). |
| [`desktop/build-frontend.ps1`](desktop/build-frontend.ps1) | Hook `beforeBuildCommand`: compila el frontend a `desktop/dist/` con `VITE_OMNITRACKS_DESKTOP=1`. |
| [`desktop/build-release.ps1`](desktop/build-release.ps1) | Genera instalador firmado + `latest.json` para el actualizador (requiere clave de firma). |
| [`desktop/frontend/`](desktop/frontend/) | UI exclusiva de escritorio: `RemoteConnectionBridge.tsx` (servidor LAN, QR, IP, expulsión), `remoteState.ts`, `DesktopAudioSettings.tsx` (host/dispositivo/buffer/tono de prueba), `DesktopUpdates.tsx`, `connection.css`. |
| [`desktop/web/`](desktop/web/) | `remote.html/.js/.css`: página que el servidor LAN sirve a los teléfonos. |
| [`desktop/src-tauri/tauri.conf.json`](desktop/src-tauri/tauri.conf.json) | Ventana 1280×800, CSP estricta, capacidad `desktop-remote`, bundle NSIS (`currentUser`, WebView2 offline). |
| [`desktop/src-tauri/build.rs`](desktop/src-tauri/build.rs) | **Lista de comandos IPC** que genera sus permisos `allow-*` (en `permissions/autogenerated/`, ignorado por Git). |
| [`desktop/src-tauri/capabilities/desktop-remote.json`](desktop/src-tauri/capabilities/desktop-remote.json) | Permisos concedidos a la ventana `main`. |
| [`desktop/src-tauri/Cargo.toml`](desktop/src-tauri/Cargo.toml) | Dependencias Rust; la feature `shell` (por defecto) activa Tauri, QR, actualizador y diálogos; sin ella solo compila la librería (para pruebas). |

**Rust (`desktop/src-tauri/src/`)**
| Archivo | Función |
|---|---|
| `main.rs` | Arranque Tauri, `generate_handler!` con todos los comandos, estado `RemoteState` y `AudioEngineState`, comandos `remote_*`. |
| `lib.rs` | Expone los módulos `audio`, `lan`, `library`, `protocol` (usados por `main.rs` y por los tests de integración). |
| `lan.rs` | Servidor HTTP + WebSocket (**axum**) en el puerto TCP 8765: emparejamiento, sesiones, cola de comandos. |
| `protocol.rs` | Tipos del protocolo (`Role`, `Snapshot`, `MixCommand`, mensajes de estado). |
| `updates.rs` | Comandos `desktop_update_*` (actualizador firmado de Tauri vía GitHub Releases). |
| `library/mod.rs` | `library.json` (carga con recuperación desde backup, guardado atómico), sidecar, comandos `library_*`, limpieza nativa de títulos (`clean_song_title_and_metadata`). |
| `audio/mod.rs` | Comandos `audio_*`: importación (concurrencia 2–4 trabajadores), escaneo, control de transporte, caché. |
| `audio/output.rs` | `AudioSettings`, `AudioEngineState`, enumeración de hosts/dispositivos, estadísticas del stream, tono de prueba. |
| `audio/playback.rs` | `PlaybackEngine`: hilos feeder por pista, callback CPAL, saltos, vamp, crossfades, ruteo, guía hablada (`GuideCueEngine`), reapertura del stream. |
| `audio/resampler.rs` | `TrackResampler`: envoltorio de `rubato::SincFixedIn` con ajuste dinámico de ratio (varispeed/pitch). |
| `audio/metronome.rs` | Click sintetizado y alineado a muestra. |
| `audio/cache.rs` | Caché PCM `i16`, metadatos JSON, picos de onda, detección mono, chequeo de espacio libre. |
| `audio/import.rs` | Decodificación Symphonia y remuestreo a la frecuencia del dispositivo. |
| `tests/` | `lan_protocol.rs`, `verify_manual_flow.rs`, `benchmark_import.rs` (integración). |

---

## 3. Compilación, ejecución y pruebas

### 3.1. Requisitos (Windows)
- **Node.js 24 x64** + npm, **Git**, **Rust estable** con toolchain `stable-x86_64-pc-windows-msvc`, y **Visual Studio Build Tools** con la carga *Desarrollo para el escritorio con C++* (instrucciones de `winget` en [`desktop/README.md`](desktop/README.md)).
- Si `cargo` no está en el `PATH` de la terminal, apunta a la instalación local, por ejemplo:
  ```powershell
  $env:CARGO_HOME  = '<ruta-a>\cargo'
  $env:RUSTUP_HOME = '<ruta-a>\rustup'
  $env:PATH        = "$env:CARGO_HOME\bin;$env:PATH"
  ```
  (En la máquina del autor original estas carpetas vivían bajo `C:\Users\jpuerta\.codex\...`; **no es una ruta estándar** y puede no existir en tu equipo. Lo normal es `rustup` en `%USERPROFILE%\.cargo`.)
- Instalación de dependencias, desde la raíz: `npm.cmd install --legacy-peer-deps --no-package-lock` y `npm.cmd ci --prefix desktop`.

### 3.2. Comandos frecuentes (desde la raíz)
| Tarea | Comando | Notas |
|---|---|---|
| Servidor de desarrollo web | `npm.cmd run dev` | Vite en `http://localhost:3000` (`--host=0.0.0.0`). Solo motor web. |
| Verificar tipos | `npm.cmd run lint` | `tsc --noEmit`. |
| Pruebas frontend | `npm.cmd test` | Ejecuta `test/titleCleaning.test.ts` y `test/trackFingerprint.test.ts` con `tsx`. |
| Pruebas Rust | `cargo test --locked --release --target x86_64-pc-windows-msvc --manifest-path desktop/src-tauri/Cargo.toml --no-default-features` | ≈48 tests (unitarios + integración); sin WebView ni tarjeta de sonido. `--no-default-features` omite la feature `shell`. |
| Build web | `npm.cmd run build` | Genera `dist/`. |
| Ejecutable portátil (diagnóstico) | `npm.cmd --prefix desktop run build:portable` | Produce `desktop/src-tauri/target/x86_64-pc-windows-msvc/release/omnitracks-desktop.exe`; requiere WebView2 instalado. |
| **Instalador NSIS** | `npm.cmd --prefix desktop run build` | Produce `desktop/src-tauri/target/x86_64-pc-windows-msvc/release/bundle/nsis/*-setup.exe` (incluye WebView2 offline). |
| Release firmada con actualizador | `desktop/build-release.ps1 -PublicKeyFile <clave.pub>` | Ver [`desktop/README.md`](desktop/README.md). Tag `desktop-v<versión>`. |

El estado verificado al revisar esta documentación fue: `npm test` pasa (limpieza de títulos y huellas) y `npm run lint` pasa sin errores. Las pruebas Rust y los *builds* de escritorio no se re-ejecutaron en esa revisión: ejecútalos antes de entregar.

### 3.3. Qué cubren los tests
- **Frontend:** casos de limpieza de títulos (`«Multitrack _ERES BENDITO_ ORIGINAL Jaime Murrel-G major-108bpm-440hz»` → título «Eres Bendito», artista «Jaime Murrel», tono G major, 108 BPM) y escenarios de huella (100 %, ±1 pista, >1 pista de diferencia, canción distinta).
- **Rust:** caché PCM, mono real, sincronización de varispeed, alineación del click, ruteo Split-Mono por bus, desconexión y reapertura del dispositivo conservando la posición, importación, escritura atómica de la biblioteca, sidecar canónico/heredado, limpieza de títulos, admisión y lotes del servidor LAN, protocolo LAN.

---

## 4. Reglas críticas de desarrollo

1. **Intangibilidad del audio del usuario.** Jamás renombrar, mover, sobrescribir ni borrar los archivos de audio originales. La app solo escribe: la caché en `%LOCALAPPDATA%\org.omnitracks.desktop\` y el sidecar `omnitracks.project.json` en la carpeta de cada canción. Si existe el nombre heredado `.omnitracks.json`, se **lee** por compatibilidad, pero se escribe siempre el canónico.
2. **Callback de audio en tiempo real (objetivo de diseño).** Dentro del callback de CPAL no debe haber: reservas de memoria, E/S de disco, `tracing`/`println!`, ni bloqueos que puedan esperar. El paso de datos entre hilos feeder y callback usa búferes circulares *lock-free* (`rtrb`).
   > ⚠️ **Estado real:** el callback actual (`audio/playback.rs`, cierre pasado a `build_output_stream`) **todavía incumple parte de esta regla**: crea `vec![0.0; frames]` por bloque (búferes de bus y de click/guía) y toma `std::sync::Mutex` (`lock()`) sobre el *consumer* de cada pista, el metrónomo, la guía, las secciones y el fade. No hay logging en el callback. Es **deuda técnica conocida**: no empeorarla, y preferir buffers preasignados y `try_lock`/atómicos al tocar esa zona.
3. **Varispeed continuo.** Los cambios de afinación/ratio reutilizan el `rubato::SincFixedIn` ya activo de cada pista (`set_resample_ratio_relative`); nunca instanciar un remuestreador nuevo mientras suena una pista.
4. **Empalmes sin clic.** Todo salto, vamp o seek aplica un micro-crossfade de `FADE_MS = 8` ms; play/pausa/stop usan además un `FadeEnvelope`.
5. **Persistencia única.** Toda modificación de canción debe pasar por `saveProjectToDb(song)`; en escritorio esto invoca `library_save_song`, que actualiza `library.json`, sincroniza `activeSetlist` (según `inSetlist`) y reescribe el sidecar. No escribir `library.json` por otras vías.
6. **Setlist ≠ biblioteca.** Quitar del setlist solo pone `inSetlist = false` (y retira el id de `activeSetlist`); nunca elimina de la biblioteca.
7. **Nuevo comando IPC.** Hay que tocar **cuatro** sitios (ver [`Manual.md`](Manual.md) §8.1): función `#[tauri::command]`, `generate_handler!` en `main.rs`, lista en `build.rs` y permiso `allow-…` en `capabilities/desktop-remote.json`. Si falta uno, el comando falla en tiempo de ejecución o la app no compila.
8. **Seguridad LAN.** El control remoto solo puede enviar `setTrackGain/Mute/Pan/Solo` y únicamente desde el rol `mezclador`. No añadir comandos de transporte al protocolo remoto sin una revisión de seguridad.
9. **Documentación.** Al cambiar un contrato (comandos, rutas, formatos, atajos, puertos) actualiza `instrucciones.md` y `Manual.md` en el mismo commit.

---

## 5. Atajos de teclado
Definidos en `src/App.tsx` (se ignoran mientras el foco está en `input`, `textarea`, `select` o elementos editables, y solo si hay canción montada):
- **Espacio**: Play / Pausa.
- **V**: activar/desactivar Vamp.
- **1 – 9**: saltar (cuantizado) a la sección n.º 1–9 de la canción.
- **Esc**: cierra el mezclador flotante de la vista Setlist (`SetlistPageView.tsx`).

---

## 6. Limitaciones y pendientes conocidos
1. **Saltos cuantizados cerca del límite.** Si el límite de compás cae dentro del horizonte ya encolado por el feeder (~600 ms), el salto puede posponerse al siguiente compás. [`docs/MOTOR_NATIVO_DISENO.md`](docs/MOTOR_NATIVO_DISENO.md) §1.3 (ruta de descarte «Caso B», `stream_epoch`, `FlushAndSeek`) y §10 (*Jump Reserve Buffers*) describen mecanismos que **aún no están implementados**; el documento ya lo indica en una nota de estado. Al implementarlos, actualiza esa nota.
2. **Deuda del callback de audio** (§4, regla 2).
3. **Sin hilo con prioridad de tiempo real explícita.** El código no llama a APIs de prioridad de Windows (p. ej. MMCSS); solo se activa la feature `realtime` de `cpal`.
4. Limpieza pendiente de restos de AI Studio (ver §1.1) y de `npm run clean` (usa `rm -rf`, no funciona en PowerShell/Windows).
5. La rama `motor-nativo` no se ha fusionado en `main`.

---

## 7. Lista de comprobación para retomar el proyecto
1. `git status`, `git log --oneline -n 10` y confirmar rama `motor-nativo`.
2. `npm.cmd ci` (o `install --legacy-peer-deps`) y `npm.cmd ci --prefix desktop`.
3. `npm.cmd run lint` y `npm.cmd test`.
4. Pruebas Rust (comando de §3.2).
5. Lee [`Manual.md`](Manual.md) §2–§5 para entender flujo de datos y motor.
6. Arranca la app: `npm.cmd --prefix desktop run build:portable` y ejecuta el `.exe`; importa una carpeta de stems, pulsa `+ Set`, reproduce, prueba saltos de sección, Vamp y Split-Mono.
7. Si vas a publicar: sigue [`desktop/README.md`](desktop/README.md) (versiones sincronizadas, firma, tag `desktop-v<versión>`).
