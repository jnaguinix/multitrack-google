# Motor de Audio Híbrido REAPER-Style: Presupuesto de Bytes en RAM y Streaming por Bloques desde Disco (OPFS)

Evolución en **6 etapas controladas** del motor de audio multipista de **LibreTracks** para operar con consumo de RAM acotado y predecible en equipos de 8 GB de RAM y 4 núcleos (10–20 pistas estéreo de hasta 15 min y setlists de 6+ canciones), manteniendo intacta toda la API pública, el mezclador, el reloj con compensación de pitch (`rate`) y el scheduler con lookahead en Web Worker.

## User Review & Critical Decisions

> [!IMPORTANT]
> **Decisiones confirmadas por ti en la fase previa:**
> - **Cadencia de Entrega Etapa por Etapa**: Al aprobar este plan, ejecutaremos **únicamente la Etapa 1** (Presupuesto de RAM en bytes, micro-fades de 8 ms, expulsión previa a decodificar y selector de motor/presupuesto), verificaremos `npm run lint` y `npm run build`, y nos detendremos esperando a que escribas **"continúa"** para pasar a la Etapa 2 (y así sucesivamente hasta la Etapa 6).
> - **Ubicación de Controles en la Interfaz**:
>   - En la barra superior (**TopBar** / sub-barra de Setlist): interruptor de motor **`buffer` | `stream`** (persistido en `localStorage` con `try/catch`, por defecto `'buffer'`) y control de presupuesto de RAM (**`ramBudgetMB`**, por defecto `1200 MB`).
>   - En las tarjetas de **Setlist** y en la **Biblioteca**: estado de caché/RAM (`"En RAM"`, `"No precargada (RAM)"`, o estado de bloques listos en modo `'stream'`), tamaño estimado en disco por canción y botón **"Optimizar para streaming"** (con barra de progreso pista por pista y botón de cancelar, bloqueado si hay reproducción activa).

> [!NOTE]
> **Transparencia sobre el código actual antes de iniciar la Etapa 1:**
> - **Ya existen**: el scheduler de lookahead en Web Worker (tick de 25 ms, ventana de 120 ms), el reloj de transporte compensado por `rate = 2^(semitonos/12)` con re-anclaje en vivo, la decodificación con `Promise.all` en el motor `'buffer'`, y el refresco de medidores a 20 fps mediante `ref`.
> - **No existían aún y se incorporan desde la Etapa 1**: los **fades de 8 ms (`0.008 s`)** sin clics en `play`, `pause`, `stop`, `seek`, saltos cuantizados y bucles de vamp; y la **expulsión de caché ANTES de decodificar** validando el tamaño estimado de la canción frente al presupuesto en bytes (`MAX_CACHE_BYTES`).

---

## 1. Overview & Core Concept

- **Qué Hace**:
  - **Modo `'buffer'` (Etapa 1)**: Sustituye el límite fijo de 2 proyectos por un presupuesto estricto en bytes (`MAX_CACHE_BYTES`, por defecto `1200 MB` configurable en `localStorage`). Garantiza que la canción activa nunca se expulse, calcula el tamaño estimado antes de decodificar (`durationSec × sampleRate × 2 × 4 × numTracks`), expulsa canciones sobrantes **antes** de decodificar para evitar picos de memoria, y solo precarga la siguiente canción del Setlist si `activa + estimada_siguiente ≤ presupuesto` (mostrando `"No precargada (RAM)"` cuando excede el presupuesto).
  - **Modo `'stream'` (Etapas 2 a 6)**: Funciona como **REAPER**. Las pistas se almacenan en disco dentro de **OPFS** (`pcm/{projectId}/{trackId}.pcm`) como PCM `Int16` intercalado little-endian sin cabecera (generado decodificando una sola pista a la vez al importar o al pulsar *"Optimizar para streaming"*, sin borrar nunca los `Blob` originales de IndexedDB). Un Web Worker dedicado abre los archivos con `createSyncAccessHandle()`, lee bloques de `CHUNK_SEC = 2 s` según prioridad (`'active' > 'seek' > 'next'`), convierte `Int16` a `Float32` planar y los transfiere *zero-copy* al hilo principal para mantener solo una ventana deslizante (`TARGET_AHEAD_SEC = 10 s`, recarga bajo `REFILL_BELOW_SEC = 6 s`) conectada a los mismos `gainNode / panNode / analyser` del mezclador.
- **Constantes Unificadas del Motor**:
  - `CHUNK_SEC = 2`
  - `TARGET_AHEAD_SEC = 10` (auto-escalable hasta `20 s` si ocurren > 3 underruns en 10 s)
  - `REFILL_BELOW_SEC = 6`
  - `NEXT_SONG_STAGE_SEC = 6`

---

## 2. User Experience & Visual Design

- **Flujos Interactivos Clave**:
  1. **Control Global de Motor y Presupuesto RAM**: Selector rápido `'buffer' | 'stream'` y selector numérico de presupuesto en MB (`ramBudgetMB`, ej. `512 MB`, `1200 MB`, `2048 MB`) con lectura en vivo de los MB usados por el motor. Si una canción aún no tiene archivos PCM generados en OPFS o su `sampleRate` difiere de `ctx.sampleRate`, el motor hace *fallback* transparente a `'buffer'` para esa canción y muestra un aviso con opción de regenerar.
  2. **Indicador de Precarga y Presupuesto en Setlist**: Cada tarjeta del Setlist muestra si está `● En RAM (XX MB)`, `○ No precargada (RAM)` cuando `activa + siguiente > presupuesto`, o `⚡ Stream Listo (6s)` cuando sus primeros `NEXT_SONG_STAGE_SEC` están listos en modo streaming.
  3. **Importación Secuencial + "Optimizar para Streaming" (Etapa 2)**:
     - Verificación previa de almacenamiento (`navigator.storage.persist()` y `navigator.storage.estimate()`) exigiendo al menos `1.2×` el espacio requerido antes de importar.
     - En Biblioteca y Setlist, cada canción muestra su tamaño estimado en disco (PCM 16-bit) y un botón **"Optimizar para streaming"** que convierte los Blobs existentes en IndexedDB a PCM en OPFS **una pista a la vez**, con barra de progreso y botón **Cancelar** (deshabilitado mientras el transporte está reproduciendo).
- **Identidad Visual y Tema**:
  - **Estética de Consola de Estudio Oscura**: Superficies en pizarra profunda (`#0B0F17`, `#111827`, `#151A24`) con bordes de 1px (`#252D3C`), acentos semánticos en cian (`#22D3EE`) para controles activos, esmeralda (`#10B981`) para estado nominal/en RAM, y ámbar (`#F59E0B`) para avisos de presupuesto RAM, estado *buffering* o contador discreto de *underruns*.
  - **Tipografía Tabular**: Uso estricto de `font-mono tabular-nums` en todos los indicadores de MB, latencia, contadores de bloques y relojes de transporte.

---

## 3. Key Product Decisions & Trade-Offs

- **Decisión 1: Fades de 8 ms en una ganancia de envolvente por pista o bus antes de cortar fuentes**
  - *Enfoque Elegido*: Aplicar una rampa lineal de 8 ms (`0.008 s`) sobre la ganancia al iniciar, pausar, detener, hacer seek o saltar de sección/vamp, deteniendo los `AudioBufferSourceNode` salientes exactamente al terminar la rampa de 8 ms.
  - *Por Qué*: Elimina cualquier clic o pop por discontinuidad de fase de muestra sin alterar el nivel configurado en el fader del canal (`track.gain`).
- **Decisión 2: Estimación y Expulsión Pre-Decodificación en Bytes (`Etapa 1`)**
  - *Enfoque Elegido*: Calcular `realSongBytes = sum(length * numberOfChannels * 4)` para canciones ya decodificadas y `estimatedSongBytes = durationSec * sampleRate * 2 * 4 * tracks.length` antes de decodificar. Antes de iniciar cualquier decodificación, expulsar canciones no activas del caché y abortar la precarga de la siguiente canción si `activeBytes + nextEstimatedBytes > maxCacheBytes`.
  - *Por Qué*: Evita que el navegador duplique temporalmente el uso de RAM durante `decodeAudioData` y supere los 8 GB del equipo antes de que corra el recolector de basura.
- **Decisión 3: Dualidad No Destructiva IndexedDB (Blobs) + OPFS (PCM Int16) (`Etapas 2–6`)**
  - *Enfoque Elegido*: Conservar siempre los `Blob` originales en IndexedDB y escribir los archivos `.pcm` crudos (`Int16` intercalado little-endian) en OPFS (`pcm/{projectId}/{trackId}.pcm`).
  - *Por Qué*: Permite alternar en cualquier momento entre `'buffer'` y `'stream'` sin pérdida de datos y recuperar o regenerar el PCM si cambia la frecuencia de muestreo del dispositivo de audio (`ctx.sampleRate`).

---

## 4. Technical Architecture & Data Strategy *(Technical Reference)*

### Diagrama de Arquitectura del Motor Híbrido (Etapas 1 a 6)

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                     UI & Control (React 19 · ~20 fps max)                    │
│  TopBar / SetlistPageView (Motor: 'buffer' | 'stream', ramBudgetMB, Stats)   │
│  LibraryView ("Optimizar para streaming" 1x1 cancelable, MB en disco)        │
└──────────────────────┬───────────────────────────────────────┬───────────────┘
                       │ API Pública Intacta                   │ ref (20 fps)
                       ▼                                       ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│                        LibreTracksAudioEngine (Híbrido)                      │
│  ┌───────────────────────────────────┐  ┌──────────────────────────────────┐ │
│  │ Modo 'buffer' (Etapa 1)           │  │ Modo 'stream' (Etapas 2–6)       │ │
│  │ • MAX_CACHE_BYTES (1200 MB def.)  │  │ • Ventana: CHUNK_SEC = 2s        │ │
│  │ • Estimación pre-decode           │  │ • TARGET_AHEAD = 10s (max 20s)   │ │
│  │ • Expulsión ANTES de decodificar  │  │ • REFILL_BELOW = 6s              │ │
│  │ • Siguiente: solo si cabe en RAM  │  │ • NEXT_SONG_STAGE = 6s (tras 8s) │ │
│  │   ("No precargada (RAM)" si no)   │  │ • StreamingTrack -> Gain/Pan/VU  │ │
│  └─────────────────┬─────────────────┘  └─────────────────┬────────────────┘ │
│                    └──────────────────┬───────────────────┘                  │
│                                       ▼                                      │
│        Reloj con Rate (2^(st/12)) + Fades 8ms + Mezclador Web Audio          │
└──────────────┬────────────────────────────────────────────────┬──────────────┘
               │ Tick 25ms (Lookahead 120ms)                    │ Transferibles
               ▼                                                ▼ (Float32 Planar)
┌──────────────────────────────────────┐  ┌────────────────────────────────────┐
│   Scheduler Web Worker (25ms tick)   │  │   PCM Reader Worker (Etapa 3)      │
│ • Clicks exactos osc.start(when)     │  │ • OPFS createSyncAccessHandle()    │
│ • Saltos cuantizados y Vamp Loop     │  │ • Cola: 'active' > 'seek' > 'next' │
│ • Dispara Refill de StreamingTrack   │  │ • Cancelación por generation       │
└──────────────────────────────────────┘  └────────────────────────────────────┘
```

### Hoja de Ruta por Etapas (Con Pausa Tras Cada Etapa)

1. **ETAPA 1 — Presupuesto de RAM en Bytes y Fades de 8 ms**: ✅ Completada y verificada.
2. **ETAPA 2 — Almacenamiento PCM Int16 en OPFS y Migración 1 a 1**: ✅ Completada y verificada.
3. **ETAPA 3 — Lector en Worker (`pcmReader.worker.ts`)**: ✅ Completada y verificada.
4. **ETAPA 4 — Reproducción por Bloques Integrada (`streamingTrack.ts`)**: ✅ Completada y verificada.
5. **ETAPA 5 — Siguiente Canción (`6 s`), Secciones, Vamp y Seek**: ✅ Completada y verificada.
   - Puesta en escena (staging) de la siguiente canción con prioridad `'next'` para los primeros `NEXT_SONG_STAGE_SEC = 6 s` (~12 MB de RAM para 10 pistas).
   - Fast Swap instantáneo (< 2 ms) al activar la siguiente canción, reconectando nodos de destino sin esperas de lectura de disco.
   - Puesta en escena diferida hasta alcanzar `8 s` de reproducción estable sin *underruns* (`activePlaybackStableSec >= 8`) para garantizar prioridad absoluta al audio activo.
   - Pre-buffering de saltos cuantizados (`prefetchJumpTarget`) con prioridad `'seek'` (4 s por adelantado) para transiciones gapless y sin artefactos.
   - Pineado de bucles de vamp (`pinSectionChunks`) para secciones cortas (≤ 4 s) en RAM, garantizando cero accesos al disco durante las repeticiones en vivo.
   - Despineado automático al salir del vamp, al saltar o al detener/avanzar el transporte.
6. **ETAPA 6 — Métricas `[AudioEngine][Stream]`, `window.__streamStats()` y Robustez**: ✅ Completada y verificada.
   - Estadísticas completas de telemetría de streaming: tiempo medio y p95 de lectura (`avgReadMs`, `p95ReadMs`), reserva mínima y actual en segundos (`minBufferedAheadSec`, `currentBufferedAheadSec`), contador de *underruns*, errores de lectura y latencia de *seek* (`maxSeekLatencyMs`).
   - Log periódico `[AudioEngine][Stream]` en consola y exposición global interactiva vía `window.__streamStats()`.
   - Verificación y recuperación robusta ante archivos OPFS incompletos o corruptos con *fallback* automático transparente al motor `'buffer'` desde los `Blob` originales en IndexedDB.
