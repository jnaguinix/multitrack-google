# Guía para auditar OmniTracks

Este documento es para quien audite el código (persona o asistente). Léelo junto con `CLAUDE.md` (reglas y mapa de módulos) y `docs/ARQUITECTURA.md` (flujos). Si algo aquí contradice el código, manda el código: dilo en el informe.

## 1. Qué es y por qué importa
OmniTracks es un reproductor de multitracks para cultos y música en vivo. **Un fallo en directo es peor que una función que falte**: un chasquido, un corte, un salto a la sección equivocada o un cuelgue durante el servicio. Prioriza lo que puede provocar eso.

Pila: escritorio Windows con Tauri v2; motor de audio en Rust (CPAL/WASAPI, Symphonia, rubato, rtrb); interfaz en React 19, TypeScript, Tailwind 4 y Vite. `main` es la rama del motor nativo (versión 0.3.0). El motor Web Audio y la capa OPFS se retiraron (siguen en la etiqueta `main-web-final`): el audio solo suena en la app de escritorio. `npm run dev` abre una vista previa con un motor simulado (`src/preview/*`) que no suena y no entra en producción.

## 2. Orden de la auditoría (de más a menos crítico)
1. **Callback de audio en tiempo real**: `desktop/src-tauri/src/audio/playback/mod.rs` (función `ensure_stream`), `bus.rs`, `fade.rs`, `types.rs`.
2. **Transporte, saltos de sección y buffers**: `playback/transport.rs`, `playback/jumps.rs`, `playback/clock.rs`, `playback/block.rs`, `playback/feeder_io.rs`, `playback/mod.rs`.
3. **Importación y caché PCM**: `audio/import.rs`, `audio/cache.rs`, `audio/resampler.rs`, `audio/mod.rs` (comandos `audio_*`).
4. **Biblioteca y persistencia**: `desktop/src-tauri/src/library/mod.rs` (`library.json`, escritura atómica, sidecars).
5. **Servidor LAN y protocolo**: `desktop/src-tauri/src/lan.rs`, `protocol.rs`, `main.rs`; puente de la UI en `desktop/frontend/RemoteConnectionBridge.tsx` y `remoteState.ts`. Es una superficie de red: busca falta de autenticación, validación de entradas y exposición fuera de la red local.
6. **Puente TypeScript con el motor**: `src/audio/nativeAudioEngine.ts`, `src/audio/meterBallistics.ts`.
7. **Estado de la aplicación**: `src/App.tsx` y `src/hooks/*` (importación, setlist, biblioteca, acciones de mezcla).
8. **Interfaz**: `src/components/*`. Aquí solo interesan fallos de lógica, estado incoherente y accesibilidad básica, no el estilo.

## 3. Reglas que no se pueden romper (verifica que se cumplen)
- **Callback de audio**: sin `println!`/`tracing`, sin alocaciones (`vec![]`, `clone()` de buffers), sin `lock().unwrap()` bloqueante ni E/S. Solo operaciones preasignadas y atómicas.
- **Micro-fundidos de 8 ms** (`FADE_MS` en `fade.rs`) solo al iniciar, pausar, detener, hacer seek, saltar de sección, alternar vamp o llegar al final natural de la canción (`end_of_song_gain` en `playback/block.rs`). El audio continuo lleva ganancia 1.0 exacta.
- **Volumen y paneo con rampa** (`smooth_toward` / `smoothing_alpha` en `playback/block.rs`, estado en `BlockMixer`): el volumen y el paneo de cada pista y los tres volúmenes maestros no saltan de un bloque al siguiente; en reposo la ganancia es exactamente la pedida. Mute y solo siguen cortando de golpe (pendiente conocido).
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
- Saltos cuantizados: si el compás destino cae dentro del audio ya encolado en el buffer, el salto se pospone al siguiente compás. El ring buffer tiene 500 ms de capacidad, el feeder apunta a ~350 ms y la salida de buffering exige 150 ms por pista.
- Riesgo de contención: si `try_lock()` falla en el callback, se emite silencio en ese bloque.
- Fase 5 (ruteo a más de 2 salidas) y Fase 7 (ASIO) están diferidas a propósito.
- La importación por selector HTML o arrastre sigue decodificando al importar; solo la ruta nativa de carpeta no decodifica.
- Hay un chasquido que el dueño oye a veces al pasar de canción con «Dejar lista la siguiente» tras una canción que acaba alta. El fundido de 8 ms al final de canción no lo resolvió; la causa sigue sin identificar (puede depender de una secuencia concreta). No medido con hardware real.
- `verify_manual_flow` no se ha ejecutado desde la Fase 2 y no se ha oído audio real en una sesión completa tras las últimas fases.
- `src/App.tsx` (~710 líneas) ya está repartido en hooks y componentes (`src/hooks/*`, `src/components/app/*`); `sourceFiles.ts` y los handles de `projectDb.ts` quedan por la importación por selector HTML.
- El estado de transporte re-renderiza la interfaz unas 40 veces por segundo al reproducir (UI01, solo medido en modo desarrollo).
- Las ramas antiguas están como etiquetas `archivo/*`: ignóralas.
- **Cambios recientes (noviembre de 2026), que pueden tener fallos propios**: volumen y paneo con rampa en el callback (arriba); el guardado diferido (`src/storage/saveScheduler.ts`) lanzaba «Illegal invocation» y tumbaba el servidor LAN al mover un volumen desde el celular (corregido); el control remoto se empareja solo por enlace (ya no hay QR) y sus páginas para el celular (`desktop/web/remote.*`) se rediseñaron; el DAW siempre tiene una canción montada (`useAlwaysMountedSong`, `src/utils/songToMount.ts`); la ventana se abre maximizada; los diálogos usan el componente común `Dialog`.
- Del servidor LAN se sabe que: el puente de la interfaz apaga el servidor ante cualquier error en un intercambio; el contador de comandos rechazados por conexión no se reinicia tras un comando válido; la página del celular muestra «Sesión cerrada por el portátil» para cualquier cierre con código 4403 o 1008; la pantalla del celular se apaga durante el servicio (evitarlo exigiría HTTPS, decisión pendiente). Compruébalo y di qué gravedad tiene de verdad.
- Estado de la comprobación: `npm test` pasa; `cargo test --lib` se corrió completo (4 pruebas viejas fallaron por la rampa, se ajustaron y pasan por separado; no se repitió la corrida completa); no se ha oído audio real tras la rampa de volumen ni probado el enlace del control remoto en un Pixel.

## 5. Qué ignorar
`node_modules/`, `dist/`, `desktop/dist/`, `desktop/src-tauri/target/`, `package-lock.json`, `Manual.md` e `instrucciones.md` (obsoletos: describen el motor web y la guía hablada, ya retirados; manda el código y `CLAUDE.md`), `AGENTS.md` (copia de `CLAUDE.md`), y el estilo visual (colores, espaciado, tipografía). Tampoco propongas migrar de framework ni reescrituras amplias.

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
