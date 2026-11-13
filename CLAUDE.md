# OmniTracks — Guía de Arquitectura y Reglas de Desarrollo

## 1. Qué es OmniTracks
Reproductor de multitracks optimizado para cultos y música en vivo. Dispone de dos entornos:
- **Web**: React 19 (^19.0.1), TypeScript, Tailwind CSS 4 (^4.3.3) y Vite, con motor Web Audio API / AudioContext y almacenamiento en OPFS / IndexedDB.
- **Escritorio**: Tauri v2 para Windows x64 con WebView2 Evergreen y motor de audio nativo multihilo de alto rendimiento implementado en Rust (CPAL, Symphonia, rubato y rtrb).

---

## 2. Dónde está cada cosa
- `src/App.tsx`: Componente raíz, orquestador de vistas, modales globales, layout y referencias principales.
- `src/hooks/*`: Custom hooks desacoplados (`useImportFlow`, `useOptimization`, `useSetlist`, `useProjectActions`, `useMixerActions`, `useDawDragDrop`).
- `src/hooks/useSetlistMeta.ts`: Nombre y fecha del servicio (almacenamiento local de la app).
- `src/components/SetlistStrip.tsx`: Fila de fichas del setlist con la flecha de transición por canción y el modo editar.
- `src/utils/setlistTransition.ts` y `src/utils/sectionTemplates.ts`: Transición por canción (con respaldo en el ajuste general) y plantillas de sección (Intro, Verso 1, Coro…).
- `src/components/SongPickerModal.tsx`: Explorador de canciones superpuesto de la página Setlist (buscar en la biblioteca, ordenar, añadir o quitar del setlist e importar).
- `src/audio/nativeAudioEngine.ts`: Adaptador puente TypeScript para invocar los comandos Tauri del motor nativo en Rust (`audio_*`).
- `src/audio/meterBallistics.ts`: Balística (caída ~20 dB/s, retención de recorte) de los picos reales que mide el motor nativo para los medidores de Arreglo y Mezcla.
- `src/audio/audioEngine.ts`: Motor de audio Web (Web Audio API / OPFS). La versión web ya no se usa ni se mantiene; el archivo sigue porque el escritorio aún depende de partes de él (retiro pendiente).
- `src/storage/*`: Persistencia en IndexedDB (`projectDb.ts`), OPFS (`opfsStorage.ts`), File System Access (`sourceFiles.ts`) y puente desktop (`desktopLibrary.ts`).
- `desktop/src-tauri/src/audio/*`: Motor nativo: `playback/` (transporte, buffers `rtrb`, callback CPAL), `cache.rs` (caché PCM i16 y picos), `import.rs` (decodificación Symphonia/Hound), `output.rs` (dispositivos WASAPI), `resampler.rs` (remuestreo `rubato`), `metronome.rs` (click sintético), `mod.rs` (comandos `audio_*`).
- `desktop/src-tauri/src/library/`: Gestión de `library.json`, persistencia atómica y sidecars `omnitracks.project.json` (comandos `library_*`).
- `desktop/src-tauri/src/lan.rs`: Servidor HTTP/WebSocket local para control remoto desde móviles (músicos y sonidistas) en la LAN (puerto 8765 definido como `const PORT` en `desktop/src-tauri/src/main.rs:14`).
- `desktop/src-tauri/tests/`: Pruebas de integración de Rust (`lan_protocol.rs`, `verify_manual_flow.rs`, `import_flow.rs`, `benchmark_import.rs`).
- `test/`: Pruebas unitarias en Node/TypeScript (`titleCleaning.test.ts`, `trackFingerprint.test.ts`, `nativeCacheGeneration.test.ts`, `meterBallistics.test.ts`, `setlistPlan.test.ts`).

---

## 3. Cosas que NO se pueden romper
1. **Callback de audio en tiempo real**: Prohibido hacer logging (`println!`, `tracing`), alocaciones dinámicas (`vec![]`, `clone()`) o bloqueos `lock().unwrap()` en el hilo de audio. Implementado en la función `ensure_stream` de `desktop/src-tauri/src/audio/playback/mod.rs` con buffers preasignados.
2. **Micro-fundidos de 8 ms**: Constante `FADE_MS = 8.0` en `desktop/src-tauri/src/audio/playback/fade.rs`. Se aplican única y exclusivamente al iniciar, pausar, detener, hacer seek, saltar de sección o alternar bucle vamp para evitar clics. El audio continuo recibe ganancia 1.0 exacta.
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
- **Caché PCM al sample rate del dispositivo**: Al decodificar pistas con `import.rs`, el audio se remuestrea a la frecuencia nativa del hardware (`target_sample_rate`) para garantizar cero remuestreo pesado durante la reproducción.
- **Biblioteca como índice ligero**: `library.json` contiene únicamente metadatos. Las carpetas de caché PCM (`pcm/<id>/`) solo existen para canciones que forman parte del setlist o están activas en consola.
- **Licencia LibreTracks (AGPL)**: Prohibido copiar o portar su código; las ideas generales sí se pueden usar.

---

## 5. Reglas de trabajo
- **Rama principal**: `main` contiene el motor nativo de escritorio desde la versión 0.3.0 (migración del 2026-11-12). La rama `motor-nativo` quedó congelada como referencia y ya no se desarrolla. Las ramas nuevas salen de `main`.
- **Versión web anterior**: conservada en la etiqueta `main-web-final`. Es el punto de retorno si hiciera falta.
- Trabajar siempre en rama aparte creada a partir de la rama indicada. Nunca realizar commits ni merges directos a `main`, salvo que el dueño lo pida de forma expresa (como en la migración a 0.3.0).
- No lanzar `verify.ps1 -Completo` por iniciativa propia: tarda cerca de una hora. Por commit basta el verify rápido; el completo lo pide el dueño.
- Un cambio lógico por commit, con mensaje descriptivo y preciso.
- Nunca tragar errores: terminantemente prohibido `.catch(() => {})` o silenciar excepciones sin log o notificación visual al usuario.
- En reportes de verificación, marcar explícitamente como «No medido» toda prueba o métrica no ejecutada.
- Actualizar este archivo (`CLAUDE.md`) y `docs/ARQUITECTURA.md` inmediatamente si se mueven, renombran o agregan módulos.

---

## 6. Pendientes conocidos
- **Decodificación de caché**: Se realiza en paralelo (3-4 hilos, `desktop/src-tauri/src/audio/mod.rs`). Medido en el `.exe` el 2026-11-12: 7 pistas de 4:20 en ~4,1 s y 10 pistas de 8:00 en ~10,7 s. El límite es el procesador. Más hilos o trabajar a 44,1 kHz serían decisiones del dueño, aún sin tomar.
- **Medidores sin medir en el callback**: Los medidores de nivel (`PeakMeter`) añaden operaciones al callback de audio. No se midieron underruns ni tiempo de callback antes y después; el dueño ensayó y no notó problemas.
- **Verificación completa sin cerrar**: `verify.ps1 -Completo` no se completó sobre `main` tras la migración (faltaron `verify_manual_flow` y `build:portable`). Las pruebas rápidas sí pasaron.
- **Importación HTML/arrastre vs nativa**: La importación por selector HTML o arrastre de archivos sigue decodificando al importar (`src/hooks/useImportFlow.ts:250, 440`); solo la ruta nativa de carpeta importa sin decodificar.
- **Saltos cuantizados tardíos**: Si el compás objetivo ya cayó dentro de los ~500 ms prellenados en el ring buffer `rtrb`, el salto se pospone al siguiente compás.
- **Fase 5 diferida**: Ruteo libre multicanal a más de 2 salidas físicas independientes de la tarjeta.
- **Fase 7 diferida**: Soporte de drivers de audio ASIO (diferido, sin decidir: depende de la licencia del SDK de Steinberg y de la decisión del dueño).
- **Retiro del motor web**: Desacoplar definitivamente `audioEngine.ts` de la aplicación de escritorio.
- **`MARKER_PALETTE` duplicada**: Definida de forma duplicada en `src/App.tsx` y `src/hooks/useImportFlow.ts`.
- **`handleRelinkProject` en `App.tsx`**: Retenido en el componente raíz para evitar referencias circulares / hoisting temporal (`TS2448`).
- **Riesgo de contención en `try_lock`**: En callbacks bajo alta carga, si `try_lock()` sobre los consumidores falla, se emite silencio en ese bloque.
