# Documento de Diseño: Motor de Audio Nativo para OmniTracks (Fase 0 - Revisión 3 - Aprobado para Fase 1)

## 0. Estado del Documento
Este documento es la especificación técnica completa y definitiva para la implementación del motor nativo en Rust para OmniTracks escritorio (Windows x64 sobre Tauri v2). Cumple con todas las directrices del documento `PROMPT_MOTOR_NATIVO.md` y resuelve los bloqueantes y decisiones de arquitectura requeridas para la Fase 0.

---

## 1. Arquitectura de Transporte: Saltos, Vamp, Seek y Click (Mecanismo Completo)

En un motor de audio en tiempo real con búferes circulares lock-free (`rtrb`), **el callback de audio de la tarjeta de sonido no puede leer archivos en disco ni reiniciar punteros de lectura**. El callback es estrictamente un consumidor lineal de memoria continua.

El mecanismo de control de transporte se diseña con una separación estricta de responsabilidades entre hilos:

```
[Hilo de Control / Comandos Tauri]
   │  Comandos (Seek, QueueJump, Vamp, Pitch)
   ▼
[Hilo I/O (Lector de Disco)]
   │  Lectura desacoplada de disco en bloques grandes
   ▼  (Ring Buffer PCM crudo: >= 5 s de antelación)
[Hilo Feeder (Remuestreo rubato & Empalmes)]
   │  Decisión de corte y empalme en tiempo de canción
   │  Remuestreo sinc / varispeed con compensación de retardo
   ▼  (rtrb: >= 500 ms configurable)
[Callback de Audio (CPAL / Tarjeta)]
   ├─ Conteo de frames de hardware a 64 bits
   ├─ Mezcla lineal y ruteo a salidas físicas
   ├─ Síntesis de metrónomo a la muestra exacta
   └─ Micro-crossfades y descarte en saltos inmediatos / límite encolado
```

### 1.1 Hilo que decide y ejecuta el empalme
- **El hilo Feeder (hilo de remuestreo)** es el responsable de decidir y ejecutar los empalmes de audio entre secciones o bucles de vamp.
- **Dominio de tiempo de canción:** El feeder trabaja en muestras de tiempo de canción (`song_sample_cursor` a la frecuencia nativa de cada pista).
- Detecta cuándo el cursor alcanza el final de una sección en modo vamp o un punto de corte de salto cuantizado, lee el destino desde el búfer de entrada desacoplado de disco, ejecuta el micro-crossfade de 8 ms directamente sobre las muestras en tiempo de canción, y posteriormente envía el flujo continuo resultante a través del remuestreador `rubato` hacia el búfer circular.
- Para el callback de audio, el flujo entrante en el búfer circular es **completamente transparente, lineal y continuo**, sin discontinuidades de fase ni huecos.

### 1.2 Búferes circulares y márgenes de lectura
- **Búfer circular (`rtrb`) después del remuestreo:**
  - Capacidad mínima de **al menos 500 ms** (configurable por el usuario o perfil de hardware, ej. 24.000 frames estéreo a 48 kHz).
  - Nivel operativo objetivo: el feeder mantiene el búfer lleno entre **350 ms y 450 ms** de audio remuestreado listo.
  - *Razón técnica:* En vivo, el feeder es un hilo de usuario de Windows sujeto a concurrencia y cambios de contexto. Un búfer de 100 ms es insuficiente para garantizar cero underruns bajo carga extrema del sistema operativo. 500 ms garantiza estabilidad absoluta sin poner en riesgo la latencia de saltos.
- **Lectura de disco en un hilo separado del remuestreo (Desacoplamiento I/O):**
  - La lectura de archivos PCM en disco se realiza en un hilo I/O dedicado, completamente separado del remuestreo `rubato`.
  - Mantiene al menos **5 segundos** de PCM crudo por adelantado en un búfer circular intermedio por pista.
  - *Razón técnica:* Una lectura lenta de disco (discos externos USB, unidades mecánicas o contención de I/O) no detiene el llenado del remuestreador ni compromete el callback de audio.
- **Dimensionamiento final de búferes:**
  - Los tamaños y márgenes finales (ms de ring buffer post-remuestreo y segundos de lookahead de disco) **se calibrarán empíricamente con la prueba de carga de 20 pistas estéreo simultáneas** (Sección 6), no por estimación teórica.

### 1.3 Ejecución de saltos "1-bar" / "section-end" vs. "immediate"
- **Salto programado cuantizado ("1-bar" o "section-end"):**
  1. La interfaz solicita el salto con anterioridad.
  2. El feeder calcula la muestra de transición exacta en tiempo de canción (`transition_song_sample = target_bar * samples_per_bar`).
  3. **Caso A (El límite está en el futuro respecto a lo ya encolado):** Al llegar a dicha muestra en el flujo de lectura, el feeder empalma con el inicio de la sección destino aplicando un micro-crossfade de 8 ms. El búfer circular se llena de forma continua. Cero silencio, cero retardo.
  4. **Caso B (El límite ya cayó dentro de los ~500 ms de audio ya encolado en el búfer circular):** Si el usuario solicita un salto cuantizado justo antes del compás pero el audio de ese compás ya fue pre-renderizado y encolado en el búfer de 500 ms, **se adopta la ruta de descarte del salto inmediato**:
     - Se genera un nuevo `stream_epoch`.
     - El callback descarta el audio posterior al límite exacto con micro-fade de 8 ms.
     - El feeder reposiciona su lectura y remuestreo exactamente al inicio de la sección destino solicitada.
     - De esta manera, el salto entra en el compás solicitado en lugar de retrasarse un compás entero adicional.
- **Salto inmediato ("immediate") y Seek manual:**
  - En `rtrb`, **únicamente el consumidor (el callback de audio) tiene permiso para descartar datos**. El productor (feeder) no puede borrar lo que ya encoló.
  - Para lograr respuesta inmediata sin clics:
    1. El hilo de control genera un nuevo `stream_epoch: u32` y envía un comando atómico `FlushAndSeek { epoch, target_sample }` a través de una cola SPSC de comandos hacia el callback de audio, y simultáneamente al feeder.
    2. Al recibir el comando en el callback, este aplica inmediatamente una rampa de atenuación a silencio de 8 ms (`fadeOut`), lee y descarta todos los frames pendientes en el ring buffer (`consumer.read_chunk(...)` ignorado), y queda a la espera de audio con el nuevo `epoch`.
    3. En paralelo, el feeder recibe el comando, reinicia su cursor en disco a `target_sample`, reinicia los estados internos del remuestreador `rubato`, compensa el retardo del filtro y genera los primeros 100 ms de audio del destino empujándolos al ring buffer.
    4. El callback recibe los nuevos frames y aplica un micro-fade-in de 8 ms.
    - *Búferes de reserva (Jump Reserve Buffers):* Para eliminar cualquier latencia de lectura de disco en saltos inmediatos entre secciones marcadas, el feeder mantiene en memoria intermedia los primeros 100 ms pre-decodificados de cada sección del proyecto. Ante un salto inmediato, inyecta este búfer pre-llenado de inmediato al ring buffer.

### 1.4 Cálculo y reporte de posición exacta con cambio de tono (Varispeed) y frecuencias mixtas
- El callback de audio mantiene un contador atómico de frames físicos de hardware renderizados: `device_frames_rendered: AtomicU64`.
- Relación matemática de conversión a tiempo de canción:
  $$\text{song\_time\_sec} = \text{anchor\_song\_sec} + \frac{\text{device\_frames\_rendered} - \text{anchor\_device\_frame}}{f_{\text{device}} \cdot r}$$
  Donde:
  - $f_{\text{device}}$ es la frecuencia de muestreo de la tarjeta de sonido (ej. 48.000 Hz).
  - $r = 2^{(\text{pitchSemitones} / 12)}$ es el factor de velocidad varispeed.
  - $\text{anchor\_song\_sec}$ y $\text{anchor\_device\_frame}$ son los puntos de anclaje sincronizados.
- Al cambiar `pitchSemitones` durante la reproducción, los anclajes se actualizan atómicamente:
  $\text{anchor\_song\_sec} = \text{current\_song\_time\_sec}$, $\text{anchor\_device\_frame} = \text{current\_device\_frame}$. De esta forma, la posición del cabezal no sufre ningún salto abrupto.

### 1.5 Click metrónomo sincronizado y acelerado por Varispeed
- El generador de click en Rust calcula los pulsos en el dominio del tiempo de canción (equivalente a `scheduleClicksInSongWindow` en `audioEngine.ts:2326-2401`).
- Dado que el cálculo ocurre en tiempo de canción, **el click se acelera o desacelera automáticamente de forma exacta con el varispeed ($r$)**.
- Frecuencias tonales y envolventes idénticas a `audioEngine.ts:2430-2445`:
  - **Primer pulso del compás (Downbeat):** Onda triangular de 1680 Hz con descenso exponencial a 820 Hz en 35 ms (amplitud máxima: $\text{clickGain} \times 0.55$).
  - **Pulsos principales de negra (Quarterbeat):** Onda senoidal de 1120 Hz con descenso a 540 Hz en 35 ms (amplitud máxima: $\text{clickGain} \times 0.36$).
  - **Pulsos de subdivisión de corchea:** Onda senoidal de **840 Hz** con descenso a 540 Hz en 35 ms (amplitud máxima: $\text{clickGain} \times 0.18$).
  - Envolvente de ataque lineal de 2 ms y decaimiento exponencial de 40 ms a silencio para evitar clics de continua.

### 1.6 Alineación y compensación de retardo del remuestreador (`rubato`)
- Los remuestreadores basados en interpolación sinc y filtros FIR (como `rubato::FftFixedInOut` o `SincFixedIn`) introducen intrínsecamente un retardo de grupo (*group delay* / *filter latency*), reportado por la API de `rubato` mediante `output_delay()`.
- Si este retardo no se compensa, las pistas de audio remuestreadas sonarían unos pocos milisegundos por detrás del metrónomo sintético generado en el callback, y pistas con distintas frecuencias de origen tendrían retardos diferentes.
- **Mecanismo de compensación:**
  1. Al inicializar o reiniciar el remuestreador para cada pista, se consulta el retardo exacto de muestras: `delay = resampler.output_delay()`.
  2. En el arranque de la reproducción o tras un seek, el feeder pre-alimenta ceros o muestras de margen en el remuestreador y descarta exactamente las primeras `delay` muestras de salida (*warmup trim*).
  3. A partir de ese punto, la primera muestra entregada al búfer circular corresponde estrictamente a la muestra $t = 0$ (o a la muestra destino del seek).
  4. Todas las pistas activas (independientemente de si su origen es 44.1 kHz, 48 kHz o cualquier ratio de varispeed) quedan alineadas fase con fase entre sí y con los clicks sintéticos del callback a $\pm 1$ muestra.

---

## 2. Interfaz `AudioEngineApi`: Los 39 Métodos Consumidos por la UI

Se examinaron todos los accesos `audioEngine.*` en `src/` y `desktop/frontend/`. Existen exactamente 39 métodos o propiedades accedidas por la interfaz. Para que el proyecto compile sin errores de tipado, todos deben estar tipados en `AudioEngineApi` o adaptados según se detalla a continuación.

| # | Método / Propiedad | Archivos donde se llama | Categoría | Comportamiento en `nativeEngine.ts` (Escritorio) |
|---|---|---|---|---|
| 1 | `cancelQueuedJump` | `src/App.tsx` | En la interfaz | Llama al comando IPC `audio_cancel_jump`. |
| 2 | `clearProjectFallback` | `src/App.tsx` | En la interfaz | No-op. En nativo no existe degradación por fallback a Web Audio. |
| 3 | `decodeStemBuffer` | `src/App.tsx` | Opcional | Exclusivo de Web Audio en navegador. En escritorio no se llama (ver flujo de importación abajo). Retorna Promise rechazada si se invoca por error. |
| 4 | `evictSongFromRamCache` | `src/App.tsx` | En la interfaz | En nativo, libera la memoria intermedia de precarga del feeder para dicha canción. |
| 5 | `getCachedProjectBuffers` | `src/App.tsx` | En la interfaz | Devuelve `undefined`. En escritorio el audio no se almacena en `Map<string, AudioBuffer>`. |
| 6 | `getEffectiveEngineModeForProject` | `src/components/SetlistPageView.tsx` | En la interfaz | Devuelve `'stream'` (la UI muestra el distintivo de reproducción desde disco). |
| 7 | `getEngineMode` | `src/App.tsx` | En la interfaz | Devuelve `'stream'`. |
| 8 | `getGlobalStreamStats` | `src/audio/audioEngine.ts` | Opcional | Devuelve las métricas de underruns y rendimiento recolectadas desde Rust vía `audio_get_stats`. |
| 9 | `getProjectPcmEstimatedMB` | `src/components/LibraryAndModals.tsx`, `src/components/SetlistPageView.tsx` | En la interfaz | Calcula la estimación de tamaño de archivo PCM en disco: $\text{frames} \times \text{canales} \times 2 \text{ bytes}$. |
| 10 | `getRamBudgetMB` | `src/App.tsx` | En la interfaz | Devuelve `0` o valor neutral (en escritorio no hay límite de presupuesto de RAM Web Audio). |
| 11 | `getSongRamCacheInfo` | `src/App.tsx`, `src/components/LiveSetView.tsx`, `src/components/SetlistPageView.tsx` | En la interfaz | Devuelve `{ isReady: true, cachedCount: total, totalCount: total }` si el proyecto tiene caché PCM completa en disco. |
| 12 | `getTotalCachedMB` | `src/App.tsx` | En la interfaz | Devuelve el tamaño en MB ocupado por los búferes circulares de streaming activos (~15 MB). |
| 13 | `getTotalDurationSec` | `src/App.tsx` | En la interfaz | Devuelve la duración máxima en segundos de las pistas cargadas en el motor nativo. |
| 14 | `getTrackMeters` | `src/components/MultitrackMixer.tsx`, `src/components/TimelineArranger.tsx`, `desktop/frontend/RemoteConnectionBridge.tsx` | En la interfaz | **Síncrono.** Devuelve la última instantánea `MetersSnapshot` (con `rms: 0..1`, `peak: 0..1` y `clipping: bool`) recibida en caché local desde Rust. |
| 15 | `getTransportState` | `desktop/frontend/RemoteConnectionBridge.tsx` | En la interfaz | **Síncrono.** Devuelve el último `TransportState` interpolado localmente a 60 fps. |
| 16 | `hasFullProjectInCache` | `src/App.tsx` | En la interfaz | Devuelve si el proyecto tiene sus archivos PCM listos en disco (`isProjectPcmReady(project)`). |
| 17 | `hasPlayableAudio` | `src/App.tsx` | En la interfaz | Devuelve `true` si el proyecto activo tiene pistas con PCM válido listo para streaming. |
| 18 | `isProjectPcmReady` | `src/App.tsx`, `src/components/LibraryAndModals.tsx`, `src/components/LiveSetView.tsx`, `src/components/SetlistPageView.tsx` | En la interfaz | Comprueba si todas las pistas tienen metadatos PCM completos en el modelo del proyecto. |
| 19 | `loadProject` | `src/App.tsx` | En la interfaz | Llama a `audio_load_project` en Rust y retorna `{ peaksMap, wasCancelled: false }`. |
| 20 | `logStreamMetrics` | `src/audio/audioEngine.ts` | Opcional | Registra en consola las estadísticas del motor nativo. |
| 21 | `mountDecodedTrack` | `src/App.tsx` | Opcional | Exclusivo de decodificación Web Audio. En escritorio la carga la hace el feeder directamente desde el archivo `.pcm`. |
| 22 | `play` | `src/App.tsx` | En la interfaz | Llama a `audio_play`. |
| 23 | `preloadProject` | `src/App.tsx` | En la interfaz | Llama a `audio_preload_project` para pre-abrir y llenar buffers de la siguiente canción. |
| 24 | `prepareProjectShell` | `src/App.tsx` | En la interfaz | Prepara el estado interno local de la canción inmediatamente en `nativeEngine.ts`. |
| 25 | `queueSectionJump` | `src/App.tsx` | En la interfaz | Llama a `audio_queue_jump(sectionId, quantizeMode)`. |
| 26 | `removeTrack` | `src/App.tsx` | En la interfaz | Llama a `audio_remove_track(trackId)` para cerrar feeder de dicha pista. |
| 27 | `seekToSeconds` | `src/App.tsx` | En la interfaz | Llama a `audio_seek(seconds)`. |
| 28 | `setEngineMode` | `src/App.tsx` | En la interfaz | No-op. En escritorio el motor nativo está siempre activo. |
| 29 | `setOnNotice` | `src/App.tsx` | En la interfaz | Registra el callback para recibir avisos del motor. |
| 30 | `setOnSongEnded` | `src/App.tsx` | En la interfaz | Registra el callback invocado cuando la canción llega al final. |
| 31 | `setPriorityProjectIds` | `src/App.tsx` | En la interfaz | Configura en Rust los IDs de canciones para retención de buffers (activa + siguiente). |
| 32 | `setRamBudgetMB` | `src/App.tsx` | En la interfaz | No-op en escritorio. |
| 33 | `stop` | `src/App.tsx` | En la interfaz | Llama a `audio_stop`. |
| 34 | `storeProjectBuffersInRamCache` | `src/App.tsx` | Opcional | No-op en escritorio. |
| 35 | `subscribe` | `src/App.tsx` | En la interfaz | Suscribe un listener a cambios de transporte emitidos por el motor. |
| 36 | `subscribeCache` | `src/App.tsx` | En la interfaz | Suscribe a eventos de actualización de disponibilidad de archivos PCM. |
| 37 | `togglePlayPause` | `src/App.tsx` | En la interfaz | Alterna entre reproducir y pausar llamando a Rust. |
| 38 | `toggleVamp` | `src/App.tsx` | En la interfaz | Llama a `audio_toggle_vamp`. |
| 39 | `updateProjectConfig` | `src/App.tsx` | En la interfaz | Envía a Rust las ganancias, paneos, mute, solo, bus y ruteo actualizados. |

### 2.1 Cómo cambia el flujo de importación en `App.tsx` para Escritorio
Hoy en el navegador, `handleInstantImportFiles` en `src/App.tsx:880-1185` ejecuta un proceso pesado en JavaScript:
1. Inspecciona cabeceras WAV en JS (`parseWavHeaderFast`).
2. Guarda los blobs en IndexedDB (`saveStemsBatchToDb`).
3. En la Fase 2, abre un bucle de 4 pistas en paralelo decodificando en el hilo principal o workers (`decodeStemBuffer`), monta los `AudioBuffer` en memoria (`mountDecodedTrack`), extrae los picos y los escribe en OPFS vía `pcmOptimizer`.

**Nuevo flujo en Escritorio (Nativo):**
1. El usuario selecciona archivos o carpetas usando `tauri-plugin-dialog`. La app recibe rutas absolutas reales (`C:\Stems\Cancion\Pista.wav`).
2. `App.tsx` detecta que está en escritorio y llama al comando Tauri `audio_import_tracks(projectId, filesWithAbsolutePaths)`.
3. **Rust asume todo el trabajo pesado en segundo plano:**
   - Lee los archivos en hilos nativos sin tocar la memoria del WebView2 ni pasar grandes buffers por el puente IPC.
   - Decodifica usando `symphonia` (hasta 3 pistas simultáneas según CPU).
   - Detecta si es mono o efectivamente mono (`isEffectivelyMono`).
   - Aplica TPDF dither si el origen es $> 16$ bits.
   - Escribe el archivo `{trackId}.pcm` y `{trackId}.json` con sus 320 picos calculados.
   - Emite eventos `audio://import-progress` a la interfaz.
4. Al terminar, Rust retorna los metadatos completos (`peaks`, `durationSec`, `channels`, `sampleRate`) a TypeScript.
5. `App.tsx` simplemente actualiza el registro en IndexedDB y monta la canción en el motor nativo con `audio_load_project`.
6. `decodeStemBuffer`, `mountDecodedTrack`, `prepareProjectShell` y `pcmOptimizer` quedan **100% aislados para la versión web**, liberando al escritorio de consumo innecesario de RAM y CPU en el WebView2.

---

## 3. Política de Arrastrar y Soltar (Drag and Drop)

- **Decisión:** `"dragDropEnabled": false` se mantiene intacto en `tauri.conf.json`.
- **Razón técnica:** Habilitar `dragDropEnabled: true` en Tauri intercepta a bajo nivel todos los eventos de arrastre del sistema operativo sobre la ventana del WebView2, lo que **rompe el sistema de arrastrar y soltar interno de HTML5** (el reordenamiento de tarjetas de canciones en el Setlist, el arrastre de temas desde la barra de repertorio hacia el setlist y los controles deslizantes del reproductor).
- **Flujo de importación en escritorio:** La importación de canciones y pistas en escritorio se realizará exclusivamente a través de los selectores nativos de archivos y carpetas (`tauri-plugin-dialog`), preservando la integridad del manejo táctil y de ratón del Setlist.

---

## 4. Decisiones de Dispositivos, Drivers y Salidas

### 4.1 WASAPI: Exclusión de Modo Exclusivo
- Tras la verificación técnica de `cpal 0.18.2` en Windows, se constató que la implementación de WASAPI en `cpal` inicializa las corrientes en **Modo Compartido (Shared Mode)** por diseño. El Modo Exclusivo no está implementado ni expuesto en su API pública multiplataforma.
- Por tanto, **se elimina el Modo Exclusivo del diseño**.
- El selector de frecuencia de muestreo mostrará **únicamente** la frecuencia de muestreo que el dispositivo tenga configurada y reportada en Windows (obtenida mediante `device.default_output_config()` y `device.supported_output_configs()`). Si Windows está configurado a 48.000 Hz, la app trabajará nativamente a 48.000 Hz y remuestreará los stems mediante `rubato`.

### 4.2 Visualización en Pantalla de los Casos A, B y C
En la pantalla de Ajustes de Audio de escritorio:
- **Caso A (Dispositivo Multicanal Unificado, $\ge 4$ canales):**
  - Muestra el nombre de la interfaz y la lista completa de canales físicos disponibles (ej. 1 al 8).
  - Permite asignar salidas estéreo o mono independientes para Main L/R, Click, Guía y salidas individuales por pista.
- **Caso B (Dispositivos Estéreo Separados en Windows, ej. "Out 1/2", "Out 3/4"):**
  - Cada par estéreo aparece como un dispositivo WASAPI independiente en la lista.
  - La interfaz muestra una advertencia informativa:
    > *⚠️ Esta interfaz expone sus salidas como dispositivos separados en Windows. Por WASAPI solo es posible utilizar un par estéreo a la vez. Para desbloquear todas las salidas simultáneas y rutear en vivo, utiliza el driver ASIO del fabricante.*
- **Caso C (Dispositivo de 2 Canales - Tarjeta Integrada o Interfaz Básica):**
  - Muestra Salidas 1 y 2.
  - Oculta el selector multicanal y ofrece automáticamente el interruptor **Modo Split-Mono** (Canal 1: Click y Guía · Canal 2: Pistas del grupo Main).

### 4.3 Manejo de Desconexión del Dispositivo (Hotplug / Unplug)
1. **Detección en el Callback:** En `cpal`, la corriente se construye con un callback de error:
   ```rust
   err_fn: move |err| {
       // cpal::StreamError::DeviceNotAvailable o fallo de endpoint
       handle_stream_error(err);
   }
   ```
2. **Acción inmediata en Rust:** Al dispararse un error de desconexión:
   - El motor detiene el feeder y el temporizador de transporte.
   - Almacena la última posición exacta: `pausedSongSec = current_song_time_sec`.
   - Marca `isPlaying = false`.
   - Emite el evento Tauri `audio://device-lost`.
3. **Respuesta en la Interfaz:**
   - La barra de transporte pasa a estado Pausa en el segundo exacto donde ocurrió la desconexión.
   - Muestra un banner/toast modal: *"Dispositivo de audio desconectado. Conéctalo nuevamente o selecciona otra salida en Ajustes de Audio."*
4. **Reapertura y Restauración:**
   - Cuando el usuario reconecta la tarjeta o elige un dispositivo de respaldo en la ventana de ajustes, el motor reabre la corriente de audio y reanuda el estado en `pausedSongSec`, permitiendo continuar el servicio sin reiniciar la app ni perder la posición en el setlist.

### 4.4 Almacenamiento de la Configuración de Audio y Ruteo Global
- Se almacena de manera persistente en un archivo JSON en la carpeta de configuración local de la aplicación:
  `{AppLocalDataDir}/audio_settings.json`
- Estructura:
  ```json
  {
    "host": "WASAPI",
    "deviceName": "Focusrite USB Audio",
    "sampleRate": 48000,
    "bufferSize": 256,
    "routing": {
      "mainBus": [0, 1],
      "cueBus": [2, 3],
      "splitMono": false
    }
  }
  ```
- Al iniciar la app en escritorio, Rust lee este archivo y restaura automáticamente el dispositivo y el ruteo sin intervención del usuario.

### 4.5 Guía Hablada (Cues)
- **Decisión adoptada:** **Opción A**.
- El tono/chime de aviso de sección se sintetiza en Rust y se mezcla en el bus de Guía / Cue (canales 3/4).
- La voz humana se genera mediante `window.speechSynthesis` en el navegador.
- **Protección en Ruteo Multicanal:** Cuando el ruteo multicanal está activo (tarjetas con $\ge 4$ salidas), la voz de la guía se desactiva por defecto en los proyectos importados (`guideVoiceReadout: false`) y se muestra un aviso explicativo en la configuración:
  > *ℹ️ La voz de la guía hablada se emite por el dispositivo de audio predeterminado de Windows. Para monitores in-ear en consolas multicanal, se recomienda utilizar el tono de guía (chime) ruteado al bus Cue.*
- La **Opción C** (banco de muestras de audio pregrabadas para presets estándar) se reserva para una fase futura de mejoras.

### 4.6 Selector de Archivos y Permisos
- Se utilizará el plugin oficial de Tauri v2: **`tauri-plugin-dialog`**.
- **Permisos requeridos:** En `desktop/src-tauri/capabilities/desktop-remote.json` (o capability dedicada `desktop-audio.json`), se añade:
  ```json
  "permissions": [
    "dialog:allow-open"
  ]
  ```
- Esto permite invocar `open({ multiple: true, directory: false })` para archivos de audio y `open({ directory: true })` para carpetas completas, obteniendo directamente rutas absolutas válidas de Windows.

---

## 5. Medidores de Nivel e Interpolación de Posición

### 5.1 Formato de Medidores (`MetersSnapshot`)
Los medidores calculados por el motor nativo mantendrán exactamente el formato que consume la interfaz actual (`src/types/project.ts:106-116`):
- Valores lineales normalizados de **0.0 a 1.0** (amplitud RMS y pico de muestras):
  ```typescript
  export interface TrackMeterReading {
    rms: number; // 0.0 a 1.0 (amplitud cuadrática media)
    peak: number; // 0.0 a 1.0 (amplitud máxima absoluta)
    clipping: boolean; // true si peak >= 0.999
  }
  export interface MetersSnapshot {
    tracks: Record<string, TrackMeterReading>;
    master: TrackMeterReading;
  }
  ```
- No se transformarán a dBFS en Rust; la interfaz de usuario existente (`MultitrackMixer.tsx` y `TimelineArranger.tsx`) aplica sus propias fórmulas visuales sobre este valor lineal normalizado.

### 5.2 Interpolación de Posición a 60 fps en `nativeEngine.ts`
Rust emite el evento `audio://transport-tick` cada 50 ms (~20 fps) para no sobrecargar el puente IPC. Para evitar que el cabezal de reproducción y el minutero en pantalla se observen a tirones o saltos:
- `nativeEngine.ts` almacena localmente cada tick recibido junto con un timestamp de alta resolución:
  ```typescript
  let lastAnchorSec = 0;
  let lastAnchorTimeMs = performance.now();
  let isPlaying = false;
  let playbackRate = 1.0;
  ```
- Cuando la UI consulta `getTransportState()` síncronamente en cada frame de animación (`requestAnimationFrame` a 60 o 120 fps):
  $$\text{currentSec} = \text{lastAnchorSec} + \frac{\text{performance.now()} - \text{lastAnchorTimeMs}}{1000} \times \text{playbackRate}$$
- Esto garantiza un desplazamiento visual perfectamente suave en la forma de onda y el minutero, sin latencia ni jitter.

### 5.3 Precarga de Canciones
- Se elimina la cifra tentativa "< 5 ms". Se define formalmente como:
  **"Objetivo no medido: cambio de canción sin latencia perceptible mediante ring buffers prellenados en memoria"** (a verificar y medir instrumentalmente en la Fase 4).

---

## 6. Plan de Pruebas Unitarias y de Integración sin Tarjeta de Sonido (Fase 1 a 5)

Todas las pruebas lógicas y de procesamiento de audio se ejecutarán en `cargo test --manifest-path desktop/src-tauri/Cargo.toml --no-default-features` mediante un sumidero virtual en memoria (`MockAudioSink`), garantizando que corran en cualquier entorno de integración continua sin requerir hardware de audio físico:

1. **`test_sample_accurate_alignment`:**
   Carga 8 pistas sintéticas con impulsos unitarios exactamente en la muestra 480. Renderiza 1.000 frames en un buffer de memoria y verifica que los picos de las 8 pistas coinciden exactamente en el frame 480 (cero desalineación inter-canal).
2. **`test_quantized_jump_sample_accuracy`:**
   Simula una reproducción a 120 BPM con compás 4/4 (24.000 frames por compás a 48 kHz). Programa un salto de sección para el compás 3 (`sample 72.000`). Verifica que el primer frame de la sección destino se emite exactamente en la muestra 72.000.
3. **`test_vamp_gapless_loop`:**
   Configura una sección en bucle de 4 compases. Renderiza 3 repeticiones consecutivas y comprueba la continuidad de la señal en los puntos de cruce, verificando la ausencia de silencios de amplitud cero o saltos de discontinuidad mayores al micro-fade de 8 ms.
4. **`test_mute_solo_exactness`:**
   Verifica que una pista en estado `muted = true` entrega exactamente ceros (silencio digital). Activa `soloed = true` en una pista y verifica que todas las demás pistas no-soloed se silencian al 100%.
5. **`test_routing_assignment_and_fallback`:**
   Configura una pista con salida asignada al canal 3. Verifica que las muestras aparecen en la columna 3 del buffer multicanal. Configura una pista con salida al canal 15 en un dispositivo simulado de 4 canales y comprueba que se degrada de forma segura a los canales 0 y 1 emitiendo un aviso.
6. **`test_resampling_pitch_duration`:**
   Procesa una pista PCM originada a 44.100 Hz con una duración nominal de 10.000 segundos a través de una corriente de salida simulada a 48.000 Hz. Verifica que la duración en segundos calculada tras el remuestreo con `rubato` es idéntica a la duración original con un error menor a $\pm 1$ muestra.
7. **`test_metronome_frequencies_and_subdivision`:**
   Verifica mediante transformada de Fourier rápida (FFT) que el tono del downbeat contiene su fundamental en 1680 Hz, los pulsos de negra en 1120 Hz, y la subdivisión de corchea en 840 Hz.
8. **Prueba de Carga (Benchmark de 20 Pistas):**
   Renderiza 20 pistas estéreo de 15 minutos en memoria continua midiendo tiempo de procesamiento, consumo de memoria y verificando cero eventos de buffer vacío para fijar los tamaños definitivos de búfer post-remuestreo y lookahead I/O.
9. **`test_click_alignment_pitch_zero` (Fase 4):**
   Verifica con compensación de retardo sinc que el primer click del metrónomo cae exactamente a $\pm 1$ muestra del transitorio (impulso unitario) de una pista de audio de referencia con pitch 0.
10. **`test_click_alignment_pitch_non_zero` (Fase 4):**
   Verifica que con varispeed activo (ej. +2 semitonos o -3 semitonos) y compensación de retardo dinámica, el click cae a $\pm 1$ muestra del transitorio de la pista de referencia acelerada/desacelerada.
11. **`test_resampled_click_alignment_44k_to_48k` (Fase 4):**
   Verifica que una pista originada a 44.100 Hz reproducida en un dispositivo a 48.000 Hz mantiene su transitorio perfectamente alineado con el click generado a 48.000 Hz con una desviación máxima de $\pm 1$ muestra.
12. **`test_mixed_sample_rate_tracks_alignment` (Fase 4):**
   Carga dos pistas sintéticas con impulsos sincronizados, una grabada a 44.100 Hz y otra a 48.000 Hz. Tras pasar por sus respectivos remuestreadores con compensación de retardo hacia la salida de 48.000 Hz, verifica que ambos impulsos coinciden en la misma muestra a $\pm 1$ muestra de tolerancia entre sí.

---

## 7. Referencias Exactas de Línea en `src/audio/audioEngine.ts`

Verificadas en el archivo actual del repositorio:

- `play`: línea 1799
- `pause`: línea 1852
- `stop`: línea 1902
- `togglePlayPause`: línea 1890
- `seekToSeconds`: línea 1940
- `queueSectionJump`: línea 1994
- `cancelQueuedJump`: línea 2056
- `toggleVamp`: línea 2063
- `FADE_DURATION_SEC` (8 ms): línea 29
- `updateProjectConfig`: línea 1383
- `applyMixerRouting`: línea 1622
- `scheduleMetronomeClickAt`: línea 2420 (Downbeat: 1680 Hz, Quarterbeat: 1120 Hz, Subdivisión: 840 Hz)
- `TriggerGuideCue`: línea 2467 (Tonos de 587.33 Hz y 880 Hz; SpeechSynthesis en línea 2498)
- `getPlaybackRate` / `pitchSemitones`: línea 1358
- `setOnSongEnded`: línea 162
- `preloadProject`: línea 979
- `setPriorityProjectIds`: línea 522
- `getTransportState`: línea 2535
- `getTrackMeters`: línea 2572
- `setOnNotice`: línea 1874
- `getGlobalStreamStats`: línea 248

---

## 8. Formato y Jerarquía de Caché PCM por Frecuencia de Dispositivo (Fase 2)

### 8.1 Estructura en Disco
Para evitar cualquier remuestreo en tiempo real durante la reproducción en vivo con tono normal (`pitchSemitones == 0`), los stems de audio se decodifican y almacenan en disco a la frecuencia de muestreo nativa del dispositivo de salida configurado en Windows (por ejemplo, 48.000 Hz):

- **Ruta del PCM crudo:**
  `{AppLocalDataDir}/pcm/{projectId}/{sampleRate}/{trackId}.pcm`
  - Formato: PCM lineal crudo (Headerless raw PCM).
  - Canales: 1 canal (mono / efectivamente mono) o 2 canales (estéreo entrelazado L/R).
  - Profundidad de bits: Entero con signo de 16 bits (`i16` little-endian, 2 bytes por muestra) con tramado TPDF (Triangular Probability Density Function dither) aplicado durante la reducción de precisión desde fuentes de 24/32 bits, o `f32` IEEE-754 según preferencia del perfil de rendimiento.
  - Escritura atómica: Se escribe primero como `{trackId}.pcm.tmp` y al concluir la escritura y verificación de suma de verificación o longitud de frames, se renombra de manera atómica a `{trackId}.pcm`.

- **Ruta de Metadatos de Pista:**
  `{AppLocalDataDir}/pcm/{projectId}/{sampleRate}/{trackId}.json`
  - Contenido:
    ```json
    {
      "formatVersion": 1,
      "trackId": "stem-drums-123",
      "targetSampleRate": 48000,
      "originalSampleRate": 44100,
      "originalChannels": 2,
      "channels": 1,
      "isEffectivelyMono": true,
      "frameCount": 11520000,
      "durationSec": 240.0,
      "peaks": [0.12, 0.45, 0.88, ...],
      "createdAt": "2026-11-10T16:30:00Z"
    }
    ```
  - `peaks`: Array exactamente de 320 valores normalizados de 0.0 a 1.0 (equivalente exacto a `extractWaveformPeaks` de la aplicación web), permitiendo al canvas de la forma de onda dibujar el stem de inmediato sin decodificar de nuevo.

### 8.2 Omisión de Remuestreo en Vivo (Zero-Resampling Bypass)
- Cuando el motor reproduce un proyecto donde la frecuencia de la caché coincide con la del dispositivo (`sampleRate == deviceSampleRate`) y no hay cambio de tono (`pitchSemitones == 0`):
  - **El remuestreador `rubato` no se instancia ni se ejecuta.**
  - El hilo feeder copia las muestras leídas del búfer I/O directamente al búfer circular `rtrb` con una simple copia de memoria o conversión de formato.
  - Cero latencia de filtro sinc, cero consumo innecesario de ciclos de CPU y máxima pureza espectral sin artefactos de aliasing ni ripple de banda pasante.
- Si el usuario modifica la tonalidad en vivo (`pitchSemitones != 0`):
  - El feeder activa dinámicamente `rubato` ajustando el ratio $r = 2^{(\text{pitchSemitones}/12)}$ sobre el flujo continuo con compensación de fase.
- Si el usuario cambia el dispositivo físico de salida a otra frecuencia (por ejemplo, de 48.000 Hz a 96.000 Hz):
  - Si ya existe la carpeta de caché `pcm/{projectId}/96000/`, se conmuta a ella instantáneamente.
  - Si aún no existe, el motor nativo remuestrea al vuelo desde la carpeta existente (48.000 Hz) mientras un proceso en segundo plano de baja prioridad genera la caché nativa a 96.000 Hz.

---

## 9. Bibliotecas de Audio en Rust y Versiones Seleccionadas

| Crate | Versión Seleccionada | Versión Evaluada / Alternativa | Motivo Técnico de la Elección |
| :--- | :---: | :---: | :--- |
| **`cpal`** | `0.18.2` | `0.18.2` | Backend oficial de audio multiplataforma para WASAPI. Feature `"realtime"` activada para elevación de prioridad de hilo de audio a tiempo real en Windows (`AvSetMmThreadCharacteristicsW`). |
| **`symphonia`** | `0.5.5` | `0.6.1` | Aunque `symphonia 0.6.1` está publicada en crates.io como estable, introdujo **cambios mayores e incompatibles en la API** (breaking changes en `Probe::format`, traits de decodificación y estructura de `SampleBuffer`). La versión `0.5.5` es la versión estándar y probada con API estable que decodifica limpiamente WAV (16/24/32 bits), MP3, FLAC, OGG y AAC. |
| **`rubato`** | `0.16.2` | `5.0.1` | `rubato 5.0.1` reestructuró por completo su API obligando a encapsular los búferes en el crate externo `audioadapter`. La versión `0.16.2` mantiene la API directa basada en slices `&[f32]`, predicción de frames y compensación exacta de retardo (`output_delay()`). |
| **`rtrb`** | `0.3.6` | `0.4.1` | Búfer circular lock-free SPSC de alto rendimiento para comunicación segura y sin bloqueos entre el hilo feeder y el callback de hardware. Se utiliza `0.3.6` (fijado en `Cargo.lock` vía `"0.3"`) porque proporciona la API estable `Producer::push` / `Consumer::pop` probada en producción con cero asignaciones dinámicas y máxima compatibilidad, mientras que `0.4.1` reestructuró la API de slots/chunks sin aportar mejoras necesarias para nuestra arquitectura lineal SPSC. |

---

## 10. Pendientes Conocidos

1. **Horizonte de lectura del feeder y saltos cuantizados:**
   Cuando el límite de un salto cuantizado (ej. 1-bar o 2-bars) cae dentro del horizonte temporal ya leído y encolado por el hilo feeder (~600 ms respecto al cabezal DAC), el salto se pospone al siguiente límite de compás para no generar un empalme truncado en el flujo de audio encolado.
   *Solución prevista:* Implementar búferes de destino preparados (*Jump Reserve Buffers*) con conmutación y descarte exactos a la muestra en el callback de audio mediante micro-crossfade directo. Se abordará después de la Fase 6.

---

*Fin del documento de diseño actualizado.*

