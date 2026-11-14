use std::io::Read;
use crate::audio::resampler::TrackResampler;

pub fn read_frames_to_slices<R: Read>(
    reader: &mut R,
    is_mono: bool,
    frames: usize,
    out_l: &mut [f32],
    out_r: &mut [f32],
) {
    let bytes_per_frame = if is_mono { 2 } else { 4 };
    let mut buf = vec![0u8; frames * bytes_per_frame];
    if reader.read_exact(&mut buf).is_ok() {
        if is_mono {
            for i in 0..frames {
                let s = i16::from_le_bytes([buf[i * 2], buf[i * 2 + 1]]) as f32 / 32768.0;
                out_l[i] = s;
                out_r[i] = s;
            }
        } else {
            for i in 0..frames {
                out_l[i] = i16::from_le_bytes([buf[i * 4], buf[i * 4 + 1]]) as f32 / 32768.0;
                out_r[i] = i16::from_le_bytes([buf[i * 4 + 2], buf[i * 4 + 3]]) as f32 / 32768.0;
            }
        }
    } else {
        out_l[..frames].fill(0.0);
        out_r[..frames].fill(0.0);
    }
}

pub fn read_into_staging<R: Read>(
    reader: &mut R,
    is_mono: bool,
    frames: usize,
    staging: &mut [Vec<f32>],
) {
    if frames == 0 {
        return;
    }
    let bytes_per_frame = if is_mono { 2 } else { 4 };
    let mut buf = vec![0u8; frames * bytes_per_frame];
    if let Ok(()) = reader.read_exact(&mut buf) {
        if is_mono {
            let ch0 = &mut staging[0];
            ch0.reserve(frames);
            for i in 0..frames {
                let s = i16::from_le_bytes([buf[i * 2], buf[i * 2 + 1]]) as f32 / 32768.0;
                ch0.push(s);
            }
        } else {
            let (ch0, rest) = staging.split_at_mut(1);
            let ch1 = &mut rest[0];
            ch0[0].reserve(frames);
            ch1.reserve(frames);
            for i in 0..frames {
                let l = i16::from_le_bytes([buf[i * 4], buf[i * 4 + 1]]) as f32 / 32768.0;
                let r = i16::from_le_bytes([buf[i * 4 + 2], buf[i * 4 + 3]]) as f32 / 32768.0;
                ch0[0].push(l);
                ch1.push(r);
            }
        }
    }
}

pub fn drain_staging_through_resampler(
    resampler: &mut TrackResampler,
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

        if let Ok(processed) = resampler.process(&in_chunk) {
            let out_frames = processed[0].len();
            let start_frame = if !*delay_compensated {
                *delay_compensated = true;
                resampler.output_delay().min(out_frames)
            } else {
                0
            };

            for i in start_frame..out_frames {
                if is_mono {
                    let s = processed[0][i];
                    output_staging.push(s);
                    output_staging.push(s);
                } else {
                    output_staging.push(processed[0][i]);
                    output_staging.push(processed[1][i]);
                }
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

/// Prepara el remuestreador para un tramo nuevo del archivo tras un empalme (salto de sección o
/// vuelta de vamp): descarta el estado del tramo anterior y vuelve a compensar el retardo del filtro,
/// igual que tras un seek.
pub fn begin_new_segment(resampler: &mut TrackResampler, delay_compensated: &mut bool, pitch_semitones: i32) {
    resampler.reset();
    let _ = resampler.set_pitch(pitch_semitones, false);
    *delay_compensated = false;
}
