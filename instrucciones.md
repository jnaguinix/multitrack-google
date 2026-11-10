# OmniTracks

Guía para retomar el proyecto desde otro agente o IDE. OmniTracks reproduce multitracks en directo. El objetivo principal es que el audio siga estable en un portátil modesto, también sin Internet y con teléfonos conectados por LAN.

## Estado del repositorio

- Repositorio [jnaguinix/multitrack-google](https://github.com/jnaguinix/multitrack-google).
- El merge local `fded5ef` integró `poc/tauri-desktop` en `main` conservando los cambios web. `main` puede compilar ambos destinos. Netlify sigue usando el build web.
- Para retomar en otro equipo, usa `main` del repositorio en GitHub. Empieza por `git status --short --branch` y revisa los cambios locales antes de cambiar de rama o preparar un commit.
- Los ejecutables son artefactos locales ignorados. Consulta la [guía de escritorio](desktop/README.md) para generar el instalador NSIS x64 o el ejecutable portátil de diagnóstico.

## Qué hace cada vista

| Vista | Uso |
| --- | --- |
| **Setlist** | Prepara el repertorio. Tiene título compacto, onda coloreada por sección con búsqueda por clic, marcadores y edición, mezcla flotante y orden de reproducción con arrastre. |
| **En vivo** | Opera el set durante la presentación. Tiene reloj grande, una línea de tiempo proporcional con onda de fondo, saltos directos o programados, sección actual y siguiente, y setlist lateral. |
| **Arreglo** | Edita secciones y pistas. |
| **Mezcla** | Ajusta faders locales de −40 a +10 dB, con silencio al fondo y doble clic para volver a 0 dB. El medidor de cada pista tiene su propia escala en dBFS. Lee picos de muestras del analizador mono después del paneo. |
| **Control rápido** | Nombre de la pestaña local antes llamada Remoto. Conserva la ruta `#remote` y reúne información de la canción, saltos y mezcla rápida de la misma ventana. |
| **Conexión remota** | Botón naranja de escritorio que abre el panel LAN. Está después del reloj y el indicador de pulso. En En vivo o sin canción cargada se encuentra en la cabecera. |

## Mapa del código

- `src/App.tsx` coordina proyectos, vistas y transporte. La integración de escritorio se carga con `VITE_LIBRETRACKS_DESKTOP=1` en el origen `https://tauri.localhost`.
- `src/components/SetlistPageView.tsx`, `LiveSetView.tsx`, `StageRemoteView.tsx` y `MultitrackMixer.tsx` implementan las vistas compartidas. Los estilos están en `src/index.css`. `src/utils/songWaveform.ts` combina los picos ya guardados en las pistas.
- `desktop/frontend/RemoteConnectionBridge.tsx` intercambia estado y ajustes con Rust mediante IPC. `desktop/frontend/remoteState.ts` construye el estado y aplica ajustes de mezcla usando el actualizador existente del proyecto.
- `desktop/src-tauri/src/main.rs`, `lan.rs` y `protocol.rs` implementan el shell, el servidor y la validación. `desktop/web/` contiene el HTML, CSS y JavaScript que reciben los teléfonos.
- [Guía de escritorio](desktop/README.md) e [informe del PoC](desktop/INFORME_POC.md) contienen requisitos, pruebas y resultados. El informe refleja la etapa inicial. Usa esta guía para identificar las funciones añadidas después.

## Reglas del PoC y funcionamiento LAN

- Mantén React, TypeScript, Vite y el flujo web de Netlify. Preserva `src/audio/` y `src/storage/` y evita trasladar el motor a Rust. El servidor es opcional, empieza apagado y el audio se reproduce localmente aunque falle la red.
- El panel permite elegir la IPv4 privada, encender el puerto TCP `8765`, copiar o escanear un QR por rol y expulsar dispositivos. Portátil y teléfonos deben estar en la misma LAN de confianza. Cierra cualquier instancia anterior antes de activar el servidor en otro ejecutable.
- **Músicos** usa `/monitor` en solo lectura, con cuenta regresiva, setlist, secciones y saltos. **Sonidista** usa `/mezclador` con volumen, paneo, mute y solo por pista. Los únicos comandos admitidos por ese rol son `setTrackGain`, `setTrackPan`, `setTrackMute` y `setTrackSolo`. La ganancia remota admite valores de 0 a 1 y el paneo de −1 a +1. Split-Mono centra el paneo de pista para separar música y click.
- Mantén la validación del rol, la revisión de pistas, los rangos, el límite de frecuencia y las colas acotadas en el servidor. Los comandos se aplican fuera del scheduler de audio. El puente intercambia como máximo un lote cada 100 ms y toma la lectura de señal solo mientras hay reproducción y un mezclador conectado. El fader táctil envía el ajuste al soltar la bolita.
- Se confirmó en un Android que el navegador necesitaba el permiso **Dispositivos cercanos** o **Red local**. El panel muestra el aviso junto a los QR. Si se rechazó el permiso, revisar los ajustes del navegador en Android y volver a abrir el QR.
- El instalador NSIS incluye WebView2 para la instalación sin Internet. La compilación de publicación incluye la clave pública del actualizador. El operador busca, descarga e instala versiones firmadas desde la app con el transporte y el servidor LAN detenidos. Falta validar el audio en el portátil real antes de publicar.

## Compilar y validar

Desde la raíz en PowerShell, con Node.js, Rust MSVC, Build Tools de C++ y WebView2 configurados según el [README de escritorio](desktop/README.md).

```powershell
npm.cmd install --legacy-peer-deps --no-package-lock
npm.cmd run lint
npm.cmd run build
npm.cmd ci --prefix desktop
npm.cmd --prefix desktop run build
cargo test --locked --release --target x86_64-pc-windows-msvc --manifest-path desktop/src-tauri/Cargo.toml --no-default-features
```

El build web genera `dist/`. El build Tauri incrusta `desktop/dist/` y escribe el ejecutable bajo `desktop/src-tauri/target/` o en el directorio que indique `CARGO_TARGET_DIR`.

## Qué falta comprobar

- Hubo builds de web y Windows x64, pruebas automatizadas del protocolo LAN y pruebas de interfaz con WAV sintéticos. Se verificaron importación y reproducción corta en WebView2, OPFS en Worker e IndexedDB. Los resultados y límites están en el [informe del PoC](desktop/INFORME_POC.md).
- Queda pendiente la comparación con el equipo real del baterista. Probar las mismas 20 pistas durante 15 minutos en Chrome y Tauri, con el servidor apagado y con 3–5 celulares, y anotar CPU, RAM, glitches y `window.__streamStats()`. Completar también las pruebas de interfaz física y Split-Mono, persistencia, selectores de archivos y carpeta, arranque sin Internet y perfiles del firewall.
- Registrar como **no medido** todo caso sin evidencia. Antes de usar APIs u opciones nuevas de Tauri v2, contrastarlas con la [documentación oficial](https://v2.tauri.app/).
