# Plan: tiempo de generación de la caché PCM (Tarea 1)

**Estado: PENDIENTE DE APROBACIÓN del dueño. No implementar nada sin su visto bueno.**
Fecha de las mediciones: 2026-11-12. Máquina: i5-1135G7 (4 núcleos / 8 hilos), 15,7 GB de RAM, conectada a corriente, plan «Equilibrado», Focusrite a 48 kHz.

Este documento es autosuficiente: quien lo ejecute no necesita la conversación donde se midió.

---

## 1. Mediciones (todas en release, con archivos reales)

Herramienta: `desktop/src-tauri/examples/medir_cache.rs` (rama `diag/tiempo-cache`). Llama a `import::decode_and_cache_track` con la misma concurrencia que `audio_import_tracks`.

Canciones de prueba:
- **ERES**: 7 MP3 estéreo 44,1 kHz, 4:20. `C:\Users\jpuerta\Downloads\Eres Bendigo - Jaime Murrel`
- **DIOS**: 10 MP3 44,1 kHz (8 estéreo, 2 mono efectivo), 8:00. `C:\Users\jpuerta\Music\multis\Dios el mas grande - Juan Carlos A -Bb124\Dios el mas grande - Juan Carlos A - GV\Dios el mas grande - Juan Carlos A - MT`

### 1.1 Tiempo total por canción

| Configuración | ERES (7 pistas) | DIOS (10 pistas) | Pico de RAM (DIOS) |
|---|---|---|---|
| 1 hilo | 10,7 s | 27,3 s | No medido |
| **4 hilos (lo que hace hoy la app)** | 4,2 – 5,3 s (un caso 7,1) | 11,0 – 14,7 s | **1,7 GB** |
| 4 hilos dentro del `.exe` real | 4,68 s | 13,69 / 14,67 s | No medido |
| 6 hilos | 4,4 – 4,5 s | 10,4 – 10,6 s | No medido |
| 8 hilos | **3,1 – 3,3 s** | 9,9 – 11,9 s | **3,3 GB** |
| 4 hilos, destino 44,1 kHz (sin remuestreo) | **2,8 – 3,0 s** | **7,4 – 7,6 s** | No medido |

La variación entre tandas idénticas llega al ±15 %. Cualquier mejora menor del 10 % solo se puede afirmar con la mediana de 5 tandas.

### 1.2 Reparto por fase (por pista estéreo de 4:20, con 4 hilos)

| Fase | Tiempo | Parte |
|---|---|---|
| Decodificación MP3 (Symphonia) | 0,76 s | ~30 % |
| Detección mono | 0,03 s | ~1 % |
| Remuestreo 44,1 → 48 kHz (rubato `FftFixedInOut`) | 0,63 s | ~25 % |
| Picos | 0,2 ms | 0 % |
| Cuantización a i16 con dither | 0,50 s | ~20 % |
| Escritura a disco | 0,60 s | ~24 % |

### 1.3 Techo del hardware (microprueba aparte, sin el proyecto)

Trabajo de CPU puro, sin memoria grande ni disco, repartido en hilos:

| Hilos | Aceleración total | Cada hilo va |
|---|---|---|
| 2 | ×1,56 | ×1,28 más lento |
| 4 | **×2,62** | ×1,53 más lento |
| 8 | ×3,16 | ×2,53 más lento |

La app consigue ×2,2 – ×2,5 con 4 hilos. **Está cerca del techo del procesador (×2,62).** El portátil baja la frecuencia cuando trabajan todos los núcleos.

### 1.4 Cuantización (microprueba, 46 millones de muestras)

| Variante | ns por muestra | Salida |
|---|---|---|
| Código actual | 9,6 – 10,0 | referencia |
| Sin `push` | 8,9 – 9,8 | idéntica byte a byte |
| Sin `push` + redondeo sin llamada a `roundf` | 7,2 – 7,5 (−28 %) | idéntica byte a byte |

El redondeo rápido `(x + 0.49999997f32.copysign(x)) as i32` se comprobó contra `x.round()` en **los 2 382 364 672 valores f32 con |x| < 32768: cero diferencias.**

---

## 2. Evaluación de las opciones

### Corrección al diagnóstico anterior
Se había supuesto que el cuello de botella era la memoria (1,6 GB en RAM). **Las mediciones lo desmienten:** el límite es el procesador. La memoria explica como mucho la diferencia entre ×2,2 – 2,5 y ×2,62.

### Opción A — Procesar por bloques (streaming): **NO hacer ahora**
- **Ganancia de tiempo:** No medida; por el punto 1.3 se espera pequeña (menos del 15 %).
- **Ganancia real:** RAM. De 1,7 GB a menos de 100 MB estimados (No medido).
- **Obstáculos encontrados al leer el código:**
  1. La detección mono (`is_effectively_mono`) necesita la pista entera antes de decidir si se remuestrea 1 canal o 2. En streaming hay que remuestrear siempre en estéreo y mezclar al final, y el resultado **ya no es idéntico byte a byte** para pistas mono.
  2. La semilla del dither depende del número total de frames (`frame_count ^ target_sample_rate`), que en streaming no se conoce hasta el final.
- **Riesgo:** alto. Reescribe el núcleo de la importación justo antes del ensayo.
- **Cuándo reconsiderarla:** si aparece un problema de memoria (canciones muy largas, equipos de 8 GB) o si se quiere subir de hilos sin gastar 3,3 GB.

### Opción B — Optimizaciones pequeñas: **SÍ, solo las idénticas byte a byte**
- **Ganancia medida:** cuantización −28 % de su fase, es decir, un 4 – 5 % del total.
- **Ganancia estimada del resto** (reservar memoria al decodificar, reutilizar los buffers del remuestreador): No medida. En conjunto se espera un 5 – 12 %.
- **Extra sin coste:** liberar el audio decodificado en cuanto termina el remuestreo baja el pico de RAM alrededor de un 25 % (estimado, No medido).
- **Riesgo:** bajo. Cada paso se valida con una prueba de «salida idéntica» y se mide; si no mejora, se descarta.
- **Descartado dentro de B:** cambiar el generador del dither sería más rápido, pero cambia los bytes del PCM.

### Opción C — Progreso real: **SÍ, y es la que más se nota**
- No acelera nada. Hoy el porcentaje se calcula con el número de la pista cuando *empieza* (`audio/mod.rs`, `percent: idx / total`), así que con 4 hilos salta y se queda parado.
- Propuesta mejorada: 4 marcas por pista (decodificada, remuestreada, cuantizada, escrita). Con 10 pistas son 40 pasos, siempre hacia delante.
- **Riesgo:** bajo.

### Opciones nuevas que salieron de las mediciones

**D — Más hilos cuando no suena nada: decisión del dueño, mejor después del ensayo**
- Medido: ERES baja de ~4,5 s a ~3,2 s (−29 %). DIOS apenas mejora (−5 %, dentro del ruido).
- Coste medido: 3,3 GB de RAM con pistas de 8 minutos.
- Riesgo No medido: generar caché con los 8 hilos mientras suena otra canción puede provocar cortes de audio. Por eso solo se plantea con el transporte detenido y con un límite de memoria.

**E — Trabajar a 44,1 kHz: decisión del dueño, sin tocar código**
- Medido: −31 % (ERES 2,9 s; DIOS 7,5 s). Desaparece el remuestreo y, al coincidir las frecuencias, también el dither.
- Solo conviene si casi todo el repertorio está a 44,1 kHz. Las pistas a 48 kHz pasarían a remuestrearse.
- Hay que regenerar las cachés existentes (están en `pcm/<id>/48000/`).
- No verificado: que la Scarlett y Windows queden realmente a 44,1 kHz al cambiarlo en la app.

### Veredicto
1. **Hacer C** (progreso real).
2. **Hacer B** (solo cambios idénticos byte a byte, medidos uno a uno).
3. **No hacer A** ahora.
4. **D y E**: las decide el dueño; no forman parte de este plan salvo aprobación expresa.

Resultado esperado de B + C: entre un 5 y un 12 % más rápido, alrededor de un 25 % menos de RAM y un porcentaje que avanza de forma continua. **No hay ninguna opción de código de bajo riesgo que baje los ~14 s de DIOS a la mitad**; lo impide el procesador. La caché se genera una sola vez por canción y se conserva al cerrar la app (comprobado por el dueño el 2026-11-12).

---

## 3. Plan de ejecución (para cuando se apruebe)

### Reglas que aplican (resumen de `CLAUDE.md`)
- Rama nueva desde `motor-nativo`: **`perf/tiempo-cache`**. Nunca `main`.
- Un cambio lógico por commit. `.\verify.ps1` rápido por commit; `.\verify.ps1 -Completo` al cerrar.
- UTF-8 sin BOM. No tragar errores. No tocar el callback de audio (`ensure_stream`).
- Prueba antes del cambio. Lo no ejecutado se reporta como «No medido».
- Rust no está en el PATH. Antes de `verify.ps1` o de `cargo`:
  ```powershell
  $t="C:\Users\jpuerta\.codex\visualizations\2026\11\09\01a1be2f-be92-7153-bd62-a2684be8afbf"; $env:CARGO_HOME="$t\cargo"; $env:RUSTUP_HOME="$t\rustup"; $env:PATH="$t\cargo\bin;$env:PATH"
  ```
- La app debe estar cerrada para compilar el `.exe` (si no, «Acceso denegado»).

### Paso 0 — Preparar herramientas de medición
1. `git checkout motor-nativo && git checkout -b perf/tiempo-cache`.
2. `git cherry-pick 0a8463a fdfcdc0` (logs `[Import Perf Fases]` y ejemplo `medir_cache`; solo diagnóstico).
3. Añadir a `medir_cache.rs` la opción `--hash`: tras generar, imprimir por pista un hash FNV-1a de 64 bits del archivo `.pcm` (implementado a mano, sin dependencias nuevas) y no borrar la carpeta temporal hasta haberlo calculado.
4. Añadir la opción `--tandas N` que repite la medición e imprime la **mediana** del total.
5. Guardar la referencia **antes de cualquier cambio**:
   ```powershell
   cargo run --release --manifest-path desktop/src-tauri/Cargo.toml --example medir_cache -- --hash --tandas 5 "<carpeta ERES>"
   cargo run --release --manifest-path desktop/src-tauri/Cargo.toml --example medir_cache -- --hash --tandas 5 "<carpeta DIOS>"
   ```
   Anotar las 17 huellas y las dos medianas en el reporte.

Commit: `diag: añadir --hash y --tandas a medir_cache`.

### Paso 1 — Prueba de «salida idéntica» (antes de optimizar)
En `desktop/src-tauri/src/audio/import.rs`, módulo `tests`:
1. `test_pcm_golden_hashes`: genera WAV sintéticos deterministas y pasa cada uno por `decode_and_cache_track`. Casos:
   - 44,1 kHz estéreo 16 bit con canales distintos (ruta con remuestreo y dither).
   - 44,1 kHz estéreo 24 bit.
   - 48 kHz estéreo 16 bit (ruta exacta, sin dither).
   - 44,1 kHz estéreo con L = R (mono efectivo).
   - Una señal que supere ±1,0 tras el dither (recorte).
   Compara el FNV-1a del `.pcm` con constantes.
2. Procedimiento: escribir la prueba imprimiendo las huellas, ejecutarla **sobre el código sin modificar**, pegar las constantes y confirmar que pasa.

Commit: `test(import): fijar huellas del PCM generado antes de optimizar`.

### Paso 2 — Opción C: progreso real
**Rust**
1. En `import.rs`, añadir `pub enum ImportPhase { Decoded, Resampled, Quantized, Written }` y `decode_and_cache_track_with_progress(..., on_phase: &dyn Fn(ImportPhase))`. `decode_and_cache_track` queda como envoltorio con un cierre vacío (no cambia su firma; la usan pruebas y el ejemplo). Un acierto de caché emite las cuatro fases de golpe.
2. En `import.rs`, añadir `pub struct ImportProgressTracker` (pura, sin Tauri): `new(total_tracks)`, `advance() -> (unidades, percent)` con `AtomicUsize`, 4 unidades por pista. `percent` nunca llega a 100 hasta el evento final.
3. Pruebas unitarias del tracker: monótono, 40 pasos para 10 pistas, tope en 99 antes del final, `total_tracks = 0` no divide por cero.
4. En `audio/mod.rs`, `audio_import_tracks`: sustituir `percent: idx / total` por el tracker. `track_index` pasa a ser el número de pistas **terminadas**. Los `let _ = app.emit(...)` de esta función pasan a registrar el error con `tracing::warn!` (regla de no tragar errores).

**TypeScript**
5. En `nativeAudioEngine.ts`, `setupEventListeners`: si ya hay progreso de ese proyecto sin completar, `percent = max(anterior, nuevo)` y `trackNumber = max(anterior, nuevo)`. Los eventos llegan de varios hilos y pueden cruzarse.
6. Prueba 8 en `test/nativeCacheGeneration.test.ts`: emitir porcentajes desordenados (30, 20, 45) y comprobar que el motor expone 30, 30, 45; y que `markImportStarted` vuelve a 0.

Commits: `feat(import): progreso de caché por fases terminadas` y `fix(native): progreso de importación siempre creciente`.

### Paso 3 — Opción B: un commit por optimización, cada uno medido
Después de **cada** commit: `test_pcm_golden_hashes` en verde, `medir_cache --hash --tandas 5` con las 17 huellas iguales a la referencia y la mediana anotada. **Si la mediana no mejora al menos un 3 % respecto al commit anterior, revertir ese commit y decirlo en el reporte.**

- **B1 — Cuantización.** En `import.rs`:
  - Añadir `#[inline] fn round_half_away_fast(x: f32) -> i32 { (x + 0.49999997f32.copysign(x)) as i32 }` y usarla en `quantize_f32_to_i16_with_dither` y `quantize_f32_to_i16_exact` en lugar de `.round()`.
  - Prueba: equivalencia con `.round()` recorriendo los patrones de bits de 0 a `0x4700_0000` con paso 97, en positivo y negativo, más los límites (±0,5; ±32766,5; ±32767).
  - Sacar el `if is_exact_16bit` fuera del bucle y escribir en un `vec![0i16; n]` con `chunks_exact_mut(2).zip(...)` en vez de `push`. **Mantener el orden de las llamadas al generador: canal 0 y luego canal 1 por frame.**
  - Unificar la cola duplicada de `decode_and_cache_track` y `decode_and_cache_track_bytes` (mono, remuestreo, cuantización, escritura) en una función privada común. Es un refactor puro; va en su propio commit **antes** de B1.
- **B2 — Remuestreador.** En `resample_channels`: reutilizar los buffers de entrada y salida con `process_into_buffer`, reservar la capacidad de salida y copiar con `copy_from_slice`. **No cambiar `chunk_size = 1024`, ni el relleno con ceros del último bloque, ni el recorte `expected_out`** (cambian los bytes y el retardo).
- **B3 — Decodificación.** En `decode_audio_stream`: reservar capacidad con `track.codec_params.n_frames` cuando exista.
- **B4 — Memoria.** Soltar (`drop`) los canales decodificados en cuanto termina el remuestreo. Medir el pico de RAM antes y después (ver 3.1).

### Paso 4 — Cierre
1. `.\verify.ps1 -Completo` (la app cerrada).
2. Medición final dentro del `.exe`: abrirlo con `*>> "$env:TEMP\omnitracks-perf.txt"` (doble `>` para no sobrescribir), apartar la caché (`Rename-Item "$env:LOCALAPPDATA\org.omnitracks.desktop\pcm" "pcm.bak-perf"`), añadir ERES y DIOS al setlist y leer del log las líneas `Canción '...' completada: N pistas procesadas en ...`.
3. Pedir al dueño que confirme en la interfaz que el porcentaje avanza de forma continua hasta «Lista».
4. Reporte con tabla antes/después (mediana de 5), huellas iguales sí/no, pico de RAM, y lo «No medido».
5. No fusionar en `motor-nativo` sin el visto bueno del dueño.

### 3.1 Cómo medir el pico de RAM
```powershell
$exe="desktop\src-tauri\target\release\examples\medir_cache.exe"; $o="$env:TEMP\ram.txt"
$p=Start-Process $exe -ArgumentList '"<carpeta DIOS>"' -RedirectStandardOutput $o -RedirectStandardError "$o.err" -NoNewWindow -PassThru
$peak=0; while(-not $p.HasExited){ try{$p.Refresh(); if($p.PeakWorkingSet64 -gt $peak){$peak=$p.PeakWorkingSet64}}catch{}; Start-Sleep -Milliseconds 100 }
"pico RAM: $([int]($peak/1MB)) MB"
```
Hay que redirigir la salida a archivo: si se deja en una tubería sin leer, el proceso se bloquea.

### Criterios de «hecho»
- Las 17 huellas de PCM reales y las de la prueba sintética no cambian.
- Mediana de 5 tandas mejor que la referencia en ERES y en DIOS (se espera 5 – 12 %; si sale menos, se reporta tal cual).
- El porcentaje nunca retrocede (prueba 8) y el dueño lo ve avanzar.
- `verify.ps1 -Completo` en verde.

### Fuera de alcance (no tocar)
- Opción A (streaming), opción D (más hilos) y opción E (44,1 kHz).
- El generador del dither, `chunk_size` del remuestreador y el formato de la caché (`CACHE_FORMAT_VERSION`).
- El callback de audio y la ruta de importación por IndexedDB (eso es la Tarea 2).
