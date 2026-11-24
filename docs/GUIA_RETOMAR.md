# Guía para retomar el trabajo en OmniTracks

Para quien tome el proyecto desde esta carpeta (persona o asistente, por ejemplo Antigravity). Dice en qué estado está, cómo comprobar que nada se rompió, cómo correr el servidor local de prueba y cómo compilar el `.exe`. Léela primero y después `CLAUDE.md` (reglas y mapa de módulos), `docs/ARQUITECTURA.md` (flujos), `docs/PLAN_CORRECCIONES.md` (qué se corrigió y qué queda) y `docs/AUDITORIA.md` (guía de auditoría). Si algo de aquí contradice el código, manda el código: corrige esta guía.

Última actualización: 2026-11-23, sobre `main` en `1e2c6c5`.

---

## 1. Estado actual

- **Rama `main`** (versión 0.3.0 de escritorio): incluye las olas 2 a 6 del plan de correcciones. La Ola 6 (puntos 6.1 a 6.12, del triaje de la segunda auditoría de Antigravity) está completa y fusionada.
- **Pruebas el 2026-11-23, todas en verde en las ramas antes de fusionarlas** (el contenido de `main` es el mismo; no se repitieron sobre `main`): `cargo test --lib` (245 pruebas), `npm test`, `npm run lint`, `npm run build`.
- **El `.exe` que hay en la carpeta es anterior a la Ola 6.** El último compilado (`desktop\src-tauri\target\x86_64-pc-windows-msvc\release\omnitracks-desktop.exe`) es del 2026-11-23 a las 00:50 y los commits de la Ola 6 son de las 09:55 en adelante. Para probar la Ola 6 en la app real hay que compilar uno nuevo (sección 5).
- **Nada de la Ola 6 se ha medido en el `.exe`**: ni el vamp cerca del final de una sección, ni el aviso de dispositivo desconectado en la ventana «Audio», ni los faders de Click y Guía con varias pistas, ni la reconexión del control remoto en un teléfono real. Dilo como «No medido» en cualquier informe.
- **FLAC**: el dueño probó a mano una canción en FLAC de 16 bits, 44,1 kHz y estéreo (17 pistas): importa, suena y se ve bien. No hay prueba automática con un FLAC; no se ha probado 24 bits ni 48 kHz.

### Lo que queda abierto
- **Ola 6, partes no hechas:** en 6.6, lo de `buffering` en `stop` no se tocó (el diseño actual baja `is_buffering` a propósito); en 6.2 no se compara `format_version`; en 6.10 el validador de IDs está en importar, borrar caché y borrar canción, pero no en `audio_load_project`.
- **Hallazgos de Antigravity sin tocar** (en `docs/PLAN_CORRECCIONES.md`, Ola 6): los «plausibles» H4, H6 y H9, los sin verificar H8b, H18 a H26 y H28 a H29. Regla: **no se corrigen sin un síntoma real o una prueba que falle**; corregir a ciegas es como se rompe lo que hoy funciona.
- **Decisiones del dueño sin tomar:** HTTPS para el control remoto (punto 3.6), ASIO, compensación de sonoridad por canción.
- **Chasquido ocasional** al pasar de canción con «Dejar lista la siguiente»: causa sin identificar, no medido con hardware.
- **Sin cubrir por pruebas automáticas:** el bloqueo de Windows al borrar una caché con un PCM abierto (6.5) y los flujos de React de 6.3, 6.7, 6.8, 6.9 y 6.11 (solo hay pruebas de su lógica pura).

---

## 2. Reglas de trabajo (del dueño)

- **Idioma:** español, respuestas cortas y sencillas, sin jerga. Si algo no se midió, di «No medido».
- **Ramas:** trabaja siempre en una rama aparte creada desde `main`. **Nunca hagas commit ni merge directo en `main`, ni subas, salvo que el dueño lo pida de forma expresa** (suele decir «fusiona y sube»; entonces: `git merge --no-ff <rama>` y `git push origin main`). Un cambio lógico por commit, con mensaje preciso.
- **Primero la prueba:** cada corrección lleva una prueba que falle sin ella (comprueba quitando el arreglo un momento) y luego pase.
- **UTF-8 sin BOM** en todos los archivos. Nunca `.catch(() => {})` ni `catch` mudo: registra el fallo o muéstralo (`logAsyncError`, `notifyUser`); el que de verdad no avisa lleva `// catch-ok: <motivo>`.
- **No lances `verify.ps1 -Completo`** (≈45–60 min). El verify rápido por commit basta; el completo lo pide el dueño.
- **El dueño compila y prueba el `.exe` él mismo.** No compiles el `.exe` ni vigiles su progreso salvo que lo pida; entrégale el comando (sección 5). Si el `.exe` abierto bloquea la compilación («Acceso denegado»), está autorizado cerrar el proceso `omnitracks-desktop`, solo ese.
- **Documentación:** si mueves, renombras o añades módulos, actualiza `CLAUDE.md`, su copia `AGENTS.md` (idénticas salvo una frase de la sección 5) y `docs/ARQUITECTURA.md`.
- **No toques** `.claude/` (configuración local) ni `scratch/` (ignorada por git).
- **Callback de audio:** sin `println!`/`tracing`, sin asignaciones, sin `lock()` bloqueante dentro de `BlockMixer::process`. Es lo más delicado del proyecto (ver `CLAUDE.md`, sección 3).

---

## 3. Entorno de este equipo

- Windows 11, Node (`npm`) y Git funcionan desde cualquier terminal. En PowerShell usa `npm.cmd` si `npm` te da problemas de política de ejecución.
- **`cargo` NO está en el `PATH`.** El toolchain de Rust (MSVC) vive en la carpeta que instaló Codex. Antes de cualquier `cargo` o de `verify.ps1`, en la misma sesión de PowerShell:

```powershell
$t = "C:\Users\jpuerta\.codex\visualizations\2026\11\09\01a1be2f-be92-7153-bd62-a2684be8afbf"; $env:Path = "$t\rustup\toolchains\stable-x86_64-pc-windows-msvc\bin;" + $env:Path; $env:CARGO_HOME = "$t\cargo"; $env:RUSTUP_HOME = "$t\rustup"; cargo --version
```

  El entorno no persiste entre terminales: repite la línea en cada una. Si esa carpeta desapareciera, reinstala Rust con `rustup` (toolchain `stable-x86_64-pc-windows-msvc`) y los Build Tools de C++ de Visual Studio (detalle en `desktop/README.md`).
- **`.cargo/config.toml`** (raíz) define `CXXFLAGS_x86_64_pc_windows_msvc = "/Zc:__cplusplus"`: sin él no compila el cambio de tono (`ssstretch`) con MSVC. No lo borres.
- **FFmpeg** (versión 9.1, con `winget`) está instalado para convertir audio; no lo usa el proyecto.

---

## 4. Cómo comprobar que todo está bien

Se corre desde la raíz del repositorio. Orden recomendado por commit: lint, `npm test`, `cargo test --lib`, build.

| Orden | Comando | Qué comprueba |
|---|---|---|
| 1 | `npm run lint` | `tsc --noEmit`: tipos de TypeScript. |
| 2 | `npm test` | Todo lo de abajo (la cadena `test` de `package.json`). Se detiene en el primer fallo. |
| 3 | `cargo test --manifest-path desktop/src-tauri/Cargo.toml --lib -- --test-threads=4` | Pruebas del motor de audio (con el toolchain de la sección 3). |
| 4 | `npm run build` | Compila la interfaz con Vite (`dist/`). |

Todo en uno (con el toolchain ya puesto en la sesión): `powershell -ExecutionPolicy Bypass -File .\verify.ps1`. Hace lint, `npm test`, `cargo test --lib` y build, y se detiene en el primer fallo. **No** uses `-Completo` (ver sección 2).

### Qué hay dentro de `npm test`
- `scripts/verify-ipc.ts` (`npm run verify:ipc`): comprueba sin compilar el contrato interfaz-motor. Cada `invoke('x', {…})` contra su `#[tauri::command]` de Rust (existe, nombres y argumentos), los campos de las respuestas y el registro triple de comandos (`main.rs`, `build.rs`, `capabilities/desktop-remote.json`).
- `scripts/verify-rules.ts` (`npm run verify:rules`): vigila las reglas de `CLAUDE.md`: `.catch(() => {})` y `catch` mudos, BOM, ventanas o menús que no usen `Dialog`/`PopoverMenu`, `invoke` suelto de los controles de la mezcla, y logging, asignaciones o `lock()` dentro de `BlockMixer::process`. Revisa también los archivos nuevos sin agregar a git.
- `test/*.test.ts` (36 archivos): pruebas unitarias en Node con `tsx`. Cada una se corre sola con `npx tsx test/<nombre>.test.ts`. Las más útiles al tocar cada zona: `engineActivation` (carga, Play y cambio de canción), `controlSync` y `saveScheduler` (guardados y controles), `nativeImportPlan` (importar y reimportar), `bridgeLoop`, `remoteClose` y `remoteReceipts` (control remoto), `setlistMerge`, `trackGroups`, `deviceSelection`, `libraryLoad`, `staticRules`.

### Pruebas del motor (Rust)
- Una sola: `cargo test --manifest-path desktop/src-tauri/Cargo.toml --lib <parte_del_nombre>`. Ejemplos: `ensayo`, `test_ola6_`, `test_h06`.
- **`ensayo`** (`audio/playback/ensayo.rs`): una sesión completa del motor sin hardware (cargar, Play, fader, mute, solo, seek, saltos, vamp, cambio de tono, pausa, cambio de canción, parar) con audio sintético; vigila escalones, recortes, asignaciones y alineación entre pistas. Si añades una función del motor, añade su paso aquí.
- `test_h06_*` (vamp) depende de tiempos: aislada puede fallar a veces, también en `main` sin cambios; en la suite completa pasa.
- `cargo test` **sin `--lib`** corre además las pruebas de integración de `desktop/src-tauri/tests/` y tarda 45–60 minutos: no lo lances por iniciativa propia.
- Las pruebas que miden niveles o rampas deben dejar asentarse la rampa de volumen antes (`asentar` / `asentar_picos` en `playback/tests.rs`) y usar `motor_de_prueba()` (apaga el metrónomo).

### Lo que ninguna prueba automática cubre
Audio real por WASAPI, la ventana de la app, un teléfono real, un dispositivo que se desconecta de verdad. Eso solo se comprueba con el `.exe` (sección 6).

---

## 5. Servidor local de prueba (interfaz, sin sonido)

```powershell
npm run dev
```

Abre `http://localhost:3000` (Vite, `--host=0.0.0.0`, puerto 3000). Para el navegador integrado del asistente existe `.claude/launch.json` con una entrada `dev`.

- Instala un `window.__TAURI__` **simulado** (`src/preview/installPreview.ts`, el primero que importa `main.tsx`): tres canciones de ejemplo, transporte con reloj, saltos de sección, vamp y medidores animados. **No suena nada** y no hay motor de Rust: sirve para ver y probar la interfaz, no el audio.
- Parámetros de la URL: `?sinvista` desactiva la simulación; `?errorbiblioteca` simula dos lecturas fallidas de la biblioteca (para ver el aviso con «Reintentar»).
- Otras comprobaciones de interfaz: modo diagnóstico con `Ctrl+Mayús+D`; un error al dibujar un componente muestra el `ErrorBoundary`.
- Alternativa estática (sirve el build): `npm run build` y después `npm run preview -- --host 127.0.0.1 --strictPort`.
- Nada de `src/preview/*` entra en el `.exe` de producción.

---

## 6. Cómo compilar el `.exe`

Requisitos (ya instalados aquí): Node 24 x64, Rust estable MSVC (ver sección 3), Build Tools de C++ de Visual Studio, WebView2. La primera compilación necesita Internet; las siguientes no.

Una sola compilación a la vez (varias a la vez se pisan y se cancelan). Antes, **cierra OmniTracks si está abierto** (si no, falla con «Acceso denegado»). En PowerShell, desde cualquier carpeta:

```powershell
$t = "C:\Users\jpuerta\.codex\visualizations\2026\11\09\01a1be2f-be92-7153-bd62-a2684be8afbf"; $env:Path = "$t\cargo\bin;$t\rustup\toolchains\stable-x86_64-pc-windows-msvc\bin;" + $env:Path; $env:CARGO_HOME = "$t\cargo"; $env:RUSTUP_HOME = "$t\rustup"; Set-Location 'C:\Users\jpuerta\Documents\ChatGPT\Multi-chatgpt\multitrack-google'; npm.cmd --prefix desktop run build:portable
```

- Qué hace: `desktop/package.json` ejecuta `tauri build --no-bundle --target x86_64-pc-windows-msvc`; Tauri lanza antes `desktop/build-frontend.ps1`, que compila la interfaz con `VITE_OMNITRACKS_DESKTOP=1` en `desktop/dist/`, y luego compila el binario en modo `release`.
- **Salida (ejecutable portátil):** `desktop\src-tauri\target\x86_64-pc-windows-msvc\release\omnitracks-desktop.exe`. Necesita WebView2 instalado (Windows 11 ya lo trae). Para abrirlo y guardar su log: `.\desktop\src-tauri\target\x86_64-pc-windows-msvc\release\omnitracks-desktop.exe 2>&1 | Tee-Object -FilePath .\desktop-lan.log`.
- **Instalador (NSIS):** `npm.cmd --prefix desktop run build` deja un `*-setup.exe` en `desktop\src-tauri\target\x86_64-pc-windows-msvc\release\bundle\nsis`. El instalador firmado con actualizaciones (`desktop/build-release.ps1`) y la publicación en GitHub Releases están descritos en `desktop/README.md`; no hace falta para probar.
- **Comprobar que el `.exe` es el nuevo:** mira la fecha del archivo (`Get-Item <ruta> | Select LastWriteTime`) y ábrelo con la app anterior cerrada.
- Si la compilación falla: lee el primer error, no el último; suele ser el proceso abierto, una ruta de `cargo` mal puesta o la falta de `/Zc:__cplusplus`.

### Dónde guarda la app sus datos
`%LOCALAPPDATA%\org.omnitracks.desktop`: `library.json` (+ `.backup.json`), `peaks\`, `pcm\<id de la canción>\` (la caché), `audio_settings.json`, `audio_routing.json`. En cada carpeta de canción hay un `omnitracks.project.json` (sidecar). Para diagnosticar: Ajustes de audio → Diagnóstico → «Copiar diagnóstico» (o `Ctrl+Mayús+D` para activar el registro detallado).

---

## 7. Qué probar a mano tras compilar un `.exe` nuevo (Ola 6)

Es lo que el dueño ensaya. Marca cada punto como medido o «No medido» en el informe:
1. **Vamp cerca del final** de una sección: activarlo a 0,5 s del final y comprobar que no hay chasquido ni desfase; parar con el vamp activo y volver a dar Play.
2. **Montar en consola** una canción con el setlist armado: no debe sacarla del setlist ni cambiar su orden.
3. **Reimportar o regenerar caché** de una canción con otra carpeta: cada pista conserva su volumen, paneo, mute y solo.
4. **Borrar una canción** mientras suena otra; después reabrir la app y comprobar que la borrada no reaparece. Si falla el borrado de la caché, debe verse un aviso.
5. **Desconectar el dispositivo de audio** y abrir «Audio»: debe mostrar el guardado como «(desconectado)», no cambiarse a los altavoces.
6. **Control remoto:** apagar y encender la pantalla del teléfono, o cortar y volver el Wi-Fi: debe reconectar solo.
7. **Faders de Click y Guía** con varias pistas de ese tipo, y «Restablecer mezcla».
8. **Cambiar de canción mientras suena** (H12a): la nueva debe montarse y sonar sin quedar parada.

---

## 8. Formatos de audio

La importación decodifica todo a una caché PCM de 16 bits a la frecuencia del dispositivo, y desde ahí reproduce; el formato de origen no afecta al rendimiento al tocar. Acepta WAV, FLAC, MP3, OGG y M4A/AAC. El dueño migra su biblioteca a **FLAC** desde el inicio (sin pérdida y con el 35–50 % del tamaño del WAV; MP3 se descarta porque añade un retardo de codificador y pierde calidad). Un cambio de extensión de un archivo ya importado invalida su caché y rompe el emparejamiento por nombre de archivo (`match_sidecar_ids`, `planReimportedTracks`): hay que reimportar o reenlazar.

Conversión usada para los WAV de 16 bits (sin cambiar frecuencia ni canales): `ffmpeg -i entrada.wav -map 0:a -map_metadata 0 -c:a flac -compression_level 8 salida.flac`, comprobando antes de borrar el WAV que el audio decodificado de ambos coincide (`-c:a pcm_s32le -f md5 -`).
