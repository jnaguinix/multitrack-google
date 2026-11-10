# OmniTracks · Guía de relevo

OmniTracks reproduce multitracks en directo. La prioridad es que el audio siga estable en un portátil de 8 GB y 4 núcleos, también sin Internet y con teléfonos conectados. React, TypeScript y Vite son el frontend compartido. Tauri v2 empaqueta el escritorio de Windows y Rust sirve las páginas LAN.

## Empieza aquí

1. Ejecuta `git status --short --branch`, `git log -3 --oneline` y `git remote -v`. Conserva los cambios locales. Trabaja sobre la tarea solicitada y evita repetir la auditoría del PoC.
2. El repo es [jnaguinix/multitrack-google](https://github.com/jnaguinix/multitrack-google). Usa `main`. El commit `9b9b884` ya contiene web, escritorio y el nombre OmniTracks. `poc/tauri-desktop` es histórico. El primer instalador OmniTracks probado es 0.2.2.
3. Salta a la sección de la tarea. Para empaquetar, usa [Generar el instalador Windows x64](#generar-el-instalador-windows-x64). Para el resto, empieza por [Mapa de trabajo](#mapa-de-trabajo), abre los archivos de esa fila y usa su [validación](#validación-según-el-cambio). Busca símbolos con `rg -n` en esos archivos antes de recorrer todo el repo.
4. Esta guía describe el estado actual. [desktop/README.md](desktop/README.md) amplía firma, operación LAN y pruebas de campo. [desktop/INFORME_POC.md](desktop/INFORME_POC.md) registra la evidencia inicial. [Manual.md](Manual.md) conserva un diagnóstico de una versión anterior del motor. Sus problemas y propuestas son contexto histórico. Por ejemplo, el modo inicial actual es `stream` con respaldo en búfer y el PCM ya conserva las fuentes mono.

Si partes de cero, clona y entra a la raíz. Si la carpeta ya existe, empieza por revisar su estado.

```powershell
git clone --branch main https://github.com/jnaguinix/multitrack-google.git
Set-Location .\multitrack-google
Test-Path .\desktop\src-tauri\tauri.conf.json
```

## Generar el instalador Windows x64

### 1. Comprobar el entorno

Usa PowerShell **nativo de Windows**, Node.js 24 x64, Git, Rust estable **MSVC** y Visual Studio Build Tools con **Desarrollo de escritorio con C++**, MSVC x64/x86 y Windows SDK. Compila con conexión para resolver paquetes y descargar NSIS y WebView2 si faltan en caché. El instalador resultante sí está preparado para instalarse sin Internet. [Requisitos oficiales de Tauri](https://v2.tauri.app/start/prerequisites/)

```powershell
node -p "process.platform + ' ' + process.arch"
npm.cmd --version
Get-Command rustup,cargo,rustc | Select-Object Name,Source
rustc -vV
```

Lo esperado es `win32 x64` y `host: x86_64-pc-windows-msvc`. Si falta Rust, instálalo con [Rustup](https://rustup.rs/) y abre una terminal nueva. Si está instalado pero quedó fuera del PATH, revisa primero `%USERPROFILE%\.cargo\bin` o la ruta del entorno existente. Con una instalación no estándar, `RUSTUP_HOME` y `CARGO_HOME` deben apuntar a los directorios reales de ese entorno. Si falta C++, usa la instalación de Build Tools indicada en [desktop/README.md](desktop/README.md#compilar-en-windows).

Si tienes Rust pero falta el toolchain MSVC, instálalo y selecciónalo para esta sesión.

```powershell
rustup toolchain install stable-x86_64-pc-windows-msvc --profile minimal
$env:RUSTUP_TOOLCHAIN = 'stable-x86_64-pc-windows-msvc'
rustc -vV
```

### 2. Instalar dependencias y empaquetar

Ejecuta este bloque desde la raíz del repositorio, donde conviven `package.json` y `desktop/`. Instala ambas dependencias en un clon limpio. La raíz no tiene lockfile npm y se prepara con `install --legacy-peer-deps --no-package-lock`. `desktop/` tiene su propio lockfile y usa `ci`. Puedes omitir ambas instalaciones en una copia ya preparada con las mismas dependencias. El instalador de prueba se construye sin `.env`, clave de Gemini ni clave de firma.

```powershell
npm.cmd install --legacy-peer-deps --no-package-lock
if ($LASTEXITCODE -ne 0) { throw 'Falló npm en la raíz.' }

npm.cmd ci --prefix desktop
if ($LASTEXITCODE -ne 0) { throw 'Falló npm en desktop.' }

$buildStartedUtc = [DateTime]::UtcNow
npm.cmd --prefix desktop run build
if ($LASTEXITCODE -ne 0) { throw 'Falló el build de escritorio. Revisa la primera causa del log.' }

$cargoInfo = cargo metadata --format-version 1 --no-deps --manifest-path .\desktop\src-tauri\Cargo.toml | ConvertFrom-Json
if ($LASTEXITCODE -ne 0) { throw 'Cargo no pudo localizar target.' }

$config = Get-Content -LiteralPath .\desktop\src-tauri\tauri.conf.json -Raw | ConvertFrom-Json
$bundleDir = Join-Path $cargoInfo.target_directory 'x86_64-pc-windows-msvc/release/bundle/nsis'
$installerName = "$($config.productName)_$($config.version)_x64-setup.exe"
$installer = Get-Item -LiteralPath (Join-Path $bundleDir $installerName) -ErrorAction Stop
if ($installer.LastWriteTimeUtc -lt $buildStartedUtc) { throw 'El instalador hallado pertenece a una compilación anterior.' }

$installer | Select-Object FullName,Length,LastWriteTime
Get-FileHash -LiteralPath $installer.FullName -Algorithm SHA256
```

El comando ejecuta Tauri v2 desde `desktop/`. Su hook genera `desktop/dist/`, incrusta el frontend y produce **un solo NSIS `*-setup.exe`** con WebView2 Evergreen offline. En una instalación estándar queda en `desktop/src-tauri/target/x86_64-pc-windows-msvc/release/bundle/nsis/`. Si el entorno define `CARGO_TARGET_DIR`, usa la ruta devuelta por Cargo. La versión de referencia se llama `OmniTracks_0.2.2_x64-setup.exe`. La primera compilación y la compresión del runtime pueden tardar varios minutos. Espera a que el comando termine y devuelva código 0. [Instalador Windows de Tauri](https://v2.tauri.app/distribute/windows-installer/)

| Si te pidieron | Comando desde la raíz | Resultado |
| --- | --- | --- |
| Instalador de prueba con WebView2 | `npm.cmd --prefix desktop run build` | `release/bundle/nsis/*-setup.exe`. Puede generarse sin clave de firma. |
| Ejecutable portátil para diagnóstico | `npm.cmd --prefix desktop run build:portable` | `release/omnitracks-desktop.exe`. Requiere WebView2 instalado. |
| Web de Netlify | `npm.cmd run lint` y `npm.cmd run build` | `dist/` en la raíz. |
| Instalador con canal de actualizaciones | `desktop/build-release.ps1` con las claves del proyecto | Instalador y `latest.json`. Sigue [Publicar la primera versión](desktop/README.md#publicar-la-primera-versión-con-actualizaciones). |

### 3. Probar lo que se va a entregar

Instala **ese mismo archivo** en una sesión de prueba de Windows y abre **OmniTracks** desde Inicio. Comprueba que el acceso apunta a la versión recién construida, aparece la interfaz y la LAN comienza apagada. El destino predeterminado es `%LOCALAPPDATA%\OmniTracks\omnitracks-desktop.exe`. La variante sin clave omite el botón de actualizaciones. Si ya existe LibreTracks Desktop, cierra esa ventana antes de abrir OmniTracks. Windows puede mostrar las dos instalaciones y ambas comparten el perfil del mismo usuario. Conserva los datos de aplicación si se desinstala la antigua.

Al entregar, indica **commit, versión, ruta absoluta del `*-setup.exe` y qué arranque probaste**. Si el entorno solo permite compilar, marca la instalación y el arranque como **no medidos**. Los binarios y sus logs son artefactos locales. GitHub y Netlify reciben código, y GitHub Releases recibe el instalador únicamente al publicar una versión de escritorio.

### Diagnóstico por síntoma

| Síntoma | Qué comprobar primero |
| --- | --- |
| `desktop/` no existe | Comprueba raíz, remoto y commit. Actualiza a `main` con el árbol limpio. |
| PowerShell bloquea `npm.ps1` | Llama `npm.cmd`. El hook de escritorio ya abre su propio `powershell.exe` para compilar. |
| `cargo metadata` falla o falta `cargo` | Verifica el PATH y el toolchain de la terminal que lanzó npm. Confirma el manifiesto con `cargo metadata --format-version 1 --no-deps --manifest-path desktop/src-tauri/Cargo.toml`. |
| `link.exe` o `kernel32.lib` no aparecen | Revisa MSVC y Windows SDK. Si ya están instalados, abre **Developer PowerShell for VS** x64 y repite con ese entorno. |
| `ERESOLVE` en la raíz o `tauri` no se reconoce | Usa los dos comandos npm del bloque. Tauri CLI se instala en `desktop/node_modules`. |
| El log acaba en `Built application at` y falta `*-setup.exe` | Comprueba que usaste `run build` y espera a `Finished 1 bundle at`. Si terminó con error, revisa el tramo de NSIS. `cargo build` y `build:portable` solo producen el ejecutable. |
| Descarga de NSIS/WebView2 con error o Cargo en offline | Comprueba salida de red y proxy de la terminal. Si `CARGO_NET_OFFLINE` está activo sin una caché completa, desactívalo en esa sesión. Pide el acceso requerido si el entorno aísla la red. |
| Hay instaladores en varias carpetas | Resuelve `target_directory` con Cargo y verifica fecha, versión y ruta. Ejecuta una sola compilación a la vez para evitar confundir artefactos. |
| Windows instaló, pero no abre | Revisa el destino de Inicio y arranca el **ejecutable instalado** desde PowerShell para recoger stderr. Un paquete antiguo 0.2.0 falló por inicializar el actualizador sin configuración. En la versión actual, el actualizador solo se activa cuando su configuración carga correctamente. |
| El instalador se genera, pero falta el botón de actualización | Es esperado en la compilación de prueba. La clave de firma y el canal solo se incorporan con el script de publicación. |

Si necesitas pasar el fallo a otro agente, comparte el comando, su código de salida y la primera causa del log con unas líneas de contexto. Guarda el registro completo en un archivo si hace falta consultarlo. Evita volcar `Cargo.lock`, `dist/` o toda la salida de compilación en el chat.

Para capturar el fallo de arranque del destino predeterminado, cierra otras instancias y ejecuta este bloque.

```powershell
$installed = Join-Path $env:LOCALAPPDATA 'OmniTracks\omnitracks-desktop.exe'
(Get-Item -LiteralPath $installed).VersionInfo | Select-Object ProductName,FileVersion,FileName
$startupLog = Join-Path $env:TEMP 'omnitracks-arranque.log'
& $installed 2>&1 | Tee-Object -FilePath $startupLog
```

## Mapa de trabajo

`src/main.tsx` monta `App`. `src/App.tsx` coordina biblioteca, canción activa, Setlist, navegación por hash y transporte. `src/types/project.ts` define el contrato de canción, pistas, secciones, modos de transición y buses. `updateCurrentProject` es la ruta común para sincronizar un cambio de mezcla o configuración con el motor, la lista de proyectos y el guardado.

| Área | Empieza en | Qué localizar |
| --- | --- | --- |
| Marca, navegación y estilos | `src/components/TopBar.tsx`, `src/index.css`, `index.html`, `metadata.json` | Pestañas, tema y título web. El nombre de ventana e instalador se define en `desktop/src-tauri/tauri.conf.json`. |
| Setlist y repertorio | `src/components/SetlistPageView.tsx`, `src/components/RepertoireTreeSidebar.tsx`, `src/App.tsx` | `setlistQueue`, `handleAddToSetlist`, `handleReorderSetlist` y `handleNextSetlistSong`. La cola se deriva de `inSetlist` y `setlistOrder` en los proyectos. |
| En vivo, transporte y atajos | `src/components/LiveSetView.tsx`, `src/components/TransportDeck.tsx`, `src/App.tsx` | Tiempo, sección activa, siguiente canción y ajustes de reproducción. Busca `handleKeyDown`, `handleJumpSection` y `handleSeekSeconds` para seguir una acción hasta el motor. |
| Arreglo, secciones y onda | `src/components/TimelineArranger.tsx`, `src/components/LibraryAndModals.tsx`, `src/utils/songWaveform.ts` | `SectionEditorModal`, `handleSaveSections` y `handleAddMarkerAtPlayhead`. La onda de canción se construye con picos guardados por pista. Los proyectos antiguos se normalizan de compases a segundos en `projectDb.ts`. |
| Mezcla local y Control rápido | `src/components/MultitrackMixer.tsx`, `src/components/StageRemoteView.tsx`, `src/App.tsx` | Ganancia, paneo, mute, solo, buses y medidores. Control rápido es la vista local `#remote`, con estado, saltos, click, guía y mezcla rápida. El `BroadcastChannel` existente funciona entre contextos del mismo origen. Para teléfonos en LAN, usa el servidor de escritorio. |
| Biblioteca, importación y edición de pistas | `src/components/LibraryAndModals.tsx`, `src/App.tsx`, `src/utils/fileImportHelper.ts`, `src/storage/sourceFiles.ts` | `LibraryView`, `StemImporterModal`, `handleInstantImportFiles`, `handleDropOnDaw` y `handleRelinkProject`. `smartAnalyzer.ts` infiere metadatos de nombres y `inferTrackRoleAndColor` clasifica pistas. |
| Datos, caché y proyectos JSON | `src/storage/projectDb.ts`, `src/storage/pcmOptimizer.ts`, `src/storage/opfsStorage.ts`, `src/storage/cachePolicy.ts` | Metadatos, blobs o permisos de origen, regeneración PCM y limpieza. `handleExportJson` y `handleImportJsonFile` están en `App.tsx`. |
| Audio, saltos y transición de canciones | `src/audio/audioEngine.ts`, `src/audio/streamingTrack.ts`, `src/audio/pcmReaderClient.ts`, `src/audio/pcmReader.worker.ts` | `activateProject` llama a `loadProject`. Sigue `ensureSchedulerWorker`, `runLookaheadSchedulerTick`, `queueSectionJump` o `toggleVamp` según el síntoma. El Worker de lectura PCM y el Worker del scheduler son independientes. |
| Panel **Conexión remota** | `desktop/frontend/RemoteConnectionBridge.tsx`, `desktop/frontend/remoteState.ts`, `desktop/frontend/connection.css` | Selector de IPv4, interruptor, QR, expulsión y puente IPC. El botón va en la barra de transporte o la cabecera según la vista. |
| Monitor y mezclador de teléfono | `desktop/web/remote.html`, `desktop/web/remote.css`, `desktop/web/remote.js` | UI ligera servida por Rust. La cuenta regresiva interpola localmente. Volumen y paneo se envían al soltar el control. |
| Servidor LAN y permisos | `desktop/src-tauri/src/main.rs`, `desktop/src-tauri/src/lan.rs`, `desktop/src-tauri/src/protocol.rs`, `desktop/src-tauri/tests/lan_protocol.rs` | `pair`, `enqueue` y `exchange`. El servidor valida sesión, rol, origen y comandos. El cliente recibe un snapshot inicial y deltas posteriores. |
| Web, escritorio y distribución | `package.json`, `vite.config.ts`, `desktop/package.json`, `desktop/build-frontend.ps1`, `desktop/src-tauri/tauri.conf.json`, `desktop/build-release.ps1` | Web genera `dist/`. Tauri incrusta `desktop/dist/`. El actualizador se implementa en `desktop/src-tauri/src/updates.rs` y `desktop/frontend/DesktopUpdates.tsx`. |

### Cómo seguir un fallo

- **La canción aparece, pero no suena.** Revisa si `activateProject` terminó, si las pistas tienen acceso al origen y si el modo efectivo es `stream` o `buffer`. IndexedDB `projects` guarda la ficha y el Setlist. `audioBuffers` guarda audio o referencias de origen. OPFS guarda PCM regenerable. Una ficha importada desde JSON puede existir sin audio. Para archivos movidos o permisos perdidos, empieza por **Biblioteca → Reubicar archivos**.
- **El cambio a la siguiente canción tarda.** Sigue `setlistQueue` y la precarga en `App.tsx`, luego la preparación en `audioEngine.ts`. Distingue tiempo de montaje, estado listo en RAM o PCM preparado y tiempo hasta el primer sonido. El registro de activación por sí solo mide el montaje. En un perfil sin preferencias, el motor elige `stream`, usa OPFS cuando hay PCM utilizable y recurre a búfer cuando hace falta. El modo configurado y el efectivo pueden diferir.
- **El fader y el medidor parecen discrepar.** El fader local expresa ganancia de −40 a +10 dB, con silencio al fondo. El medidor de pista local muestra picos de muestras en dBFS tras ganancia y paneo. El mezclador LAN muestra actividad a partir de RMS escalado. Para comparar niveles usa el mismo WAV y la misma etapa del recorrido. Un resultado en LUFS mide sonoridad con otro criterio.
- **El click sale por el lado equivocado.** Revisa los buses `main`, `cue-click` y `both` en `project.ts`, la asignación por pista y `splitRoutingMode`. En Split‑Mono se espera click/guía a la izquierda y música a la derecha en una sola salida estéreo. La app usa la salida predeterminada de Windows. Verifica el ruteo en la interfaz física.
- **El remoto muestra datos, pero no aplica un ajuste.** Confirma rol de sonidista, proyecto activo y revisión de pistas. Sigue `enqueue` en Rust, `exchange`, `targets` y `applyMix` en el puente. Un ajuste antiguo se descarta si ya cambió la canción o su revisión. El log de latencia mide recepción a confirmación de aplicación, sin incluir la salida acústica.
- **La web y el escritorio difieren.** Usa `npm.cmd run dev` para la UI web local y `npm.cmd run build` para validar `dist/`. En escritorio prueba el build de Tauri, que usa WebView2 y otro origen. IndexedDB, OPFS y permisos de archivos pertenecen a su perfil y origen. Netlify y Tauri mantienen bibliotecas separadas.

### Contratos a conservar

- Mantén el motor en `src/audio/` y la persistencia en `src/storage/` salvo que el objetivo requiera tocarlos. Conserva `org.libretracks.desktop.poc`, el origen `https://tauri.localhost` e IndexedDB `LibreTracksWebDB` para que el cambio de nombre no cree un perfil vacío. Los JSON antiguos `.libretracks.json` siguen siendo importables. Los JSON transportan metadatos, secciones y mezcla. Las pistas locales viajan por separado.
- El build web usa `dist/`. Solo el hook de escritorio activa `VITE_LIBRETRACKS_DESKTOP=1` y produce `desktop/dist/`. El panel LAN pertenece al shell Tauri. El despliegue web se comprueba en el sitio o en Netlify. Un push por sí solo confirma GitHub.
- La LAN arranca apagada. El servidor escucha en la IPv4 privada elegida y puerto TCP `8765`. `/monitor` es de solo lectura. `/mezclador` admite exclusivamente `setTrackGain`, `setTrackPan`, `setTrackMute` y `setTrackSolo` por pista. Preserva sesiones por rol, validación del servidor, revisión de pistas, límites y colas acotadas. El puente aplica ajustes fuera del scheduler y sondea cada 100 ms como máximo cuando está activo. El control táctil envía al soltar la bolita. La ganancia remota es 0–1 y el paneo −1 a +1.
- Si un celular falla, comprueba primero el QR vigente, la IPv4 del portátil y si otro equipo abre `http://<IPv4>:8765/monitor` en la misma LAN. En un Android se resolvió dando al navegador permiso de **Dispositivos cercanos** o **Red local**. Si el puerto está ocupado, comprueba si sigue abierto otro ejecutable de OmniTracks o LibreTracks. Evita cambiar firewall o antivirus como primera prueba.

## Validación según el cambio

- **Web o interfaz compartida.** `npm.cmd run lint`, `npm.cmd run build` y prueba visual de la vista afectada. En Setlist verifica agregar, quitar, reordenar y recargar. En En vivo y Arreglo prueba saltos de sección, búsqueda y edición según el cambio. Si tocaste transporte o atajos, revisa foco en campos, pausa y detención. El build web no necesita compilar Rust. Para Netlify, la entrada es el proyecto raíz y la salida web es `dist/`. Este repo carece de `netlify.toml`, así que verifica la configuración y la publicación en el sitio real si la tarea las incluye.
- **Importación, biblioteca o caché.** Prueba archivos y carpeta, arrastre si aplica, reapertura y un proyecto anterior. Si cambia el almacenamiento, prueba con un perfil aislado y material prescindible. Comprueba si recuperas solo metadatos o también el audio. Para WebView2, `desktop/test/probe-runtime.js` prueba IndexedDB y OPFS desde DevTools.
- **Audio o mezcla.** Prueba al menos un WAV reproducible en modo búfer y en streaming con PCM. Registra el modo efectivo, lecturas y underruns con `window.__streamStats()` antes y después. Incluye el caso afectado, como seek, salto cuantizado, mute/solo, transición, paneo o Split‑Mono. Un reloj que avanza demuestra transporte. Para verificar sonido o ruteo, observa o graba la salida.
- **Servidor o UI LAN.** Ejecuta `cargo test --locked --release --target x86_64-pc-windows-msvc --manifest-path desktop/src-tauri/Cargo.toml --no-default-features`. Las seis pruebas cubren snapshots, deltas, reconexión, roles, revocación, colas y recuperación de un cupo al alcanzar 16 sesiones. Se ejecutan en loopback. Si cambias la UI remota, abre ambos roles con QR y prueba táctil en el mezclador. Si cambias el puente o el listener, reproduce y apaga la LAN para comprobar que continúa el transporte.
- **Instalador.** El bloque de compilación produjo el NSIS 0.2.2 desde un clon limpio en Windows con las herramientas de compilación ya instaladas. En una prueba anterior de la misma versión se verificó el acceso en Inicio y se abrió su ejecutable instalado con un perfil aislado. Instalar en Windows limpio sin Internet y actualizar entre dos versiones publicadas siguen **no medidos**.
- **Antes de publicar escritorio.** Falta el ensayo real de 20 pistas durante 15 minutos en Chrome, Desktop sin LAN y Desktop con 3–5 celulares. Registrar cortes, CPU/RAM, `window.__streamStats()` y Split‑Mono físico con click/guía a la izquierda y música a la derecha. El [protocolo de pruebas](desktop/README.md#pruebas-reproducibles) detalla persistencia, selectores y desconexiones. Reporta **no medido** cuando falte evidencia. La firma de prueba no equivale a publicar el canal definitivo.

## Mensaje breve para otro agente

> Lee `instrucciones.md` y ejecuta `git status --short --branch`. Mi tarea es [escribe el objetivo]. Usa la sección correspondiente. Si te pido el instalador, compila el NSIS de Windows x64 desde `main`, verifica el archivo recién generado y entrega su ruta absoluta. Prueba el arranque del ejecutable instalado si tienes un Windows de prueba. Si falla, dime el comando, la primera causa del log y qué requisito o acceso falta.
