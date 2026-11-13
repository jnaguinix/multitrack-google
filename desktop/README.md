# OmniTracks

Windows x64, Tauri v2 y WebView2 Evergreen. El instalador único contiene OmniTracks y el redistribuible autónomo de WebView2. Si el equipo ya tiene el runtime, el instalador lo reutiliza.

OmniTracks para Windows registra su instalación con identificador `org.omnitracks.desktop` y almacena sus datos locales en `%LOCALAPPDATA%\org.omnitracks.desktop`. Esta versión empieza con una biblioteca y configuración vacías: `library.json`, `library.backup.json`, `audio_settings.json` y la caché `pcm\` (ver `Manual.md` §5).

## Estado del Motor Nativo de Audio

La versión de escritorio integra un motor de reproducción de multitracks en Rust sobre WASAPI en modo compartido:

| Fase | Funcionalidad | Estado |
|---|---|:---:|
| **Fases 0 a 4** | Arquitectura, reproducción en Rust, streaming continuo desde disco con `rtrb`, micro-fades de 8 ms, caché PCM nativa, decodificación con `symphonia` y `rubato`, metrónomo y guías sintéticas, y compensación sinc de retardo de grupo. | **Completadas** |
| **Fase 5** | Ruteo multicanal discreto (> 2 salidas físicas independientes). Actualmente opera en estéreo o Split-Mono (Ch 1: Click/Guía, Ch 2: Música) en dispositivo de 2 canales. | **Diferida** |
| **Fase 6** | Control remoto por LAN vía HTTP/WebSocket (puerto 8765) para roles de Músico y Sonidista (`lan.rs`). Streaming de audio LAN para monitoreo personal en auriculares pendiente. | **Parcial** |
| **Fase 7** | Soporte de drivers ASIO (pospuesto por decisión del dueño debido a restricciones de licencia del SDK de Steinberg). | **Diferida** |

## Flujo de Desarrollo

- **Desarrollo rápido de la interfaz web:**
  ~~~powershell
  npm.cmd run dev
  ~~~
  Inicia Vite en modo desarrollo (`http://localhost:5173`) para iterar rápidamente la UI y componentes web con recarga en caliente.
- **Compilar y probar el ejecutable de escritorio (`.exe`):**
  ~~~powershell
  npm.cmd --prefix desktop run build:portable
  ~~~
  Construye el frontend de escritorio (`desktop/dist/`) y compila el binario portátil de Windows:
  `desktop\src-tauri\target\x86_64-pc-windows-msvc\release\omnitracks-desktop.exe`
- **Verificación rápida y completa del proyecto:**
  ~~~powershell
  powershell -ExecutionPolicy Bypass -File .\verify.ps1            # Rápida (lint, tests web, cargo test --lib, build web)
  powershell -ExecutionPolicy Bypass -File .\verify.ps1 -Completo  # Completa (+ cargo test completo y build:portable)
  ~~~

## Compilar en Windows

Se necesita PowerShell, Node.js 24 x64, Git, Rust estable MSVC y la carga de trabajo de C++ de Visual Studio Build Tools. Si faltan los Build Tools, ejecutar este comando en PowerShell con permisos de administrador.

~~~powershell
winget install --id Microsoft.VisualStudio.2022.BuildTools -e --source winget --accept-source-agreements --accept-package-agreements --override "--quiet --wait --norestart --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"
~~~

Instalar Rust con el instalador oficial y abrir una terminal nueva. [Rustup](https://rust-lang.org/tools/install/)

Ejecutar estos comandos desde la raíz del repositorio en una revisión que incluya `desktop/`. La primera compilación requiere Internet para descargar las dependencias, NSIS y WebView2.

~~~powershell
rustup toolchain install stable-x86_64-pc-windows-msvc --profile minimal
rustup override set stable-x86_64-pc-windows-msvc
npm.cmd install --legacy-peer-deps --no-package-lock
npm.cmd ci --prefix desktop
npm.cmd run lint
npm.cmd run build
npm.cmd --prefix desktop run build
Get-ChildItem .\desktop\src-tauri\target\x86_64-pc-windows-msvc\release\bundle\nsis -Filter '*-setup.exe'
~~~

Distribuye únicamente el `*-setup.exe` de la versión que vas a instalar. Cierra el ejecutable anterior antes de abrirlo. El instalador NSIS instala para el usuario actual y puede usarse sin Internet, también cuando falta WebView2. Windows puede mostrar una advertencia de editor desconocido mientras no se firme el ejecutable con Authenticode. La firma del actualizador de Tauri es independiente. [Instalador de Windows](https://v2.tauri.app/distribute/windows-installer/) · [Firma en Windows](https://v2.tauri.app/distribute/sign/windows/)

Antes de compartir el paquete, ejecuta ese mismo instalador y abre OmniTracks desde el menú Inicio. Comprueba la versión en las propiedades del ejecutable instalado. Una compilación de prueba sin canal debe abrir con el servidor LAN apagado y sin el botón de actualización.

El build web genera `dist/`. El build de escritorio usa `build-frontend.ps1` para generar `desktop/dist/`. Para crear el ejecutable portátil de diagnóstico, que sí requiere WebView2 instalado, y guardar su log desde PowerShell, ejecuta lo siguiente.

~~~powershell
npm.cmd --prefix desktop run build:portable
.\desktop\src-tauri\target\x86_64-pc-windows-msvc\release\omnitracks-desktop.exe 2>&1 | Tee-Object -FilePath .\desktop-lan.log
~~~

## Publicar la primera versión con actualizaciones

El instalador de prueba generado con `npm.cmd --prefix desktop run build` funciona por sí solo. Para que la instalación que entregues pueda actualizarse en el futuro, genera el **primer instalador distribuido** con la clave pública del canal. La versión portátil anterior y los instaladores de prueba se reemplazan manualmente una vez.

Genera una clave de firma una sola vez, fuera del repositorio, y protégela con contraseña. Guarda la clave privada y su contraseña en una ubicación de respaldo bajo tu control. Usa la misma pareja para cada versión.

~~~powershell
$signingKey = Join-Path $env:LOCALAPPDATA 'OmniTracks-signing.key'
npm.cmd --prefix desktop exec -- tauri signer generate -w $signingKey
~~~

Desde PowerShell, define la ruta y proporciona la contraseña sin escribirla en el historial. El script incrusta la clave pública y genera un solo `*-setup.exe` más el manifiesto que consume la app.

~~~powershell
$env:TAURI_SIGNING_PRIVATE_KEY = $signingKey
$signingPassword = Read-Host 'Contraseña de firma' -AsSecureString
$env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = [System.Net.NetworkCredential]::new('', $signingPassword).Password
try {
    powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\desktop\build-release.ps1 -PublicKeyFile "$signingKey.pub"
} finally {
    Remove-Item Env:TAURI_SIGNING_PRIVATE_KEY, Env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD
}
~~~

Después de validar en el portátil real, publica en GitHub Releases con el tag `desktop-v<versión>` apuntando al commit exacto del build. Sube el instalador y `latest.json` desde la carpeta que indica el script. La release de escritorio debe quedar marcada como **Latest** para que el enlace del manifiesto la resuelva. El manifiesto incluye la firma, así que el usuario solo descarga el instalador en la primera instalación. Mantén las versiones de escritorio en orden ascendente y sincroniza `tauri.conf.json`, `Cargo.toml` y `package.json` con sus lockfiles. [Actualizador de Tauri](https://v2.tauri.app/plugin/updater/)

En una app instalada con ese canal, abre **Conexión remota → Buscar actualizaciones** cuando el transporte y el servidor LAN estén detenidos. La app consulta GitHub, descarga y comprueba la firma antes de que el operador elija **Cerrar e instalar**. Se puede seguir usando OmniTracks sin Internet. Antes de distribuir, prueba una actualización entre dos versiones firmadas en una instalación de ensayo y confirma que conserva el Setlist y el audio local.

## Conectar los teléfonos

1. Importar y preparar las pistas locales en OmniTracks. Abrir **Conexión remota**, elegir la IPv4 privada del Wi-Fi o Ethernet del portátil y activar el servidor. Usa el puerto TCP 8765 en esa interfaz. Si cambia la IP, apagar el servidor y volver a elegir la interfaz.
2. Escanear **Músicos** para el monitor o **Sonidista** para volumen, paneo, mute (M) y solo (S) por pista. Los móviles usan el navegador de la misma LAN. Si la red tiene aislamiento entre clientes Wi-Fi o el firewall bloquea la entrada, el QR no será accesible desde otro dispositivo.
3. **Expulsar** revoca la sesión del dispositivo y descarta los comandos que sigan en la cola. Un ajuste que ya llegó al reproductor puede terminar de aplicarse. Quien conserve un QR vigente puede volver a emparejarse al escanearlo. Apagar y encender regenera ambos QR y termina todas las sesiones. Los enlaces y cookies funcionan por HTTP en la LAN. Compartir el QR de sonidista solo con su operador.

El servidor admite hasta 16 sesiones simultáneas. Si se llena, un emparejamiento nuevo reutiliza el cupo de la sesión desconectada más antigua. Un dispositivo cuya sesión se reutilizó debe escanear el QR otra vez. El control remoto acepta únicamente pistas del proyecto actual, ganancias de 0 a 3.1623 (−40 a +10 dB, con silencio al fondo, igual que el mezclador local) y paneo de −1 a +1. En Split-Mono, el motor centra el paneo de pista para conservar la separación de las salidas. El teléfono envía la ganancia y el paneo al soltar el control y muestra el estado confirmado por el portátil. El log de Rust incluye resultado y milisegundos hasta el acuse del estado aplicado, incluyendo el siguiente intercambio IPC. Esa cifra no mide la latencia hasta el altavoz.

## Pruebas reproducibles

~~~powershell
cargo test --locked --release --target x86_64-pc-windows-msvc --manifest-path desktop/src-tauri/Cargo.toml --no-default-features
~~~

Las pruebas usan sockets TCP de loopback, sin WebView ni dispositivos físicos. Para comparar Chrome, servir el build web local con este comando.

~~~powershell
npm.cmd run preview -- --host 127.0.0.1 --strictPort
~~~

1. Registrar versión de Windows, Chrome y WebView2, RAM, CPU, interfaz de audio, sample rate, modo Buffer/Streaming y presupuesto de caché. En DevTools de escritorio, pegar desktop/test/probe-runtime.js para probar escritura y lectura de IndexedDB y OPFS en Worker. Registrar el resultado. Que un selector exista en JavaScript no confirma que abra o que sus permisos persistan.
2. En cada perfil, abrir los selectores reales de **archivos** y **carpeta**, seleccionar el mismo material y reproducir. Si falla un selector con handles, comprobar si la importación clásica recupera el flujo. Cerrar y reabrir, volver a seleccionar la canción y confirmar biblioteca, permisos y caché. En streaming, ejecutar window.__streamStats() al inicio y al final y registrar el modo efectivo, los underruns y la actividad de lectura. Verificar el salto de sección cuantizado con reproducción activa.
3. Usar el mismo material de 20 pistas, 15 min y seis canciones en Chrome, Tauri apagado y Tauri con 3–5 teléfonos. Mantener el modo y el ruteo iguales. Registrar CPU y RAM del árbol de procesos por intervalos de 5 s, RAM inicial y final, glitches audibles o grabados, y tiempo desde la transición hasta el primer sonido de la siguiente canción ya preparada. Para el tiempo al sonido, grabar la salida de la interfaz y anotar el disparo en la misma captura.
4. Elegir la interfaz que usará el reproductor. En **Ajustes de reproducción**, activar **Split-Mono** y comprobar ambos canales con la interfaz real. El ruteo previsto es click/guía por L y música por R. El dispositivo y el host se eligen en **Ajustes de audio** de la app (se guardan en `audio_settings.json`; si no hay selección se usa la salida por defecto del host, `WASAPI` por defecto).
5. Repetir el arranque con WAN desconectada y LAN activa. Abrir la app, recuperar el Setlist y reproducir con QR. Durante la canción desconectar WAN, Wi‑Fi y un teléfono en pruebas separadas, y luego reiniciar el router. Anotar si el audio continúa, qué ve cada cliente y si la sesión se recupera. Probar el acceso entrante con la red en perfil Público y Privado según la política del equipo. No desactivar el firewall. Si se necesita una regla temporal, usar solo el ejecutable, el puerto 8765, la subred local y el perfil Privado, con autorización del administrador. [Reglas de Firewall de Windows](https://learn.microsoft.com/en-us/windows/security/operating-system-security/network-security/windows-firewall/rules)
6. Con un perfil Tauri nuevo, abrir Biblioteca y compararla con el navegador de Netlify. Probar la importación de una carpeta con `omnitracks.project.json` (sidecar canónico; el nombre heredado `.omnitracks.json` solo se lee por compatibilidad). El JSON contiene metadatos, pistas descritas, mezcla y secciones. Los blobs, handles y archivos PCM viven aparte y no viajan en ese JSON. Registrar cuánto trabajo hace falta para recuperar la canción y el Setlist.

Para el diagnóstico se conserva DevTools en el ejecutable de PoC. No hay un puerto de depuración activado por la aplicación. La decisión de plataforma se toma con la matriz de INFORME_POC.md y las mediciones del equipo real.
