# Manual Técnico y de Arquitectura — LibreTracks (DAW & Setlist Multitrack Player)

Este documento está diseñado como **guía de transferencia técnica (Handoff Manual)** para que cualquier IA o desarrollador pueda retomar el proyecto inmediatamente, comprender su arquitectura interna al 100%, diagnosticar los problemas actuales de memoria/almacenamiento y ejecutar el plan de mejora propuesto.

---

## 1. Visión General del Proyecto

**LibreTracks** es una aplicación web tipo DAW / reproductor multipista en vivo (estilo *Ableton Live / Playback / Reaper* para músicos y directores de alabanza/escenario). Permite importar canciones por carpetas o stems sueltos (`.wav`, `.mp3`, `.flac`, `.ogg`, `.m4a`), armar un **Setlist**, controlar secciones en tiempo real (saltos cuantizados, loops tipo *Vamp*, metrónomo/click dinámico, guía hablada/cues), mezclar niveles/paneos/buses (`MAIN` y `CUE/CLICK`), y controlar el escenario desde una vista remota vía `BroadcastChannel`.

---

## 2. Mapa de Archivos Clave y Responsabilidades

```text
/
├── src/
│   ├── App.tsx                        # Estado global, cola de Setlist, importación instantánea, atajos y BroadcastChannel
│   ├── types/project.ts               # Contratos de datos (SongProject, TrackChannel, SongSection, TransportState, etc.)
│   ├── audio/
│   │   ├── audioEngine.ts             # Motor de audio híbrido ('buffer' en RAM y 'stream' desde OPFS) + Lookahead Scheduler
│   │   ├── streamingTrack.ts          # Ventana deslizante (ring buffer) por pista para reproducción por chunks desde OPFS
│   │   ├── pcmReaderClient.ts         # Cliente en hilo principal que gestiona peticiones al Worker de lectura OPFS
│   │   ├── pcmReader.worker.ts        # Web Worker dedicado que lee archivos .pcm usando FileSystemSyncAccessHandle
│   │   ├── smartAnalyzer.ts           # Inferencia automática de título, BPM, tonalidad y nombres limpios de pistas al importar
│   │   └── demoSynthesizer.ts         # Extracción de picos de forma de onda (extractWaveformPeaks)
│   ├── storage/
│   │   ├── projectDb.ts               # Capa IndexedDB ('projects' para metadatos JSON y 'audioBuffers' para Blobs nativos)
│   │   ├── opfsStorage.ts             # Capa OPFS (Origin Private File System) para lectura/escritura de archivos .pcm
│   │   └── pcmOptimizer.ts            # Conversor secuencial de Stems (IndexedDB -> AudioBuffer -> OPFS .pcm)
│   ├── utils/
│   │   └── fileImportHelper.ts        # Lectura ultrarrápida de cabeceras WAV (<1ms) y extracción de archivos por Drag & Drop
│   └── components/
│       ├── TopBar.tsx                 # Selector de vista, selector de modo ('buffer' | 'stream'), presupuesto RAM
│       ├── TransportDeck.tsx          # Controles Play/Pause/Stop/Vamp, BPM, Pitch, Cuantización, Transición de Setlist
│       ├── RepertoireTreeSidebar.tsx  # Árbol lateral de repertorio y cola del Setlist
│       ├── SetlistPageView.tsx        # Vista principal del Setlist con badges de estado en RAM / OPFS y botón de optimización
│       ├── TimelineArranger.tsx       # Línea de tiempo con ondas, secciones (mm:ss) y playhead a 60fps
│       ├── MultitrackMixer.tsx        # Consola de mezcla multipista con medidores RMS/Peak y ruteo Main/Cue
│       ├── StageRemoteView.tsx        # Control remoto táctil sincronizado entre pestañas/tablets
│       └── LibraryAndModals.tsx       # Modales de importación, progreso de optimización OPFS y edición de secciones
```

---

## 3. Cómo Funciona Actualmente el Sistema

### 3.1. Flujo de Importación (`handleInstantImportFiles` en `src/App.tsx`)
El sistema importa canciones en 2 fases sin bloquear la interfaz:
1. **Fase 1 (Montaje instantáneo < 5 ms):**
   - Inspecciona los primeros bytes de cada archivo WAV (`parseWavHeaderFast`) para conocer la duración sin decodificar.
   - Crea el objeto `SongProject` y sus `TrackChannel[]`.
   - Monta el "cascarón" en el motor (`audioEngine.prepareProjectShell`) para que los canales aparezcan de inmediato en la UI.
   - Guarda los `File` originales directamente como **Blobs nativos en IndexedDB** (`saveStemsBatchToDb` en `projectDb.ts`) sin recodificar.
2. **Fase 2 (Hidratación y Decodificación en lotes de 4):**
   - Decodifica los archivos de 4 en 4 mediante `ctx.decodeAudioData()`.
   - Extrae los picos de onda (`peaks`) y monta cada `AudioBuffer` en el motor (`audioEngine.mountDecodedTrack`).

### 3.2. Los Dos Modos del Motor de Audio (`src/audio/audioEngine.ts`)
El motor `LibreTracksAudioEngine` cuenta con dos modos seleccionables en el `TopBar`:

#### A. Modo `buffer` (Por defecto)
- **Cómo funciona:** Decodifica todas las pistas de la canción completa en objetos `AudioBuffer` de Web Audio API en la memoria RAM (`projectBufferCache: Map<projectId, Map<trackId, AudioBuffer>>`).
- **Reproducción:** Al dar Play, crea un `AudioBufferSourceNode` por pista apuntando al `AudioBuffer` completo en RAM.
- **Presupuesto de RAM (`maxCacheBytes`):** Por defecto es **1200 MB** (`DEFAULT_RAM_BUDGET_MB = 1200`).

#### B. Modo `stream` (Estilo REAPER desde OPFS)
- **Requisito previo:** La canción debe haber pasado por `optimizeProjectForStreaming` (`src/storage/pcmOptimizer.ts`), lo cual genera archivos `.pcm` crudos en el disco privado del navegador (`OPFS: pcm/{projectId}/{trackId}.pcm`). Si una canción no tiene archivos `.pcm`, el motor hace *fallback* automático a modo `buffer`.
- **Cómo funciona:**
  - En lugar de subir toda la canción a RAM, cada pista se envuelve en una instancia de `StreamingTrack` (`src/audio/streamingTrack.ts`).
  - El audio se divide en bloques (`CHUNK_SEC = 2` segundos).
  - Mantiene en RAM únicamente una ventana deslizante de **10 segundos hacia adelante** (`TARGET_AHEAD_SEC = 10`) y descarta los bloques que ya sonaron (`discardBefore = currentChunk - 1`).
  - Un Web Worker dedicado (`pcmReader.worker.ts`) lee los bloques desde OPFS usando `FileSystemSyncAccessHandle` con cola de prioridades (`seek > active > next`).
  - **Staging de siguiente canción:** Pre-carga únicamente los primeros **6 segundos** (`NEXT_SONG_STAGE_SEC = 6`) de la siguiente canción (~12 MB en RAM) para permitir un cambio instantáneo (`FAST SWAP < 2 ms`).

### 3.3. Reloj y Scheduler Musical
- Un Web Worker interno (`schedulerWorker` en `audioEngine.ts`) emite un `tick` cada **25 ms** (inmune al *throttling* de pestañas en segundo plano).
- En cada tick se ejecuta `runLookaheadSchedulerTick()` con una ventana de anticipación de **120 ms** (`SCHEDULER_LOOKAHEAD_SEC = 0.12`), programando con precisión de muestras:
  - Clicks del metrónomo y avisos de guía.
  - Saltos cuantizados entre secciones (`1-bar`, `2-bars`, `section-end`) con micro-crossfades de **8 ms** (`FADE_DURATION_SEC = 0.008`) para evitar chasquidos.
  - Loops de sección (*Vamp*).
  - Recarga de chunks si el motor está en modo `stream`.

---

## 4. Diagnóstico Detallado de los Problemas Actuales

Durante las pruebas reales con canciones multipista (~183 MB por canción y un Setlist de 3 canciones), se identificaron dos grandes problemas arquitectónicos. A continuación se documenta la **causa raíz exacta en el código** para cada uno:

---

### PROBLEMA 1: ¿Por qué una canción de 183 MB pasa a ocupar ~800 MB tras OPFS (y en estimaciones de RAM)?

Existen **4 factores acumulativos** en el código actual que inflan el peso entre **4x y 4.5x**:

#### Causa 1.1: Conversión forzada de pistas MONO a ESTÉREO en OPFS (Duplica el peso 2x innecesariamente)
- **Dónde ocurre:** `src/storage/opfsStorage.ts` (líneas 124–179, función `writeTrackPcmFromAudioBuffer`).
- **Qué hace el código actual:**
  ```ts
  const leftChannel = audioBuffer.getChannelData(0);
  const rightChannel = numChannels > 1 ? audioBuffer.getChannelData(1) : leftChannel;
  // ... escribe siempre 2 canales intercalados (L, R) en Int16 (4 bytes por frame)
  ```
- **Por qué infla el peso:** En una sesión multipista típica (Click, Guía, Bajo, Bombo, Caja, Voces, Guitarras mono), muchas o la mayoría de las pistas son **Mono (1 canal)** o están comprimidas (FLAC/MP3/WAV 16-bit mono). Al convertir a OPFS, el código **duplica el canal izquierdo en el derecho para forzar que todas las pistas sean Estéreo de 2 canales**. Una pista mono pasa inmediatamente a pesar **el doble (2x)** en disco sin aportar ninguna información estéreo real.

#### Causa 1.2: Resampleo automático a 48,000 Hz al decodificar
- **Dónde ocurre:** `src/storage/pcmOptimizer.ts` (líneas 118–122).
- **Qué hace el código actual:** Crea un `new AudioContext()` sin especificar la frecuencia de muestreo original del archivo (`sampleRate`). En la mayoría de las tarjetas de sonido y navegadores, `AudioContext` opera a **48,000 Hz**.
- **Por qué infla el peso:** Si las pistas originales están a **44,100 Hz**, `decodeAudioData` las remuestrea a **48,000 Hz**, aumentando el número de frames en un **+8.84%** adicional. Si además los archivos originales eran formatos comprimidos sin pérdida (`.flac`) o con pérdida (`.mp3`, `.m4a`, `.ogg`), al expandirlos a PCM crudo sin comprimir el tamaño se multiplica entre **2x y 8x**.

#### Causa 1.3: Duplicación total de almacenamiento entre IndexedDB y OPFS (No se borran ni compactan los Blobs originales)
- **Dónde ocurre:** `src/storage/pcmOptimizer.ts` (líneas 33 y 69–75).
- **Qué hace el código actual:**
  - Al importar la canción, los **183 MB originales** se guardan en IndexedDB (`LibreTracksWebDB -> store: audioBuffers`).
  - Al optimizar a OPFS, se escriben los archivos `.pcm` en OPFS (~400–600 MB), **pero se conservan intactos los 183 MB originales en IndexedDB**.
  - Resultado en el almacenamiento del navegador (`navigator.storage.estimate()`): El navegador suma **IndexedDB (183 MB) + OPFS (~600 MB) = ~783 MB (~800 MB)** consumidos en el origen.

#### Causa 1.4: Expansión a Float32 (32-bit) en Web Audio API y sobreestimación en `estimateProjectBytes`
- **Dónde ocurre:** `src/audio/audioEngine.ts` (líneas 398–406 y 437–454).
- **Qué hace el código actual:**
  - En memoria RAM (`AudioBuffer` nativo de C++ en el navegador), cada muestra se almacena obligatoriamente en **Float32 (4 bytes por muestra)**, no en 16-bit (2 bytes) ni 24-bit (3 bytes).
  - Además, `estimateProjectBytes(project)` calcula el peso estimado con la fórmula fija:
    ```ts
    Math.ceil(durationSec * sampleRate * 2 * 4 * project.tracks.length);
    ```
  - Es decir, asume que **todas las pistas son Estéreo (2 canales) a 4 bytes (32 bits) y 48,000 Hz**.
  - **Matemática exacta del caso real (183 MB -> ~800 MB):**
    - Si una canción de 183 MB está compuesta por WAVs en 16-bit (2 bytes por muestra) o 24-bit (3 bytes) con varias pistas mono:
    - Al pasar a `Float32` (4 bytes por muestra) + asumir 2 canales en `estimateProjectBytes` + pasar de 44.1kHz a 48kHz, `183 MB` se convierte en **~732 MB a ~800 MB** en RAM y en el indicador de caché de la interfaz.

---

### PROBLEMA 2: ¿Por qué al cargar 3 canciones y tocar la 1ª, la 2ª no estaba en RAM, y al terminar la 2ª la 3ª tampoco estaba en RAM?

El usuario cargó 3 canciones. Cuando tocó la Canción 1, la Canción 2 no estaba lista en RAM; y cuando terminó la Canción 2, la Canción 3 tampoco estaba en RAM. Esto ocurre por **4 fallos en la lógica de caché y precarga**:

#### Causa 2.1: `evictBeforeDecode` borra agresivamente todas las demás canciones aunque sobre RAM
- **Dónde ocurre:** `src/audio/audioEngine.ts` (líneas 482–500).
- **Qué hace el código actual:**
  ```ts
  private evictBeforeDecode(incomingBytes: number, protectedIds: string[] = []) {
    const activeId = this.project?.id;
    const protectedSet = new Set<string>(protectedIds.filter(Boolean));
    if (activeId) protectedSet.add(activeId);

    // First pass: evict any song not in protectedSet (oldest first)
    for (const candidateId of [...this.cacheOrder]) {
      if (candidateId === activeId) continue;
      if (!protectedSet.has(candidateId)) {
        // ¡EXPULSA INCONDICIONALMENTE CUALQUIER CANCIÓN QUE NO ESTÉ EN protectedSet,
        // SIN IMPORTAR SI CABE EN EL PRESUPUESTO DE RAM!
        this.projectBufferCache.delete(candidateId);
      }
    }
  ```
- **Qué provoca esto:**
  1. Cuando el usuario importa la Canción 1, queda en RAM.
  2. Cuando importa la Canción 2, `mountDecodedTrack` (línea 1457) llama a `this.evictBeforeDecode(incomingBytes, [this.project.id])` pasando **únicamente** la canción recién importada como protegida. El *First pass* **borra inmediatamente la Canción 1 de la RAM**.
  3. Cuando importa la Canción 3, **borra inmediatamente la Canción 2 de la RAM**, dejando únicamente la Canción 3 en RAM.
  4. Luego, cuando el usuario selecciona la Canción 1 para empezar a tocar, `loadProject` (línea 749) llama a `this.evictBeforeDecode(estimatedBytes, [project.id])` pasando solo `[Cancion1.id]`, lo cual **borra la Canción 3 de la RAM** antes de decodificar la Canción 1.

#### Causa 2.2: Condición de carrera entre `activateProject` y el `useEffect` de precarga en `App.tsx`
- **Dónde ocurre:** `src/App.tsx` (líneas 176–202 y 301–328).
- **Qué pasa paso a paso cuando el usuario selecciona la Canción 1:**
  1. En `activateProject` (línea 301), se llama a `setCurrentProject(normalizedProj)` **antes** de que `await audioEngine.loadProject(normalizedProj)` termine de cargar la Canción 1.
  2. Ese `setCurrentProject` dispara el `useEffect` de precarga (línea 176), que lanza un `setTimeout(..., 100ms)` para llamar a `audioEngine.preloadProject(Cancion2)`.
  3. A los 100 ms, la Canción 1 **todavía se está decodificando** desde IndexedDB (tarda ~1–2 segundos).
  4. Por tanto, `decodeProjectIntoCache(Cancion1)` y `preloadProject(Cancion2)` compiten al mismo tiempo por `ctx.decodeAudioData()` y por `evictBeforeDecode()`, o bien el cálculo de presupuesto falla.

#### Causa 2.3: El presupuesto de RAM por defecto (1200 MB) rechaza la 2ª canción porque cada canción se estima en ~750–800 MB
- **Dónde ocurre:** `src/audio/audioEngine.ts` (líneas 754–773).
- **Qué hace el código actual:**
  ```ts
  // Check if active song + estimated next song fits within MAX_CACHE_BYTES
  if (activeBytes + estimatedBytes > this.maxCacheBytes) {
    this.skippedByRamBudgetIds.add(project.id);
    // ¡ABORTA LA PRECARGA DE LA SIGUIENTE CANCIÓN!
    return new Map<string, AudioBuffer>();
  }
  ```
- **Por qué bloquea la Canción 2 y la Canción 3:**
  - Como vimos en el Problema 1.4, una canción de 183 MB en disco ocupa o se estima en **~750–800 MB** en `AudioBuffer` Float32 en RAM.
  - El presupuesto por defecto (`DEFAULT_RAM_BUDGET_MB`) es de **1200 MB**.
  - Al intentar precargar la Canción 2 mientras la Canción 1 está activa:
    `activeBytes (~780 MB) + estimatedBytes (~780 MB) = ~1560 MB > 1200 MB`.
  - Como `1560 MB > 1200 MB`, el motor **aborta silenciosamente la precarga de la Canción 2** y la marca con `skippedByRamBudget = true`.
  - Cuando termina la Canción 1 y pasa a la Canción 2, la Canción 2 no estaba en RAM (tuvo que cargarse en ese instante). Y al intentar precargar la Canción 3 mientras suena la Canción 2, vuelve a ocurrir lo mismo: `Canción 2 (~780 MB) + Canción 3 (~780 MB) > 1200 MB`, por lo que **tampoco precarga la Canción 3**.

#### Causa 2.4: La optimización OPFS es hoy 100% manual y el modo por defecto es `'buffer'`
- **Dónde ocurre:** `src/audio/audioEngine.ts` (línea 82: `return 'buffer';`) y `src/App.tsx` (`handleStartOptimizeProject`).
- **Qué pasa:** Al importar 3 canciones, ninguna se optimiza automáticamente en OPFS en segundo plano, y aunque se optimicen manualmente, el motor sigue en modo `'buffer'` a menos que el usuario cambie manualmente el selector a `'stream'` en la barra superior.

---

## 5. Arquitectura Propuesta por el Usuario (Hoja de Ruta para la Siguiente IA)

El usuario ha diseñado una estrategia híbrida muy sólida para resolver ambos problemas:

> **Idea Central del Usuario:**
> 1. **Solucionar primero el sobrepeso en OPFS** (por qué 183 MB pasan a 800 MB).
> 2. **Estrategia Híbrida de Setlist:** Mantener las **2 primeras canciones siempre precargadas en RAM** para ejecución inmediata, y **a partir de la 3ª canción (o desde la 2ª en adelante), procesar y operar automáticamente en segundo plano vía OPFS (Streaming)** sin intervención manual del usuario.

---

### Paso 1: Reducir drásticamente el peso en OPFS (De ~800 MB a ~150–183 MB)

Para que una canción de 183 MB no se infle a 800 MB al pasar a OPFS, la siguiente IA debe aplicar estas mejoras en `src/storage/opfsStorage.ts`, `src/storage/pcmOptimizer.ts` y `src/audio/pcmReader.worker.ts`:

1. **Respetar el número real de canales (Mono vs. Estéreo) por pista (`channels: 1 | 2`):**
   - En `writeTrackPcmFromAudioBuffer` (`opfsStorage.ts`), inspeccionar `audioBuffer.numberOfChannels` (o incluso detectar si el canal L y R de un WAV estéreo son idénticos: *dual-mono* con diferencia RMS < `1e-5`).
   - Si la pista es Mono (o dual-mono), guardarla en OPFS como **1 solo canal Int16 (`2 bytes por frame` en vez de `4 bytes por frame`)** y registrar `channels: 1` en `TrackPcmMetadata`.
   - En `pcmReader.worker.ts`, si `channels === 1`, leer `requestedFrames * 2` bytes y copiar el mismo `Float32Array` a `leftChannel` (o construir un `AudioBuffer` de 1 canal en `StreamingTrack`, ya que Web Audio API soporta `ctx.createBuffer(1, frameCount, sampleRate)` de forma nativa y el `StereoPannerNode` lo panea en estéreo automáticamente).
   - **Impacto directo:** Reduce a la **mitad (50% menos de RAM y 50% menos de disco OPFS)** todas las pistas mono (Click, Guide, Bass, Kick, Snare, Voces, Guitarras mono).

2. **Preservar el `sampleRate` original o usar el del encabezado WAV:**
   - Al decodificar en `pcmOptimizer.ts`, usar `OfflineAudioContext` o `AudioContext({ sampleRate: detectedWavSampleRate })` (por ejemplo, 44,100 Hz si los WAVs vienen a 44.1 kHz) para no inflar un +8.8% extra de muestras.

3. **Eliminar los Blobs duplicados de IndexedDB una vez verificado el archivo OPFS:**
   - En `optimizeProjectForStreaming` (`pcmOptimizer.ts`), después de verificar con `isProjectPcmComplete(updatedProject)` que el `.pcm` de una pista está 100% escrito e íntegro en OPFS, **eliminar el Blob crudo duplicado de esa pista en IndexedDB (`STORE_AUDIO`)** (o ofrecer una función `deleteProjectStemsFromDb(projectId)`).
   - **Impacto directo:** Elimina los **183 MB duplicados** en IndexedDB una vez que la canción ya vive en OPFS.

---

### Paso 2: Implementar el Motor Híbrido Automático (Canciones 1 y 2 en RAM + Resto en OPFS Background)

Para cumplir exactamente el flujo que pide el usuario:

1. **Precarga garantizada de las 2 primeras canciones (o Canción Activa + Siguiente Canción) en RAM:**
   - **Corregir `evictBeforeDecode` (`src/audio/audioEngine.ts`):**
     - Eliminar el "First pass" destructivo que borra canciones aunque no se haya superado el límite de RAM, o proteger explícitamente siempre la pareja `[activeSongId, nextSetlistSongId]`.
     - Garantizar que las **2 canciones prioritarias del Setlist** (Canción 1 y Canción 2 al inicio; o Canción Actual y Canción Siguiente) **jamás sean bloqueadas por el estimador de presupuesto**, permitiendo que siempre haya 2 canciones listas para reproducirse con latencia 0 ms.
   - **Esperar a que termine `loadProject(activeSong)` antes de disparar `preloadProject(nextSong)`:**
     - En `App.tsx`, no disparar `preloadProject(nextSong)` a los 100 ms mientras `loadProject` aún está decodificando la canción activa. Dispararlo justo al finalizar `await audioEngine.loadProject(...)` para que no compitan por CPU/disco y la transición sea determinista.
   - **Usar `AudioBuffer` de 1 canal para pistas mono también en Modo Buffer:**
     - Si una pista es mono (o sus canales L y R son idénticos tras `decodeAudioData`), conservar solo 1 canal en el `AudioBuffer` en RAM (`ctx.createBuffer(1, buf.length, buf.sampleRate)`). Esto reduce el consumo de RAM por canción de ~750 MB a ~375 MB, permitiendo que 2 o 3 canciones quepan holgadamente en RAM sin picos de memoria.

2. **Cola de Optimización Automática en Background hacia OPFS para las canciones restantes (Canción 3+ o desde la 2ª en segundo plano):**
   - Crear un gestor de cola en segundo plano (`BackgroundOpfsQueue` en `pcmOptimizer.ts` o `App.tsx`) que observe `setlistQueue`:
     - **Canción 1 y Canción 2:** Se mantienen listas en RAM de inmediato al importarse.
     - **Canciones 3 en adelante (y opcionalmente la 2 en baja prioridad cuando el motor esté en reposo):** Se encolan automáticamente en segundo plano para convertirse a OPFS (`optimizeProjectForStreaming`) una pista a la vez, cediendo el hilo entre chunks (`requestIdleCallback` o `setTimeout`) y pausando la conversión si el usuario está en los primeros segundos críticos de una carga.
   - **Selección Híbrida Automática por Canción (`getEffectiveEngineModeForProject`):**
     - Si la canción ya está 100% en caché RAM (`hasFullProjectInCache(project)`), usar sus `AudioBuffers` en RAM instantáneamente.
     - Si la canción (ej. Canción 3, 4, 5...) ya fue optimizada automáticamente en OPFS (`isProjectPcmReady(project)`), reproducirla directamente con el motor de **Streaming OPFS** (que solo usa ~12 MB de staging para los primeros 6 segundos y ~40 MB durante la reproducción), asegurando que al pasar de la Canción 1 -> 2 -> 3 -> N **todas estén siempre listas al instante (< 2 ms) sin importar cuántas canciones tenga el Setlist**.

---

## 6. Comandos de Desarrollo y Verificación

- **Instalar dependencias:** `npm install`
- **Servidor de desarrollo (Puerto 3000):** `npm run dev`
- **Verificar tipos y linting:** `npm run lint` (ejecuta `tsc --noEmit`)
- **Compilar para producción:** `npm run build`
- **Inspección de telemetría en consola del navegador:**
  - Los logs de caché RAM llevan el prefijo `[AudioEngine][RAM]`.
  - Los logs de streaming OPFS llevan el prefijo `[AudioEngine][Stream]` y `[AudioEngine][Staging]`.
  - En la consola de DevTools se puede invocar `window.__pcmReaderClient.getMetrics()` para inspeccionar tiempos de lectura (`avgReadMs`, `p95ReadMs`, `syncHandlesSupported`).
