# Diseño: medidores de nivel reales en escritorio

**Estado: PENDIENTE DE APROBACIÓN del dueño. No implementar nada sin su visto bueno.**
Fecha: 2026-11-12. Rama del diseño: `diag/medidores-reales` (desde `motor-nativo`).

Este documento es autosuficiente: quien lo ejecute no necesita la conversación donde se diagnosticó.

---

## 1. Problema

Síntomas que reportó el dueño en el `.exe` de escritorio:
1. **Arreglo:** los medidores de todas las pistas se mueven a la vez y con el mismo movimiento, «como siguiendo el clic».
2. **Mezcla:** fader, mute y solo funcionan, pero los medidores de los stems no se mueven. El del Main general sí.

### Causa encontrada (leyendo el código, sin ejecutar)
- En escritorio, `audioEngine` es `nativeAudioEngine` (`src/audio/audioEngine.ts:2622`).
- `nativeAudioEngine.getTrackMeters()` (`src/audio/nativeAudioEngine.ts:1018`) **no mide nada**. Devuelve `0.35 × ganancia + 0.1 × sen(Date.now()/80 + longitud del id)`.
  - Mismo volumen y ids de igual longitud (`stem-01`, `stem-02`...) dan la misma onda en todas las pistas → síntoma 1.
  - El periodo es 2π·80 ms ≈ 503 ms ≈ 119 BPM. Coincide con el tempo de las canciones de prueba (108–124 BPM): por eso parece seguir el clic. Es casualidad.
  - El Main devuelve un 0,4 fijo mientras suena.
- El motor Rust (`desktop/src-tauri/src/audio/playback/mod.rs`, callback dentro de `ensure_stream`) **no calcula ningún nivel**.
- Síntoma 2, **hipótesis no verificada:** la simulación recorre `this.currentProject.tracks` del motor nativo. Si esa copia no coincide con la canción que muestra Mezcla (por ejemplo tras cambiar de canción desde En vivo), `meters.tracks[track.id]` es `undefined` y el medidor queda a cero. El paso 0 lo confirma o lo descarta.

---

## 2. Diseño

### 2.1 Principio
El hilo de audio mide el **pico** de cada pista y de cada bus en cada bloque y lo deja en atómicos ya reservados. Otro hilo lo lee y lo pone a cero. Así el hilo de audio no hace alocaciones, ni bloqueos, ni logging (regla 1 de `CLAUDE.md`).

### 2.2 Estructura nueva (Rust, `playback/types.rs`)
```rust
/// Pico desde la última lectura, en f32 guardado como bits. Para valores >= 0 el orden de los
/// bits coincide con el orden numérico, así que `fetch_max` sobre u32 da el máximo correcto.
#[derive(Default)]
pub struct PeakMeter {
    pub l: AtomicU32,
    pub r: AtomicU32,
}
impl PeakMeter {
    #[inline] pub fn record(&self, l: f32, r: f32) { /* fetch_max(l.abs().to_bits()), idem r; Relaxed */ }
    pub fn take(&self) -> (f32, f32) { /* swap(0, Relaxed) en ambos y from_bits */ }
}
```
- Ignorar NaN: `record` solo guarda si `x.is_finite()`.
- `take` pone a cero: cada lectura devuelve el pico **desde la lectura anterior**, sin perder transitorios entre sondeos.

### 2.3 Dónde se crean y quién los lee
- `ActiveTrack` y `StreamTrackHandle` reciben `meter: Arc<PeakMeter>` (el mismo `Arc` en los dos).
- `PlaybackEngine` recibe:
  - `bus_meters: Arc<BusMeters>` con `main: PeakMeter`, `cue: PeakMeter` (click + guía + pistas a cue) y `out: PeakMeter` (salida final antes del `clamp`, para detectar recorte).
  - `meter_index: Arc<std::sync::Mutex<Vec<(String, Arc<PeakMeter>)>>>`: lista `track_id → medidor` que solo tocan los hilos de control.
- **Importante:** el lector **no** debe bloquear `stream_tracks`. El callback hace `try_lock` sobre ese mutex y, si falla, emite silencio. Por eso existe `meter_index` aparte.
- `meter_index` se rellena donde hoy se asigna `stream_tracks`: carga (`mod.rs` ~l.547), `switch_to_preloaded` y el `clear()` (~l.658).

### 2.4 Cambios en el callback (`ensure_stream`) — mínimos
Dentro del bucle por pista que ya existe:
```rust
let mut pk_l = 0.0f32; let mut pk_r = 0.0f32;     // variables locales en la pila
// ... en el for f in 0..frames, tras calcular tl y tr:
pk_l = pk_l.max(tl.abs()); pk_r = pk_r.max(tr.abs());
// tras el for:
trk.meter.record(pk_l, pk_r);
```
- Pistas en mute o fuera del solo: no se registra nada, así que su lectura sale 0.
- Es un nivel **post-fader y post-pan**, como en una consola.
- En el bucle final de salida, igual con tres acumuladores locales: Main (`(main+both) × master_g × env`), Cue (`(cue+both+click+guide) × cue_g × env`) y salida antes del `clamp`. Al terminar, tres `record`.
- Mantener **la misma modificación** en `simulate_callback_block` (`mod.rs` ~l.1025), que replica el callback para las pruebas.
- Coste estimado: 2 `abs` + 2 `max` por muestra y pista. Con 10 pistas y 480 frames son unas 10 000 operaciones por bloque, frente a un presupuesto de 10 ms. Estimado, **No medido**: hay que medirlo (paso 4).

### 2.5 Transporte a la interfaz — sin comando nuevo
- Añadir a `PlaybackStateSnapshot` (`playback/types.rs:85`) un campo `meters: MetersSnapshotDto` con `tracks: Vec<{ trackId, peakL, peakR }>`, `main`, `cue`, `out` y `clipped: bool`.
- `get_playback_state()` llama a `take()` de cada medidor.
- La interfaz ya llama a `audio_get_playback_state` cada ~30 ms (`nativeAudioEngine.ts`, `startPolling`). Así no hay comando nuevo, no hay declaración triple y no hay un segundo sondeo.

### 2.6 Interfaz (`nativeAudioEngine.ts`)
- Borrar la simulación de `getTrackMeters()`.
- En `startPolling`, al recibir el estado, guardar `pb.meters` en `this.lastMeters`.
- `getTrackMeters()` devuelve `this.lastMeters` convertido al `MetersSnapshot` actual (`rms`, `peak`, `clipping`), con caída visual:
  - Caída de ~20 dB/s (balística de pico típica): `mostrado = max(nuevo, anterior × factor_por_tiempo)`.
  - `rms` = valor con caída. El Arreglo lo usa como ancho de barra: hoy se llama `rms` pero será pico con caída. Se documenta en el tipo.
  - Pista sin dato (id desconocido) → 0, no un valor inventado.
  - Transporte parado → todo a 0.
- Mezcla (`MultitrackMixer.tsx`):
  - Main: usar `meters.master` real en vez de `max(pistas, 0.4 fijo)`.
  - Tiras de Click y Guía: hoy dibujan un pulso sintético. Pasar a usar `meters.cue` real. Si el dueño prefiere mantenerlas separadas, añadir `click` y `guide` como dos `PeakMeter` más (es la misma técnica).

---

## 3. Plan de ejecución (para cuando se apruebe)

### Reglas
- Rama nueva desde `motor-nativo`: `feat/medidores-reales`. Nunca `main`.
- Un cambio lógico por commit. `.\verify.ps1` por commit; `.\verify.ps1 -Completo` al cerrar.
- UTF-8 sin BOM. No tragar errores.
- Toolchain antes de `cargo`/`verify.ps1`:
  ```powershell
  $t="C:\Users\jpuerta\.codex\visualizations\2026\11\09\01a1be2f-be92-7153-bd62-a2684be8afbf"; $env:CARGO_HOME="$t\cargo"; $env:RUSTUP_HOME="$t\rustup"; $env:PATH="$t\cargo\bin;$env:PATH"
  ```
- `build:portable` se lanza con `npm --prefix desktop run build:portable` y la app cerrada.

### Paso 0 — Medición de referencia (dueño, antes de tocar el callback)
Con el `.exe` actual, 5 minutos de reproducción de DIOS a 48 kHz y buffer 480. Anotar del panel Diagnóstico:

| Dato | Valor |
|---|---|
| callbacks | |
| underruns | |
| máx. callback (µs) | |
| mín. buffer (ms) | |

Además, para confirmar la hipótesis del síntoma 2: ¿los medidores de stems de Mezcla siguen a cero **en la misma canción que suena**, recién abierta la app y sin pasar por En vivo? Sí / No.

### Paso 1 — Pruebas primero (Rust)
En `playback/tests.rs`:
1. `PeakMeter`: `record` guarda el máximo; `take` devuelve y pone a 0; valores negativos cuentan por su valor absoluto; NaN se ignora; `record` desde 4 hilos da el máximo global.
2. Con `simulate_callback_block`, con dos pistas sintéticas de amplitud conocida (0,5 y 0,25), ganancia 1 y pan centro:
   - El pico leído de cada pista es la amplitud × cos(π/4) (≈ 0,354 y 0,177), con tolerancia 1e-4.
   - Pista en mute → 0. Solo en la pista A → B da 0.
   - Main ≈ suma de pistas × master_gain. Con master_gain 0,5 se reduce a la mitad.
   - Tras `take`, la siguiente lectura sin audio nuevo da 0.
3. Estas pruebas **deben fallar** antes del paso 2 (no compilan o dan 0) y pasar después.

Commit: `test(playback): fijar el comportamiento de los medidores de pico`.

### Paso 2 — Rust
1. `PeakMeter`, `BusMeters` y `meter_index` (2.2 y 2.3).
2. Acumuladores en el callback y en `simulate_callback_block` (2.4). **Nada más cambia en el callback.**
3. Campo `meters` en `PlaybackStateSnapshot` (2.5).

Commit: `feat(playback): medir el pico real por pista y por bus en el motor nativo`.

### Paso 3 — TypeScript
1. Prueba nueva en `test/` (estilo de `nativeCacheGeneration.test.ts`, con `invoke` falso): con el transporte parado todo es 0; los valores del snapshot llegan a `getTrackMeters`; un id desconocido da 0; la caída baja con el tiempo y nunca sube sin dato nuevo; ya **no** hay oscilación con el reloj (dos lecturas sin dato nuevo no crecen).
2. Implementar 2.6.
3. Ajustar Mezcla: Main real y tiras Click/Guía (2.6).

Commits: `feat(native): medidores reales en Arreglo y Mezcla` y `fix(mixer): usar los niveles reales del Main y del bus de cue`.

### Paso 4 — Cierre
1. `.\verify.ps1 -Completo`.
2. El dueño repite el paso 0 con el `.exe` nuevo y rellena la misma tabla. **Criterio:** underruns sin aumento y máx. callback sin un aumento apreciable. Si empeora, se revierte el commit de Rust y se reporta.
3. Comprobación visual del dueño:
   - Arreglo: cada pista se mueve distinto y sigue su propio audio. La pista de bajo y la de platos no se mueven igual.
   - Un mute deja su medidor a 0 al instante. Un solo deja a 0 las demás.
   - Mezcla: los stems se mueven y el Main sigue al conjunto.
   - Si sube una pista al máximo hasta recortar, se ve el aviso de recorte en la salida.
4. Reporte con la tabla antes/después, lo comprobado y lo «No medido».
5. No fusionar en `motor-nativo` sin el visto bueno del dueño.

---

## 4. Riesgos y decisiones abiertas
- **Toca el hilo de audio.** El cambio son operaciones aritméticas y `fetch_max` atómicos, sin bloqueos ni memoria. El riesgo es bajo, pero solo el paso 4 lo demuestra.
- **Pico, no RMS.** Se mide el pico porque es barato y es lo que avisa del recorte. El RMS necesitaría acumular cuadrados por bloque. Es la misma técnica y se puede añadir después si el dueño quiere un VU más «lento».
- **Si la hipótesis del síntoma 2 se confirma** (el motor no sabe qué canción muestra Mezcla), con este diseño los medidores siguen el audio que **suena**, que es lo correcto. Si Mezcla muestra otra canción, sus medidores quedarán a 0. Eso deja de ser un fallo y pasa a ser verdad.
- **Fuera de alcance:** las llamadas `invoke(...).catch(() => {})` de volumen, pan, mute, solo y bus (`nativeAudioEngine.ts` ~l.514–538) incumplen la regla de no tragar errores. Se recomienda una tarea aparte.
