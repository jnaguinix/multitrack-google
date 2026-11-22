use std::io::Read;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use crate::audio::pitch::PitchShifter;
use crate::audio::resampler::TrackResampler;

/// Lee hasta llenar `buf` o llegar al final. Devuelve los bytes leídos y el error de lectura, si lo hubo (llegar al
/// final del archivo no es un error).
fn read_available<R: Read>(reader: &mut R, buf: &mut [u8]) -> (usize, Option<std::io::Error>) {
    let mut filled = 0;
    while filled < buf.len() {
        match reader.read(&mut buf[filled..]) {
            Ok(0) => break,
            Ok(n) => filled += n,
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(e) => return (filled, Some(e)),
        }
    }
    (filled, None)
}

/// Lee `frames` fotogramas en `out_l`/`out_r`. Lo que el archivo ya no tiene (pasado su final) sale en silencio.
pub fn read_frames_to_slices<R: Read>(
    reader: &mut R,
    is_mono: bool,
    frames: usize,
    out_l: &mut [f32],
    out_r: &mut [f32],
) -> Option<std::io::Error> {
    let bytes_per_frame = if is_mono { 2 } else { 4 };
    let mut buf = vec![0u8; frames * bytes_per_frame];
    let (got, err) = read_available(reader, &mut buf);
    let real = got / bytes_per_frame;
    for i in 0..real {
        if is_mono {
            let s = i16::from_le_bytes([buf[i * 2], buf[i * 2 + 1]]) as f32 / 32768.0;
            out_l[i] = s;
            out_r[i] = s;
        } else {
            out_l[i] = i16::from_le_bytes([buf[i * 4], buf[i * 4 + 1]]) as f32 / 32768.0;
            out_r[i] = i16::from_le_bytes([buf[i * 4 + 2], buf[i * 4 + 3]]) as f32 / 32768.0;
        }
    }
    out_l[real..frames].fill(0.0);
    out_r[real..frames].fill(0.0);
    err
}

/// Añade a `staging` **exactamente** `frames` fotogramas: los que haya en el archivo y, pasado su final, silencio.
///
/// Así una pista más corta que la canción sigue avanzando al ritmo del reloj aunque ya no tenga audio: su posición
/// coincide siempre con la de la canción y, si un salto de sección o un vamp vuelve a una zona donde sí tiene audio,
/// vuelve a sonar en su sitio. (Antes, al acabarse el archivo no se añadía nada —ni siquiera la parte que sí estaba—
/// y la pista se quedaba muda tras saltar hacia atrás.)
pub fn read_into_staging<R: Read>(
    reader: &mut R,
    is_mono: bool,
    frames: usize,
    staging: &mut [Vec<f32>],
) -> Option<std::io::Error> {
    if frames == 0 {
        return None;
    }
    let bytes_per_frame = if is_mono { 2 } else { 4 };
    let mut buf = vec![0u8; frames * bytes_per_frame];
    let (got, err) = read_available(reader, &mut buf);
    let real = got / bytes_per_frame;
    if is_mono {
        let ch0 = &mut staging[0];
        ch0.reserve(frames);
        for i in 0..real {
            ch0.push(i16::from_le_bytes([buf[i * 2], buf[i * 2 + 1]]) as f32 / 32768.0);
        }
        ch0.resize(ch0.len() + (frames - real), 0.0);
    } else {
        let (ch0, rest) = staging.split_at_mut(1);
        let (ch0, ch1) = (&mut ch0[0], &mut rest[0]);
        ch0.reserve(frames);
        ch1.reserve(frames);
        for i in 0..real {
            ch0.push(i16::from_le_bytes([buf[i * 4], buf[i * 4 + 1]]) as f32 / 32768.0);
            ch1.push(i16::from_le_bytes([buf[i * 4 + 2], buf[i * 4 + 3]]) as f32 / 32768.0);
        }
        ch0.resize(ch0.len() + (frames - real), 0.0);
        ch1.resize(ch1.len() + (frames - real), 0.0);
    }
    err
}

/// Micro-fundido de salida de los últimos `fade_frames` fotogramas del ARCHIVO de una pista. Una pista que acaba
/// antes que la canción (un loop, una guía corta) y cuyo audio termina con la señal lejos de cero se cortaría en
/// seco al llegar el silencio de relleno: un clic. `first_frame` es el fotograma del archivo del primer fotograma
/// que se añadió a `staging` desde `start_idx`. Solo toca los fotogramas del tramo final; el resto no cambia.
pub fn apply_tail_fade(staging: &mut [Vec<f32>], start_idx: usize, first_frame: u64, total_frames: u64, fade_frames: usize) {
    if fade_frames == 0 || total_frames == 0 {
        return;
    }
    let fade_start = total_frames.saturating_sub(fade_frames as u64);
    for ch in staging.iter_mut() {
        let n = ch.len().saturating_sub(start_idx);
        for i in 0..n {
            let frame = first_frame + i as u64;
            if frame >= fade_start && frame < total_frames {
                // De ~1 a ~0 a lo largo del tramo; el fotograma siguiente (relleno) es 0.
                let gain = (total_frames - frame) as f32 - 0.5;
                ch[start_idx + i] *= gain / fade_frames as f32;
            }
        }
    }
}

/// `read_into_staging` + micro-fundido de final de archivo (ver `apply_tail_fade`). `first_frame` es el fotograma
/// del archivo en el que empieza esta lectura.
pub fn read_into_staging_faded<R: Read>(
    reader: &mut R,
    is_mono: bool,
    frames: usize,
    staging: &mut [Vec<f32>],
    first_frame: u64,
    total_frames: u64,
    fade_frames: usize,
) -> Option<std::io::Error> {
    let start_idx = staging.first().map_or(0, |c| c.len());
    let err = read_into_staging(reader, is_mono, frames, staging);
    apply_tail_fade(staging, start_idx, first_frame, total_frames, fade_frames);
    err
}

/// Registra el primer fallo de lectura del archivo de una pista. Los siguientes se omiten para no inundar el
/// registro (el hilo de lectura lee cada ~20 ms); lo que no se pudo leer ya sonó como silencio.
pub fn report_read_error(already_reported: &mut bool, path: &std::path::Path, err: Option<std::io::Error>) {
    if let Some(e) = err {
        if !*already_reported {
            *already_reported = true;
            eprintln!("[Feeder] Error leyendo {}: {e}. Lo que no se pudo leer suena en silencio.", path.display());
        }
    }
}

/// Pasa lo que haya en `input_staging` por el remuestreador y, si `shifter` es `Some`, por el cambio de tono (que
/// conserva la duración: entra y sale lo mismo, salvo el retardo inicial que él mismo compensa). El vaciado parcial
/// (`allow_partial`, solo lo usan las pruebas) no pasa por el cambio de tono.
pub fn drain_staging_through_resampler(
    resampler: &mut TrackResampler,
    mut shifter: Option<&mut PitchShifter>,
    is_mono: bool,
    input_staging: &mut [Vec<f32>],
    output_staging: &mut Vec<f32>,
    delay_compensated: &mut bool,
    allow_partial: bool,
) {
    let chunk_size = resampler.chunk_size;

    while input_staging[0].len() >= chunk_size {
        let mut in_chunk: Vec<Vec<f32>> = Vec::with_capacity(input_staging.len());
        for ch in input_staging.iter_mut() {
            let chunk: Vec<f32> = ch.drain(..chunk_size).collect();
            in_chunk.push(chunk);
        }

        if let Ok(mut processed) = resampler.process(&in_chunk) {
            let out_frames = processed[0].len();
            let start_frame = if !*delay_compensated {
                *delay_compensated = true;
                resampler.output_delay().min(out_frames)
            } else {
                0
            };

            if let Some(sh) = shifter.as_deref_mut() {
                if start_frame > 0 {
                    for ch in processed.iter_mut() {
                        ch.drain(..start_frame);
                    }
                }
                processed = sh.process(&processed);
                push_interleaved(&processed, 0, is_mono, output_staging);
            } else {
                push_interleaved(&processed, start_frame, is_mono, output_staging);
            }
        }
    }

    if allow_partial && !input_staging[0].is_empty() {
        let partial_len = input_staging[0].len();
        let was_compensated = *delay_compensated;
        let delay = resampler.output_delay();
        // Fotogramas de salida que corresponden a lo que entró: n por la relación de remuestreo, más el
        // retardo del filtro, que quedó pendiente en los bloques anteriores. Si el retardo aún no se
        // había compensado, los primeros `delay` fotogramas de la salida se descartan y no cuentan.
        let mut needed = (partial_len as f64 * resampler.resample_ratio()).round() as usize
            + if was_compensated { delay } else { 0 };
        let mut to_skip = if was_compensated { 0 } else { delay };
        *delay_compensated = true;

        // El bloque parcial se completa con ceros. No se usa `process_partial` de rubato: devuelve
        // siempre un bloque entero de salida (con relleno), y empalmar ese relleno insertaría silencio y
        // retrasaría el audio en cada salto de sección o vuelta de vamp.
        let mut chunk_in: Vec<Vec<f32>> = input_staging
            .iter_mut()
            .map(|ch| {
                let mut v: Vec<f32> = ch.drain(..).collect();
                v.resize(chunk_size, 0.0);
                v
            })
            .collect();
        // Con n cercano al tamaño del bloque hacen falta uno o dos bloques más de ceros para sacar todo.
        for _ in 0..4 {
            let Ok(processed) = resampler.process(&chunk_in) else { break };
            let out_frames = processed[0].len();
            let from = to_skip.min(out_frames);
            to_skip -= from;
            let take = needed.min(out_frames - from);
            for i in from..from + take {
                if is_mono {
                    let s = processed[0][i];
                    output_staging.push(s);
                    output_staging.push(s);
                } else {
                    output_staging.push(processed[0][i]);
                    output_staging.push(processed[1][i]);
                }
            }
            needed -= take;
            if needed == 0 {
                break;
            }
            for ch in chunk_in.iter_mut() {
                ch.fill(0.0);
            }
        }
    }
}

/// Prepara el remuestreador para un tramo nuevo del archivo: descarta el estado del tramo anterior y vuelve a
/// compensar el retardo del filtro, igual que tras un seek. NO se usa en los empalmes (salto de sección o vuelta
/// de vamp): esos entran al remuestreador como una señal continua, sin reiniciarlo (ver `mod.rs`). Hoy solo la
/// llama una prueba.
pub fn begin_new_segment(resampler: &mut TrackResampler, delay_compensated: &mut bool) {
    resampler.reset();
    *delay_compensated = false;
}

/// Añade al anillo de salida (intercalado L, R; el mono se duplica) los fotogramas de `block` desde `from`.
fn push_interleaved(block: &[Vec<f32>], from: usize, is_mono: bool, output_staging: &mut Vec<f32>) {
    let frames = block[0].len();
    for i in from..frames {
        if is_mono {
            let s = block[0][i];
            output_staging.push(s);
            output_staging.push(s);
        } else {
            output_staging.push(block[0][i]);
            output_staging.push(block[1][i]);
        }
    }
}

/// Marca `feeder_alive = false` cuando el hilo feeder termina por cualquier camino (incluido un pánico),
/// para que quien espera su confirmación de seek no espere para siempre.
pub struct FeederAliveGuard(pub Arc<AtomicBool>);

impl Drop for FeederAliveGuard {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}
