# Prompt para la auditoría externa

Antes de usarlo: comprueba que `main` en GitHub está al día (sin ramas pendientes de fusionar), para que el auditor vea el código vigente. Dale acceso al repositorio completo (o un .zip sin `node_modules`, `dist` ni `desktop/src-tauri/target`).

---

Eres un auditor técnico senior de software de audio en tiempo real, Rust y React. Vas a auditar **OmniTracks**, un reproductor de multitracks para cultos y música en vivo (escritorio Windows con Tauri v2; motor de audio en Rust con CPAL/WASAPI, Symphonia, rubato y rtrb; interfaz en React 19 + TypeScript; control remoto por la red local desde celulares).

**Criterio de fondo:** un fallo en directo es peor que una función que falte (un chasquido, un corte, un salto a la sección equivocada, un cuelgue, una pérdida de datos). Prioriza lo que puede provocar eso.

## Antes de empezar, lee en este orden
1. `CLAUDE.md` (mapa de módulos, reglas que no se pueden romper, decisiones cerradas, pendientes conocidos).
2. `docs/AUDITORIA.md` (orden, reglas, lo ya conocido, formato del informe). **Su formato de informe es obligatorio.**
3. `docs/ARQUITECTURA.md` (flujos).
4. `docs/PLAN_CORRECCIONES.md` (las tres auditorías anteriores ya se atendieron en cinco olas: qué se corrigió, con qué prueba y qué quedó sin medir).
Si algo de esos documentos contradice el código, manda el código: dilo en el informe.

**Esta es una auditoría completa sobre un código ya corregido.** Además de buscar fallos nuevos, **revalida las correcciones** que lista la sección 4 de `docs/AUDITORIA.md`: para cada una di si el arreglo es correcto y completo o si deja un caso sin cubrir (que la prueba pase no basta). La sección 6 lista código sin llamadas que se conserva a propósito y la 7 lo que se eliminó en la última limpieza: no lo reportes como hallazgo.

## Las 10 áreas que debes evaluar
Para cada una, da un veredicto (**Sólido / Aceptable / Con riesgo / Crítico**) y sus hallazgos.

1. **Callback de audio en tiempo real** (`audio/playback/callback.rs`, `block.rs`, `fade.rs`). ¿Hay asignaciones, bloqueos, logging o trabajo impredecible? Revisa la rampa de volumen y paneo (nueva), el limitador suave y los medidores (no medidos en el callback). ¿Pueden aparecer chasquidos o distorsión?
2. **Transporte, saltos de sección y cambio de canción** (`transport.rs`, `jumps.rs`, `clock.rs`). Seek, saltos cuantizados, vamp, fin de canción, «Dejar lista la siguiente». Hay un chasquido conocido al pasar de canción cuya causa no se ha identificado: busca candidatas.
3. **Sincronía de pistas y buffers** (feeders, anillos `rtrb`, `feeder_io.rs`, `pitch.rs`, `resampler.rs`). Deriva entre pistas, underruns, pistas más cortas que la canción, cambio de tono, resincronización, carreras entre hilos y el orden de los mutex.
4. **Importación y caché PCM** (`import.rs`, `cache.rs`, `audio/mod.rs`, `nativeImportPlan.ts`, `useNativeImport`). Archivos raros o corruptos, rutas con caracteres especiales, disco desconectado, caché obsoleta o incompleta, reimportación que pierde la mezcla.
5. **Persistencia de la biblioteca** (`library/mod.rs`, `replace_file_atomic`, `saveScheduler.ts`, `close_gate.rs`, `closeFlush.ts`, `projectDb.ts`, `desktopLibrary.ts`, sidecars, picos, migraciones). Pérdida o corrupción de datos, escrituras atómicas, doble fuente de verdad (IndexedDB y `library.json`), qué pasa si la app se cierra a mitad de un guardado, el setlist por comandos de Rust y el borrado de una canción con guardados pendientes.
6. **Seguridad del servidor LAN** (`lan.rs`, `protocol.rs`). Autenticación por enlace con token, cookies, comprobación de origen, límites de tasa, validación de entradas, exposición fuera de la red local, enumeración o reutilización de tokens.
7. **Fiabilidad del control remoto** (`RemoteConnectionBridge.tsx`, `remoteState.ts`, `desktop/web/remote.js`). Reconexión, mensajes de estado, comandos obsoletos, el puente que apaga el servidor ante un solo error, contadores de rechazos, comportamiento con la pantalla del celular apagada o al cambiar de red.
8. **Mezcla, ruteo de salidas y monitor** (`routing.rs`, `bus.rs`, `controlQueue.ts`, `controlSync.ts`, `MultitrackMixer.tsx`). Orden de los comandos, autocorrección, mute/solo (hoy cortan de golpe), buses Click/Guía/Monitor, ruteo por dispositivo, dispositivo desconectado.
9. **Contrato interfaz–motor y estado de React** (`nativeAudioEngine.ts`, `statePoller.ts`, `scripts/verify-ipc.ts`, `App.tsx` y `src/hooks/*`). Condiciones de carrera, estado duplicado, promesas sin esperar, errores tragados, re-renderizados excesivos (≈40 por segundo al reproducir).
10. **Robustez de uso y recuperación** (arranque, canción siempre montada, `ErrorBoundary`, avisos de dispositivo o caché faltante, error de lectura de la biblioteca, cierre inesperado, accesibilidad básica de la interfaz durante un servicio). ¿Qué ve el usuario cuando algo falla? ¿Se recupera solo?

## Cómo trabajar
- **No modifiques código.** Solo informe.
- Si puedes ejecutar comandos, usa solo los rápidos: `npm run lint`, `npm test`, `npm run build` y, en `desktop/src-tauri`, `cargo test --lib`. **No** lances `verify.ps1 -Completo` (tarda cerca de una hora).
- No puedes probar audio real ni WASAPI: ahí escribe **«No medido»** en vez de suponer. Marca como «No verificado» todo lo que afirmes sin haberlo comprobado.
- Ignora el estilo visual, `node_modules/`, `dist/`, `target/`, `package-lock.json` y `AGENTS.md`. No propongas migrar de framework ni reescrituras amplias.
- No reportes como nuevo lo listado como conocido en `docs/AUDITORIA.md`, pero sí puedes darle su gravedad real.
- No inventes hallazgos para llenar el informe: si un área está bien, dilo en una línea.

## Qué entregar
1. **Resumen ejecutivo** (máximo 10 líneas): estado general y las 3 cosas que arreglarías antes del próximo servicio.
2. **Tabla de las 10 áreas** con su veredicto y el número de hallazgos por gravedad.
3. **Hallazgos**, ordenados de mayor a menor gravedad, con el formato de la sección 7 de `docs/AUDITORIA.md` (archivo:línea, gravedad, qué falla, escenario concreto, cómo lo verificaste, arreglo sugerido).
4. **Los 10 problemas más importantes en total**, en orden, para decidir qué arreglar primero.
5. **Veredicto sobre las correcciones recientes** (sección 4 de `docs/AUDITORIA.md`): cuáles están bien, cuáles incompletas y por qué.
6. **Lo que no pudiste revisar** y por qué.
