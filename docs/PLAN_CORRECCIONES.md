# Plan de correcciones (derivado de las tres auditorías externas)

Documento de trabajo que sigue el asistente. Fuentes: informe de Antigravity, informe de ChatGPT (primero y segundo, commit `dfa2138`) y lo ya conocido en `docs/AUDITORIA.md`. Los códigos «H» son los del informe de ChatGPT (segundo), salvo indicación «AG» (Antigravity).

Criterio de orden: un fallo en directo pesa más que una función que falta. Primero lo que puede cambiar lo que suena o dejar la app muda, después lo que pierde datos, después el control remoto, y al final la pulida.

## Cómo se trabaja cada ola (reglas fijas)
1. Rama nueva desde `main` (`fix/<ola>-<tema>`). Nunca commits directos a `main`.
2. **Prueba primero**: cada arreglo lleva una prueba que **falla sin el arreglo** (se comprueba quitándolo) y pasa con él. Si el fallo no se puede reproducir sin hardware, se dice y se marca «No medido».
3. Un cambio lógico por commit. Mensaje preciso, con la línea `Co-Authored-By`.
4. Verificación por commit: `npm run lint`, `npm test`, `npm run build` y, si se toca Rust, `cargo test --lib` (ver la nota de memoria «cargo fuera del PATH»: toolchain en la carpeta de Codex). Nunca `verify.ps1 -Completo` por iniciativa propia.
5. Cada hallazgo corregido añade un caso al **ensayo** (script de autorrevisión, ver «Transversal») para que no vuelva.
6. Al cerrar la ola: informe breve con lo hecho, lo **No medido** y lo que el dueño debe probar en el `.exe`. Se pide permiso para fusionar y subir; no se fusiona ni sube por cuenta propia.
7. El `.exe` lo compila el dueño (una sola orden, visible; ver la nota de memoria). Después de cada ola con cambios de audio se le deja una lista corta de qué escuchar.
8. Si aparece un hallazgo nuevo (modo diagnóstico, ensayo, otro auditor), se añade aquí en la ola que corresponda antes de seguir.

## Hecho (en `main`)
- [x] «Sesión cerrada» al mover un volumen desde el celular (`saveScheduler`, Illegal invocation).
- [x] Rampa de volumen y paneo (clics al mover faders).
- [x] Aviso de `__dirname` de Vite.
- [x] Modo diagnóstico (registro por categorías, alarmas, exportar) — `src/utils/debugMode.ts`.
- [x] El sondeo ya no retiene el mutex del metrónomo (click perdido).
- [x] Lockfile en la raíz y esbuild `^0.27`.
- [x] Espacio ya no secuestra botones, ni repite, ni actúa con diálogos abiertos (H22).
- [x] H01 la última activación manda · H04 (parte TS) Play espera la cola de controles · H15 «siguiente lista» con el estado real del motor.

## Ola 2 — Motor: lo que puede cambiar lo que suena o dejarlo mudo (Rust, `cargo test --lib`)
- [x] **2.1 Montaje con la mezcla completa (H04, parte Rust).** `audio_load_project` recibe bus, mute, ganancia, paneo y división de cada pista; ninguna pista nace a ganancia 1 con bus provisional. Prueba: cargar con Click en `stem-04` y una pista en mute; el primer bloque ya sale bien. HECHO en `fix/ola2-montaje` (`load_project_with_controls`, `InitialTrackControl`; pruebas `test_h04_*` en Rust y en `engineActivation.test.ts`). No medido en el `.exe`; las pruebas de integración de `desktop/src-tauri/tests` no se ejecutaron (no se tocó la firma de `load_project`).
- [x] **2.2 Feeder que falla al abrir su PCM (H07).** Validar y abrir los PCM antes de confirmar la carga; estado de fallo por pista; límite de espera en el buffering inicial con error visible. Prueba: PCM ilegible → error, no silencio eterno. HECHO en `fix/ola2-montaje`: `load_project` abre y mide cada PCM antes de montar (error con el nombre de la pista), `buffering_ready` no espera a una pista cuyo feeder murió, el estado expone `feederAlive` y `bufferingMs` y la interfaz avisa una vez (pista sin lectura, buffering > 5 s). No medido: un fallo de lectura real en el `.exe` (el disco desaparece a mitad de canción).
- [ ] **2.3 Seeks concurrentes (H03).** Serializar la operación completa; el seek viejo no puede bajar la generación. Prueba: dos seeks superpuestos (y un cambio de tono mientras se arrastra).
- [ ] **2.4 Fundido de salida confirmado por el callback (H08, AG H06).** Pause, Stop, Seek y cambio de canción esperan a que el callback consuma los 8 ms de rampa (con tope por si no hay callbacks), no un `sleep`.
- [ ] **2.5 Vamp (H06, AG H05).** No activar sin rango válido; salir del vamp en un límite acordado con los feeders. Prueba: V justo antes del límite y V en un hueco entre secciones.
- [ ] **2.6 Cambiar el dispositivo de audio (H11, AG H25).** `audio_set_config` reabre el stream estando en pausa y la UI muestra el dispositivo realmente abierto; no sustituir en silencio un dispositivo desconectado (AG H38).
- [x] **2.6b Frecuencia absurda del dispositivo (visto en el `.exe` el 2026-11-20).** Una caché se generó a 8 000 Hz (`pcm/song-1794971896515/8000`) y la música sonó en cámara lenta. (a) `audio_import_tracks` y `audio_generate_cache` rechazan o corrigen frecuencias < 44 100 Hz (usar 48 000). (b) `ensure_stream` no puede devolver `Ok` con un stream abierto a otra frecuencia que la caché cargada: comparar y reabrir (o fallar con aviso). (c) Alarma de diagnóstico si la salida y la caché difieren. Prueba: stream abierto a 8 000 Hz + caché a 48 000 → se reabre o falla, nunca suena a otra velocidad. HECHO en `fix/ola2-frecuencia` (`effective_cache_rate`, `stream_needs_reopen`, aviso en Ajustes de audio); falta la alarma (c) en el diagnóstico y no está medido con el dispositivo real a 8 000 Hz.
- [ ] **2.7 Mute/solo con rampa y huecos de la rampa (H16, AG H02/H03).** Mute y solo con rampa corta; la ganancia suavizada se actualiza también en pistas silenciadas (al quitar el mute no hay barrido de ~30 ms); `cue_gain` suavizado; pistas más allá de la 64.
- [ ] **2.8 Pista que termina antes que la canción (AG H07, chasquido candidata 1).** Micro-fundido propio al acabar el PCM de cada pista.
- [ ] **2.9 Ganancia NaN/infinita (AG H04).** Sanear en `set_track_controls` y en el callback.
- [ ] **2.10 Contención del callback (pendiente conocido).** Contar por causa los bloques omitidos por `try_lock` (pistas, envolvente, metrónomo) y mostrarlos en el diagnóstico.
- [ ] **2.11 Caché que coincide con el proyecto (H02).** Manifiesto de pistas y tamaños; cargar solo lo del manifiesto; validar tamaño del PCM; regeneración parcial = fallo, no «lista»; implementar `removeTrack` (hoy vacío). Parte TS + Rust.

Salida de la ola 2: `cargo test --lib` completo, informe de lo no medido, lista de escucha para el dueño (cambiar de canción en automático y a mano, mover faders, mute/solo, vamp, cambio de tono, cambiar de interfaz).

## Ola 3 — Control remoto (Rust `lan.rs` + `RemoteConnectionBridge.tsx` + `desktop/web/remote.*`)
- [ ] **3.1 El puente ya no apaga el servidor ante un solo error (H13).** Reintento con espera creciente, estado degradado visible, cierre solo ante error terminal o a petición.
- [ ] **3.2 Contador de rechazos (H20).** Decae o se reinicia con actividad válida; el cliente distingue 1008 de 4403 y reconecta si la cookie sigue vigente.
- [ ] **3.3 Confirmación `applied` tras el acuse del motor (H19).**
- [ ] **3.4 Expulsar revoca también el enlace (H18)** y límite de emparejamiento por origen.
- [ ] **3.5 Pánico por UTF-8 en `library/mod.rs` (AG H16)** y comandos remotos con texto no ASCII.
- [ ] **3.6 HTTP (H12): decisión del dueño pendiente** (HTTPS con CA propia; además habilita Wake Lock). No se implementa sin su decisión.

## Ola 4 — Datos y persistencia
- [ ] **4.1 Setlist por comandos de Rust (H05).** Quitar, vaciar y reordenar cambian solo pertenencia y orden dentro de una operación atómica, no reescriben una copia completa.
- [ ] **4.2 Reemplazo seguro de `library.json` y sidecar (H10).** Sin escritura directa de respaldo; temporales únicos; el fallo del sidecar llega a la UI.
- [ ] **4.3 Guardado diferido frente a borrado y cierre (H21).** Cancelar pendientes por ID al borrar; confirmar el `flush` al cerrar.
- [ ] **4.4 Un error de lectura de la biblioteca no es «biblioteca vacía» (H14, AG H19).** Aviso persistente con reintento.
- [ ] **4.5 Reimportar sin cruzar controles (H09).** Emparejar por archivo/ruta antes que por nombre; conservar `monitor`, `cueGain`, `cueMuted`; IDs únicos.
- [ ] **4.6 Importar fuera del setlist no detiene el audio (AG H12)** (`prepareProjectShell` / `useNativeImport`).
- [ ] **4.7 Sidecar por nombre de archivo vs nombre de carpeta (AG H15).**

## Ola 5 — Robustez de uso
- [ ] **5.1 `ErrorBoundary` en la raíz (AG H36)** con «copiar diagnóstico».
- [ ] **5.2 Sin selector de carpeta automático al arrancar (AG H37).**
- [ ] **5.3 Aviso de dispositivo desconectado persistente hasta que reabrir tenga éxito (H17).**
- [ ] **5.4 `DesktopAudioSettings` con `Dialog` común (AG H38).**
- [ ] **5.5 Correcciones de documentación** (nombre `save_library_internal` en lugar de `atomic_write_file`, lista de `catch`, BOM de `desktop/build-frontend.ps1`, cuantización tardía = compás siguiente al siguiente, importación que decodifica si ya está en el setlist, precarga sin expulsión de RAM, empalmes sin `begin_new_segment`).

## Transversal — ensayo (script de autorrevisión)
Se construye por partes, empezando después de la ola 2 para que cubra lo ya corregido:
1. **Reglas estáticas** en `verify.ps1`: `.catch(() => …)` mudos, BOM, `catch` sin aviso, modales sin `Dialog`, comandos sin registro triple.
2. **Recorrido del motor sin hardware** (prueba de integración de Rust con audio sintético): cargar, Play, faders, mute/solo, salto de sección, cambio de canción, vamp, parar. Sin rutas del equipo del dueño (hoy `verify_manual_flow` las tiene fijas).
3. **Reglas sobre el audio renderizado**: sin escalones entre muestras, sin NaN, sin recorte inesperado, pistas alineadas, cero asignaciones.
Cada hallazgo corregido de este documento añade su caso.

## Cuando llegue otra auditoría
Cruzar con este plan: lo nuevo entra en su ola; lo repetido sube de prioridad; lo que el modo diagnóstico confirme en el `.exe` real manda sobre cualquier informe.

## Pendientes que dependen del dueño
- Probar en el `.exe`: rampa de volumen, enlace del control remoto en el Pixel, ventana maximizada, `Dialog`, cabecera del Setlist, DAW siempre montado, modo diagnóstico (Ctrl+Mayús+D) y si «Guardar archivo» abre el guardado de Windows.
- Decisiones: HTTPS con CA propia, ASIO, compensación de sonoridad, portar a macOS.
