# Guía para auditar OmniTracks

Este documento es para quien audite el código (persona o asistente). Léelo junto con `CLAUDE.md` (reglas y mapa de módulos), `docs/ARQUITECTURA.md` (flujos) y `docs/PLAN_CORRECCIONES.md` (qué se corrigió y cómo se comprobó). Si algo aquí contradice el código, manda el código: dilo en el informe.

Última actualización: 2026-11-23, sobre `main` tras las olas 2 a 6 del plan de correcciones y una limpieza de código sin uso. Cómo correr las pruebas, el servidor local y compilar el `.exe`: `docs/GUIA_RETOMAR.md`.

## 1. Qué es y por qué importa
OmniTracks es un reproductor de multitracks para cultos y música en vivo. **Un fallo en directo es peor que una función que falte**: un chasquido, un corte, un salto a la sección equivocada o un cuelgue durante el servicio. Prioriza lo que puede provocar eso.

Pila: escritorio Windows con Tauri v2; motor de audio en Rust (CPAL/WASAPI, Symphonia, rubato, rtrb, Signalsmith Stretch para el cambio de tono, ebur128 para la sonoridad); interfaz en React 19, TypeScript, Tailwind 4 y Vite. `main` es la rama del motor nativo (versión 0.3.0). El motor Web Audio y la capa OPFS se retiraron (siguen en la etiqueta `main-web-final`): el audio solo suena en la app de escritorio. `npm run dev` abre una vista previa con un motor simulado (`src/preview/*`) que no suena y no entra en producción.

## 2. Orden de la auditoría (de más a menos crítico)
1. **Callback de audio en tiempo real**: `desktop/src-tauri/src/audio/playback/callback.rs` (`BlockMixer::process`), `block.rs`, `fade.rs`, `bus.rs`, `types.rs`; el stream se abre en `playback/mod.rs` (`ensure_stream` / `open_stream`).
2. **Transporte, saltos de sección y buffers**: `playback/transport.rs`, `playback/jumps.rs`, `playback/clock.rs`, `playback/feeder_io.rs`, `playback/mod.rs` (hilos feeder).
3. **Importación y caché PCM**: `audio/import.rs`, `audio/cache.rs`, `audio/resampler.rs`, `audio/pitch.rs`, `audio/track_ids.rs`, `audio/mod.rs` (comandos `audio_*`).
4. **Biblioteca y persistencia**: `desktop/src-tauri/src/library/mod.rs` (`library.json`, `replace_file_atomic`, sidecars, setlist), `src/storage/*` (`saveScheduler.ts`, `projectSaves.ts`, `desktopLibrary.ts`, `libraryLoader.ts`, `projectDb.ts`), `desktop/src-tauri/src/close_gate.rs` y `src/utils/closeFlush.ts` (cierre de la ventana).
5. **Servidor LAN y protocolo**: `desktop/src-tauri/src/lan.rs`, `protocol.rs`, `main.rs`; puente de la UI en `desktop/frontend/RemoteConnectionBridge.tsx`, `bridgeLoop.ts`, `remoteState.ts`; cliente del teléfono en `desktop/web/remote.*`. Es una superficie de red: busca falta de autenticación, validación de entradas y exposición fuera de la red local.
6. **Puente TypeScript con el motor**: `src/audio/nativeAudioEngine.ts`, `controlQueue.ts`, `controlSync.ts`, `statePoller.ts`, `nativeCacheManager.ts`, `meterBallistics.ts`.
7. **Estado de la aplicación**: `src/App.tsx` y `src/hooks/*` (importación, setlist, biblioteca, activación de canciones, acciones de mezcla).
8. **Interfaz**: `src/components/*`. Aquí solo interesan fallos de lógica, estado incoherente y accesibilidad básica, no el estilo.

## 3. Reglas que no se pueden romper (verifica que se cumplen)
- **Callback de audio**: sin `println!`/`tracing`, sin alocaciones (`vec![]`, `clone()` de buffers), sin `lock().unwrap()` bloqueante ni E/S. Solo operaciones preasignadas y atómicas. Lo vigilan `verify:rules` (solo `BlockMixer::process`) y la prueba de cero asignaciones.
- **Micro-fundidos de 8 ms** (`FADE_MS` en `fade.rs`) solo al iniciar, pausar, detener, hacer seek, saltar de sección, alternar vamp o llegar al final natural de la canción (`end_of_song_gain` en `playback/block.rs`). El audio continuo lleva ganancia 1.0 exacta.
- **Volumen, paneo, mute y solo con rampa** (`smooth_toward` / `smoothing_alpha` en `playback/block.rs`, estado en `BlockMixer`): no saltan de un bloque al siguiente; en reposo la ganancia es exactamente la pedida.
- **Ganancias siempre finitas** (`sanitize_gain`): NaN o infinito se ignoran.
- **Comandos de Tauri declarados en tres sitios**: `tauri::generate_handler![...]` en `main.rs`, `.commands(&[...])` en `desktop/src-tauri/build.rs` y `"permissions"` en `desktop/src-tauri/capabilities/desktop-remote.json`. Lo comprueba `npm run verify:ipc`; verifícalo tú también.
- **Controles de la mezcla nunca con `invoke` suelto**: pasan por `ControlQueue` (lo vigila `verify:rules`).
- **`"dragDropEnabled": false`** en `desktop/src-tauri/tauri.conf.json`.
- **Sidecar** llamado exactamente `omnitracks.project.json` (el nombre antiguo `.omnitracks.json` solo se lee como respaldo).
- **Escrituras atómicas de la biblioteca**: archivo temporal único y `replace_file_atomic`; nunca escritura directa sobre `library.json`, su `.backup.json` ni el sidecar.
- **Orden de los mutex de proyecto**: `loaded_project_id` y después `tracks`; `seek_lock` antes de pedir `seek`/`stop`.
- **UTF-8 sin BOM** en todos los archivos.
- **Nunca tragar errores**: prohibido `.catch(() => {})` o silenciar excepciones sin registro ni aviso (un `catch` que de verdad no avisa lo declara con `// catch-ok: motivo`).
- **Ventanas y menús**: solo con `Dialog` y `PopoverMenu` (`src/components/ui`).
- **Licencia**: está prohibido copiar código de LibreTracks (AGPL).

## 4. Corregido desde las auditorías anteriores (revalídalo: ¿el arreglo es correcto y completo?)
Cada punto tiene su prueba, que falla sin el arreglo (comprobado quitándolo); su detalle está en `docs/PLAN_CORRECCIONES.md`. Que una prueba pase no prueba que el arreglo sea suficiente: busca casos que la prueba no cubre.

- **Motor (ola 2)**: montaje con la mezcla completa y validación de los PCM al cargar (2.1, 2.2, 2.11); seeks concurrentes serializados con `seek_lock` (2.3); fundido de salida confirmado por el callback (2.4); vamp sin rango válido y salida en el límite (2.5); cambio de dispositivo con el audio detenido y sin sustituir en silencio uno desconectado (2.6); frecuencias absurdas del dispositivo (2.6b); mute y solo con rampa (2.7); fundido propio al acabar el PCM de una pista corta (2.8); ganancias NaN o infinitas (2.9); contadores de contención de `try_lock` (2.10).
- **Control remoto (ola 3)**: el puente ya no apaga el servidor ante un error pasajero (3.1); el contador de rechazos decae y el cliente distingue 1008 de 4403 (3.2); la confirmación `applied` espera el acuse del motor (3.3); expulsar un dispositivo renueva el enlace del rol y hay límite de emparejamientos por origen (3.4); pánico por UTF-8 al limpiar títulos (3.5).
- **Datos (ola 4)**: setlist por comandos de Rust (4.1); reemplazo seguro de `library.json` y sidecar, con el fallo del sidecar visible (4.2); guardado diferido frente a borrado y cierre de la ventana (4.3); un error de lectura de la biblioteca ya no es «biblioteca vacía» (4.4); reimportar sin cruzar los controles de las pistas (4.5); importar a la biblioteca no detiene el audio que suena (4.6); IDs del sidecar emparejados por nombre de archivo (4.7).
- **Robustez de uso (ola 5)**: `ErrorBoundary` en la raíz (5.1); `generateNativeCacheForProject` no abre el selector de carpetas por su cuenta (5.2); el aviso de dispositivo desconectado dura hasta que reabrir tenga éxito (5.3); Ajustes de audio con el `Dialog` común (5.4).
- **Robustez de uso (ola 6, triaje de la segunda auditoría de Antigravity)**: entrar en vamp cerca del final de la sección reposiciona en el sitio y se rechaza en secciones de menos de 0,5 s (6.1); un PCM truncado se regenera (6.2); montar en consola conserva el setlist (6.3); regenerar la caché con otra carpeta empareja por archivo y nombre, sin cruzar pistas (6.4); borrar la caché descarga antes y avisa si falla (6.5, 6.10); `stop` desactiva el vamp (6.6); los guardados directos pasan por `projectSaves` (6.7); «Audio» conserva un dispositivo desconectado (6.8); el cliente remoto reconecta al volver la pantalla o la red (6.9); los faders de Click y Guía gobiernan todas las pistas de ese tipo (6.11); una carga que falla no toca la canción montada y cambiar de canción espera el `audio_stop` (6.12). Nada medido en el `.exe`.
- **Otros**: la onda de una canción recién importada deja de salir plana; la última activación de canción manda y Play espera la mezcla (H01, H04); el modo diagnóstico (`src/utils/debugMode.ts`) registra comandos, alarmas y errores.

## 5. Lo ya conocido y abierto (no lo reportes como hallazgo nuevo; sí puedes dar su gravedad real)
- Los medidores de nivel (`PeakMeter`) añaden operaciones atómicas al callback de audio y **no se midieron** underruns ni tiempo de callback antes y después.
- `verify.ps1 -Completo` no se ha completado sobre `main` tras la migración (faltan `verify_manual_flow` y `build:portable`); `verify_manual_flow` no se ejecuta desde la Fase 2.
- Saltos cuantizados: si el compás destino cae dentro de los 0,6 s de margen sobre la posición actual (`min_safe_ahead`, `playback/jumps.rs`), el salto se pospone al primer límite de compás que cumpla el margen (en «1-bar», nunca antes del compás siguiente al siguiente). El ring buffer tiene 500 ms de capacidad, el feeder apunta a ~350 ms y la salida de buffering exige 150 ms por pista. El diseño original (`docs/MOTOR_NATIVO_DISENO.md`, «Caso B») proponía descartar el audio encolado: no se implementó.
- Riesgo de contención: si `try_lock()` falla en el callback, se emite silencio en ese bloque (ya se cuenta por causa).
- Fase 5 (ruteo a más de 2 salidas con hardware) y Fase 7 (ASIO) están diferidas a propósito; el ruteo por dispositivo existe (`routing.rs`) pero no se midió con más de 2 canales.
- La importación por selector HTML o arrastre sigue decodificando al importar; la ruta nativa de carpeta solo decodifica si la canción ya está en el setlist.
- Hay un chasquido que el dueño oye a veces al pasar de canción con «Dejar lista la siguiente» tras una canción que acaba alta. El fundido de 8 ms al final de canción no lo resolvió; la causa sigue sin identificar. No medido con hardware real.
- El control remoto va por HTTP sin cifrar y la pantalla del celular se apaga durante el servicio (evitarlo exigiría HTTPS con una CA propia: decisión pendiente del dueño, punto 3.6 del plan). Di qué gravedad tiene de verdad en una red de iglesia.
- El estado de transporte re-renderiza la interfaz unas 40 veces por segundo al reproducir (solo medido en modo desarrollo).
- `src/App.tsx` (~790 líneas) ya está repartido en hooks y componentes; `sourceFiles.ts` y los handles de `projectDb.ts` quedan por la importación por selector HTML.
- Los textos originales de algunos hallazgos (AG H15, H37) no están en el repositorio: se interpretaron por lo que hace el código; si tu informe los define distinto, dilo.
- **Nada de lo corregido en las olas 4 y 5 se ha medido en el `.exe`** (cierre con guardado pendiente, reimportar de verdad, arranque con archivos ausentes, desconectar y reabrir el dispositivo, `Dialog` de Ajustes de audio). Tampoco se ha oído audio real tras la rampa de volumen ni probado el enlace del control remoto en un Pixel.
- `test_h06_*` (vamp, `playback/tests.rs`) depende de tiempos: ejecutada aislada falla a veces, también en `main` sin cambios; en la suite completa pasa.
- Las ramas antiguas están como etiquetas `archivo/*`: ignóralas.

## 6. Código sin llamadas que se conserva a propósito (no lo reportes como «código muerto»)
`npm run verify:ipc` avisa de comandos de Rust que ninguna interfaz llama de forma literal. Son estos:
- `audio_cancel_import`: cancelar una importación en curso. No tiene botón en la interfaz; la maquinaria de cancelación (`AudioEngineState::cancel_import`) sí la usa la importación.
- `audio_set_master_gains`: se llama a través de `ControlQueue` (el nombre del comando va en `op.cmd`, que el análisis no ve).
- `audio_get_cache_stats` y `audio_clean_orphan_caches`: los usa la sección «Diagnóstico» de Ajustes de audio con `invoke` directo.
- `defaultBus` en `handleImportNative` (`useNativeImport.ts`): parámetro posicional sin efecto desde que el bus sale del instrumento; se conserva por la firma compartida con la importación HTML.

## 7. Limpieza del 2026-11-23: lo que ya no existe (no lo busques ni lo reportes como faltante)
- **Comandos IPC**: `library_save` (sobrescribía toda la biblioteca desde la interfaz; hoy se guarda por canción con `library_save_song` y el setlist con `library_setlist_*`), `library_write_sidecar` (escribía un sidecar en una carpeta arbitraria) y `library_read_sidecar`. Ninguna interfaz los llamaba.
- **Rust**: `SwitchSongResult`, `WAVEFORM_PEAKS_COUNT`, `FadeEnvelope::is_fading_out`, `TrackResampler::nbr_channels` (y su campo), `PitchShifter::set_semitones` y `begin_new_segment` (los empalmes entran al remuestreador como una señal continua, sin reiniciarlo) con su prueba.
- **TypeScript**: `saveDesktopLibrary`, `readDesktopSidecar`, `saveStemAudioToDb`, `deleteStemsFromDb`, `readProjectSidecarFromDirectory`, `getNativeCacheStats` y `cleanOrphanNativeCaches` (envoltorios duplicados), los métodos de compatibilidad `getEffectiveEngineModeForProject`, `clearProjectFallback` y `getTotalCachedMB`, la prop de paneo del click (`onChangeClickPan`) y varios imports y estados sin uso.
- **Raíz**: las dependencias `@google/genai`, `express`, `dotenv`, `motion`, `@types/express`, `autoprefixer` y `esbuild` (nada las importaba), `.aistudio/`, `public/assets/aistudio/` (540 KB que se incrustaban en el `.exe` sin usarse), `metadata.json`, `.env.example`, y los documentos `Manual.md` e `instrucciones.md` (describían el motor web y la rama `motor-nativo`, versión 0.2.2; siguen en la etiqueta `archivo/docs-manual-e-instrucciones-0.2`).
- Siguen existiendo, aunque sean históricos: `desktop/INFORME_POC.md` y `desktop/test/probe-runtime.js` (PoC que justificó la plataforma; la sonda de OPFS ya no aplica a la app).

## 8. Qué ignorar
`node_modules/`, `dist/`, `desktop/dist/`, `desktop/src-tauri/target/`, `desktop/src-tauri/gen/`, `package-lock.json`, `AGENTS.md` (copia de `CLAUDE.md`), y el estilo visual (colores, espaciado, tipografía). Tampoco propongas migrar de framework ni reescrituras amplias.

## 9. Cómo comprobar lo que afirmes
Si puedes ejecutar comandos, usa los rápidos (el verify completo tarda cerca de una hora: no lo lances):
- `npm run lint` (comprobación de tipos), `npm test` (encadena `verify:ipc`, `verify:rules` y 33 archivos de prueba de Node/TypeScript), `npm run build`.
- En `desktop/src-tauri`: `cargo test --lib -- --test-threads=4` (≈238 pruebas, 1 ignorada, ≈80 s; no lo ejecutes a la vez que `npm test`: compiten por la CPU y alguna prueba de tiempos falla). `cargo check --lib --bins --tests` debe dar 0 advertencias.
- El ensayo del motor sin hardware (`cargo test --lib ensayo`) recorre una sesión completa con audio sintético y vigila escalones, recortes, NaN, alineación de pistas y cero asignaciones en el callback.

No puedes probar audio real ni WASAPI sin el hardware: en ese caso di «No medido» en vez de suponer.

## 10. Formato del informe
Una entrada por hallazgo, ordenadas de mayor a menor gravedad:
- **Archivo y línea** (`ruta:línea`).
- **Gravedad**: Crítica (puede romper un directo o perder datos), Alta, Media o Baja.
- **Qué falla**, en una frase.
- **Escenario concreto** que lo provoca: entradas o estado y qué ocurre.
- **Cómo lo verificaste** (leí el código, ejecuté X) o «No verificado».
- **Arreglo sugerido**, breve.

Al final: lo que **no** pudiste revisar y por qué, y cualquier cosa de este documento que no coincida con el código. No inventes hallazgos para llenar el informe: si un área está bien, dilo en una línea.
