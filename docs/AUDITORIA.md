# Guía para auditar OmniTracks

Este documento es para quien audite el código (persona o asistente). Léelo junto con `CLAUDE.md` (reglas y mapa de módulos) y `docs/ARQUITECTURA.md` (flujos). Si algo aquí contradice el código, manda el código: dilo en el informe.

## 1. Qué es y por qué importa
OmniTracks es un reproductor de multitracks para cultos y música en vivo. **Un fallo en directo es peor que una función que falte**: un chasquido, un corte, un salto a la sección equivocada o un cuelgue durante el servicio. Prioriza lo que puede provocar eso.

Pila: escritorio Windows con Tauri v2; motor de audio en Rust (CPAL/WASAPI, Symphonia, rubato, rtrb); interfaz en React 19, TypeScript, Tailwind 4 y Vite. `main` es la rama del motor nativo (versión 0.3.0). La versión web ya no se mantiene.

## 2. Orden de la auditoría (de más a menos crítico)
1. **Callback de audio en tiempo real**: `desktop/src-tauri/src/audio/playback/mod.rs` (función `ensure_stream`), `bus.rs`, `fade.rs`, `guide.rs`, `types.rs`.
2. **Transporte, saltos de sección y buffers**: `playback/transport.rs`, `playback/jumps.rs`, `playback/feeder_io.rs`, `playback/mod.rs`.
3. **Importación y caché PCM**: `audio/import.rs`, `audio/cache.rs`, `audio/resampler.rs`, `audio/mod.rs` (comandos `audio_*`).
4. **Biblioteca y persistencia**: `desktop/src-tauri/src/library/mod.rs` (`library.json`, escritura atómica, sidecars).
5. **Servidor LAN y protocolo**: `desktop/src-tauri/src/lan.rs`, `protocol.rs`, `main.rs`; puente de la UI en `desktop/frontend/RemoteConnectionBridge.tsx` y `remoteState.ts`. Es una superficie de red: busca falta de autenticación, validación de entradas y exposición fuera de la red local.
6. **Puente TypeScript con el motor**: `src/audio/nativeAudioEngine.ts`, `src/audio/meterBallistics.ts`.
7. **Estado de la aplicación**: `src/App.tsx` y `src/hooks/*` (importación, setlist, biblioteca, acciones de mezcla).
8. **Interfaz**: `src/components/*`. Aquí solo interesan fallos de lógica, estado incoherente y accesibilidad básica, no el estilo.

## 3. Reglas que no se pueden romper (verifica que se cumplen)
- **Callback de audio**: sin `println!`/`tracing`, sin alocaciones (`vec![]`, `clone()` de buffers), sin `lock().unwrap()` bloqueante ni E/S. Solo operaciones preasignadas y atómicas.
- **Micro-fundidos de 8 ms** (`FADE_MS` en `fade.rs`) solo al iniciar, pausar, detener, hacer seek, saltar de sección o alternar vamp. El audio continuo lleva ganancia 1.0 exacta.
- **Comandos de Tauri declarados en tres sitios**: `tauri::generate_handler![...]` en `main.rs`, `.commands(&[...])` en `desktop/src-tauri/build.rs` y `"permissions"` en `desktop/src-tauri/capabilities/desktop-remote.json`. Comprueba que ninguno falta en ninguno de los tres.
- **`"dragDropEnabled": false`** en `desktop/src-tauri/tauri.conf.json`.
- **Sidecar** llamado exactamente `omnitracks.project.json` (el nombre antiguo `.omnitracks.json` solo se lee como respaldo).
- **Escrituras atómicas de `library.json`**: archivo temporal, renombrado y copia `.backup.json`.
- **UTF-8 sin BOM** en todos los archivos.
- **Nunca tragar errores**: prohibido `.catch(() => {})` o silenciar excepciones sin registro ni aviso al usuario.
- **Licencia**: está prohibido copiar código de LibreTracks (AGPL).

## 4. Lo ya conocido (no lo reportes como hallazgo nuevo; sí puedes dar su gravedad real)
- Los medidores de nivel (`PeakMeter`) añaden operaciones atómicas al callback de audio y **no se midieron** underruns ni tiempo de callback antes y después.
- `verify.ps1 -Completo` no se ha completado sobre `main` tras la migración (faltan `verify_manual_flow` y `build:portable`).
- Hay `.catch(() => {})` que incumplen la regla de arriba; la lista exacta está en `CLAUDE.md` §6.
- `handleCreateNewProject` y `handleImportJsonFile` (`useProjectActions.ts`) ya no tienen botón.
- `BroadcastChannel` en `App.tsx` (~640–720) es una herencia del antiguo «Control rápido»; no se sabe si algo lo usa.
- El motor web `src/audio/audioEngine.ts` (~2600 líneas) sigue en el repositorio porque el escritorio depende de partes de él.
- `MARKER_PALETTE` está duplicada en `App.tsx` y `useImportFlow.ts`.
- Saltos cuantizados: si el compás destino cae dentro del audio ya encolado en el buffer, el salto se pospone al siguiente compás. El ring buffer tiene 500 ms de capacidad, el feeder apunta a ~350 ms y la salida de buffering exige 150 ms por pista.
- Riesgo de contención: si `try_lock()` falla en el callback, se emite silencio en ese bloque.
- Fase 5 (ruteo a más de 2 salidas) y Fase 7 (ASIO) están diferidas a propósito.
- La importación por selector HTML o arrastre sigue decodificando al importar; solo la ruta nativa de carpeta no decodifica.
- Ramas `diag/medidores-reales` y `diag/tiempo-cache` sin fusionar: ignóralas.

## 5. Qué ignorar
`node_modules/`, `dist/`, `desktop/dist/`, `desktop/src-tauri/target/`, `package-lock.json`, `AGENTS.md` (copia de `CLAUDE.md`), y el estilo visual (colores, espaciado, tipografía). Tampoco propongas migrar de framework ni reescrituras amplias.

## 6. Cómo comprobar lo que afirmes
Si puedes ejecutar comandos, usa los rápidos (el verify completo tarda cerca de una hora: no lo lances):
- `npm run lint` (comprobación de tipos), `npm test` (pruebas unitarias de Node), `npm run build`.
- En `desktop/src-tauri`: `cargo test --lib`.

No puedes probar audio real ni WASAPI sin el hardware: en ese caso di «No medido» en vez de suponer.

## 7. Formato del informe
Una entrada por hallazgo, ordenadas de mayor a menor gravedad:
- **Archivo y línea** (`ruta:línea`).
- **Gravedad**: Crítica (puede romper un directo o perder datos), Alta, Media o Baja.
- **Qué falla**, en una frase.
- **Escenario concreto** que lo provoca: entradas o estado y qué ocurre.
- **Cómo lo verificaste** (leí el código, ejecuté X) o «No verificado».
- **Arreglo sugerido**, breve.

Al final: lo que **no** pudiste revisar y por qué, y cualquier cosa de este documento que no coincida con el código. No inventes hallazgos para llenar el informe: si un área está bien, dilo en una línea.
