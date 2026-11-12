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
        let partial_in: Vec<Vec<f32>> = input_staging.iter_mut().map(|ch| ch.drain(..).collect()).collect();
        if let Ok(processed) = resampler.process_partial(Some(&partial_in)) {
            if !processed.is_empty() {
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
    }
}
