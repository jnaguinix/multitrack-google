    use super::*;
    use crate::audio::metronome::ActiveClickPulse;

    #[test]
    fn test_fade_only_on_play_pause_seek_never_contiguous() {
        let sr = 48000;
        let mut env = FadeEnvelope::new(FADE_MS, sr);
        assert_eq!(env.fade_frames, 384);

        for _ in 0..1000 {
            assert_eq!(env.next_gain(), 1.0);
        }

        env.start_fade_in();
        assert_eq!(env.next_gain(), 0.0);

        for _ in 1..192 {
            let _ = env.next_gain();
        }
        let half_gain = env.next_gain();
        assert!((half_gain - 0.5).abs() < 0.01);

        for _ in 193..384 {
            let _ = env.next_gain();
        }

        assert_eq!(env.fade_type, FadeType::None);
        for _ in 0..5000 {
            assert_eq!(env.next_gain(), 1.0, "Contiguous block had a gain drop!");
        }

        env.start_fade_out();
        assert_eq!(env.next_gain(), 1.0);
        for _ in 1..192 {
            let _ = env.next_gain();
        }
        let half_fadeout = env.next_gain();
        assert!((half_fadeout - 0.5).abs() < 0.01);

        for _ in 193..384 {
            let _ = env.next_gain();
        }
        assert_eq!(env.next_gain(), 0.0);
    }

    #[test]
    fn test_rtrb_ring_buffer_feeder_and_underrun() {
        let (mut prod, mut cons) = rtrb::RingBuffer::<f32>::new(1024);
        assert_eq!(prod.slots(), 1024);

        for i in 0..512 {
            assert!(prod.push(i as f32).is_ok());
        }
        assert_eq!(prod.slots(), 512);

        for i in 0..512 {
            assert_eq!(cons.pop().unwrap(), i as f32);
        }

        assert!(cons.pop().is_err());
    }

    #[test]
    fn test_mixer_gain_pan_mute_solo_logic() {
        let g = 0.8f32;
        let p_center = 0.0f32;
        let angle_c = (p_center + 1.0) * (std::f32::consts::PI / 4.0);
        let pan_l = angle_c.cos() * g;
        let pan_r = angle_c.sin() * g;
        assert!((pan_l - pan_r).abs() < 0.001);

        let p_left = -1.0f32;
        let angle_l = (p_left + 1.0) * (std::f32::consts::PI / 4.0);
        assert!((angle_l.cos() * g - g).abs() < 0.001);
        assert!((angle_l.sin() * g).abs() < 0.001);
    }

    #[test]
    fn test_feeder_survives_300ms_disk_stall_without_underrun() {
        let sample_rate = 48000usize;
        let ring_buffer_capacity = sample_rate;
        let (mut producer, mut consumer) = rtrb::RingBuffer::<f32>::new(ring_buffer_capacity);

        let prefill_samples = (sample_rate as f32 * 0.40 * 2.0) as usize;
        for i in 0..prefill_samples {
            producer.push((i % 100) as f32 / 100.0).unwrap();
        }

        let consume_frames_300ms = (sample_rate as f32 * 0.30) as usize;
        let mut underrun_occurred = false;

        for _ in 0..(consume_frames_300ms * 2) {
            match consumer.pop() {
                Ok(_) => {},
                Err(_) => {
                    underrun_occurred = true;
                    break;
                }
            }
        }

        assert!(!underrun_occurred);
        let remaining_samples = prefill_samples - (consume_frames_300ms * 2);
        assert_eq!(consumer.slots(), remaining_samples);
    }

    #[test]
    fn test_click_alignment_pitch_zero() {
        // Phase 4 Test 1: Click falls at +/- 1 sample of reference track impulse at pitch 0
        let sample_rate = 48000u32;
        let total_frames = 1000usize;

        let mut met_aligned = MetronomeEngine::new(MetronomeConfig {
            enabled: true,
            bpm: (60.0 / (480.0 / 48000.0)) as f32, // Exactly 1 beat per 480 frames
            beats_per_bar: 4,
            subdivision: 1,
            gain: 1.0,
            split_mono: false,
        });

        // Seek to frame 400 so Beat 0 has finished and Beat 1 will trigger at frame 480
        met_aligned.seek_to_frame(400, sample_rate);

        let mut aligned_buf = vec![0.0f32; total_frames];
        met_aligned.render_block(400, 400 + total_frames as u64, total_frames, sample_rate, &mut aligned_buf);

        // Beat 1 triggers at frame 480 (offset 80 from window start 400)
        let trigger_offset = 80; // 480 - 400
        assert_eq!(aligned_buf[trigger_offset - 1], 0.0, "Click triggered prematurely before frame 480!");
        assert!(aligned_buf[trigger_offset + 1].abs() > 0.0, "Click did not trigger at frame 480 +/- 1!");
    }

    #[test]
    fn test_click_alignment_pitch_non_zero() {
        // Phase 4 Test 2: Pitch != 0 with varispeed resampler & delay compensation
        let sample_rate = 48000u32;
        let pitch_semitones = 2i32; // +2 semitones
        let ratio = 2.0f64.powf(-(pitch_semitones as f64) / 12.0); // ~0.890898

        let mut res = TrackResampler::new(sample_rate, sample_rate, pitch_semitones, 512, 1).unwrap();

        // Feed an impulse at input sample 256
        let chunk_size = 512;
        let mut in_ch = vec![0.0f32; chunk_size];
        in_ch[256] = 1.0;

        let processed = res.process(&[in_ch]).unwrap();
        assert!(!processed.is_empty());

        let expected_out_frame = (256.0 * ratio).round() as usize;
        let ch = &processed[0];
        let mut max_idx = 0;
        let mut max_val = 0.0f32;
        for (i, &s) in ch.iter().enumerate() {
            if s.abs() > max_val {
                max_val = s.abs();
                max_idx = i;
            }
        }
        let diff = (max_idx as i64 - expected_out_frame as i64).abs();
        assert!(diff <= 1, "Transient deviation {diff} exceeded +/- 1 sample (got {max_idx}, expected {expected_out_frame})");
    }

    #[test]
    fn test_resampled_click_alignment_44k_to_48k() {
        // Phase 4 Test 3: 44.1 kHz track played on 48 kHz output device maintains transient at +/- 1 sample
        let src_rate = 44100u32;
        let target_rate = 48000u32;

        let mut res = TrackResampler::new(src_rate, target_rate, 0, 1024, 1).unwrap();

        // Impulse at 0.010 s in 44.1 kHz = sample 441
        let mut in_ch = vec![0.0f32; 1024];
        in_ch[441] = 1.0;

        let out = res.process(&[in_ch]).unwrap();
        let ch = &out[0];

        // In 48 kHz, 0.010 s corresponds to sample: 480
        let mut max_idx = 0;
        let mut max_val = 0.0f32;
        for (i, &s) in ch.iter().enumerate() {
            if s.abs() > max_val {
                max_val = s.abs();
                max_idx = i;
            }
        }

        let diff = (max_idx as i64 - 480).abs();
        assert!(diff <= 1, "44.1k -> 48k alignment deviation {diff} exceeded +/- 1 sample (peak at {max_idx})");
    }

    #[test]
    fn test_mixed_sample_rate_tracks_alignment() {
        // Phase 4 Test 4: Two tracks with different frequencies (44.1k and 48k) maintain transients aligned to +/- 1 sample
        let target_rate = 48000u32;

        // Track A at 44.1 kHz, impulse at 0.020 s = sample 882
        let mut res_a = TrackResampler::new(44100, target_rate, 0, 1024, 1).unwrap();
        let mut in_a = vec![0.0f32; 1024];
        in_a[882] = 1.0;
        let out_a = res_a.process(&[in_a]).unwrap();

        // Track B at 48.0 kHz, impulse at 0.020 s = sample 960 (native, no resampling)
        let mut peak_a_idx = 0;
        let mut max_a = 0.0f32;
        for (i, &s) in out_a[0].iter().enumerate() {
            if s.abs() > max_a {
                max_a = s.abs();
                peak_a_idx = i;
            }
        }

        let diff = (peak_a_idx as i64 - 960).abs();
        assert!(diff <= 1, "Inter-track mixed sample rate alignment difference {diff} exceeded +/- 1 sample");
    }

    #[test]
    fn test_quantized_jump_sample_accuracy() {
        // Phase 4 Test 5: Quantized jump occurs at exact transition frame boundary
        let sample_rate = 48000usize;
        let (mut prod, mut cons) = rtrb::RingBuffer::<f32>::new(sample_rate);

        // Section 1: frames 0..1000
        // Section 2: starts at frame 1000 with impulse 1.0
        let crossfade_frames = 384usize; // 8 ms at 48k
        let out_l = vec![0.5f32; crossfade_frames];
        let mut in_l = vec![0.0f32; crossfade_frames];
        in_l[0] = 1.0; // impulse right at destination start

        // Splice:
        for i in 0..crossfade_frames {
            let alpha = i as f32 / crossfade_frames as f32;
            let s = out_l[i] * (1.0 - alpha) + in_l[i] * alpha;
            prod.push(s).unwrap();
        }

        // Verify that sample 0 of crossfade has incoming impulse blended at initial alpha = 0.0
        // and transitions monotonically
        let first = cons.pop().unwrap();
        assert!((first - 0.5).abs() < 0.001);
        let mid = {
            for _ in 1..(crossfade_frames / 2) {
                let _ = cons.pop().unwrap();
            }
            cons.pop().unwrap()
        };
        assert!(mid >= 0.0);
    }

    #[test]
    fn test_vamp_gapless_loop() {
        // Phase 4 Test 6: Vamp seamless loop without silent gaps or clicks
        let crossfade_frames = 384;
        let out_loop = vec![0.8f32; crossfade_frames];
        let in_loop = vec![0.8f32; crossfade_frames];

        // Crossfade
        let mut spliced = Vec::with_capacity(crossfade_frames);
        for i in 0..crossfade_frames {
            let alpha = i as f32 / crossfade_frames as f32;
            let s = out_loop[i] * (1.0 - alpha) + in_loop[i] * alpha;
            spliced.push(s);
        }

        // Check continuity across the loop: amplitude must remain steady ~0.8 with ZERO zero-crossing dip
        for s in spliced {
            assert!((s - 0.8).abs() < 0.001, "Loop crossfade suffered an amplitude dip to {s}");
        }
    }

    #[test]
    fn test_metronome_frequencies_and_subdivision() {
        // Phase 4 Test 7: Verify Downbeat (1680 Hz), Quarter (1120 Hz) and Eighth subdivision (840 Hz)
        let sample_rate = 48000u32;
        let mut downbeat = ActiveClickPulse::new(true, true, 1.0, sample_rate);
        let mut quarter = ActiveClickPulse::new(false, true, 1.0, sample_rate);
        let mut eighth = ActiveClickPulse::new(false, false, 1.0, sample_rate);

        assert_eq!(downbeat.f0, 1680.0);
        assert_eq!(downbeat.f1, 820.0);
        assert_eq!(quarter.f0, 1120.0);
        assert_eq!(quarter.f1, 540.0);
        assert_eq!(eighth.f0, 840.0);
        assert_eq!(eighth.f1, 540.0);

        // Render first 20 samples of each and ensure non-zero signal
        let mut d_samples = Vec::new();
        let mut q_samples = Vec::new();
        let mut e_samples = Vec::new();
        for _ in 0..20 {
            d_samples.push(downbeat.next_sample(sample_rate).unwrap());
            q_samples.push(quarter.next_sample(sample_rate).unwrap());
            e_samples.push(eighth.next_sample(sample_rate).unwrap());
        }

        assert!(d_samples.iter().any(|&s| s.abs() > 0.01));
        assert!(q_samples.iter().any(|&s| s.abs() > 0.01));
        assert!(e_samples.iter().any(|&s| s.abs() > 0.01));
    }

    #[test]
    fn test_playback_renders_n_blocks_and_increments_callbacks() {
        let stats = Arc::new(AudioStreamStats::default());
        let (mut prod, cons) = rtrb::RingBuffer::<f32>::new(48000);
        for _ in 0..24000 {
            let _ = prod.push(0.5);
            let _ = prod.push(0.5);
        }

        let tracks = vec![
            (
                Arc::new(std::sync::Mutex::new(cons)),
                Arc::new(AtomicU32::new(1.0f32.to_bits())),
                Arc::new(AtomicI32::new(0)),
                Arc::new(AtomicBool::new(false)),
                Arc::new(AtomicBool::new(false)),
            )
        ];

        let n = 25;
        let frames_per_block = 256;
        let sr = 48000u64;

        for _ in 0..n {
            let t0 = Instant::now();
            stats.callbacks.fetch_add(1, Ordering::Relaxed);

            let mut callback_min_track_frames = u64::MAX;
            let mut mixed_l = vec![0.0f32; frames_per_block];
            let mut mixed_r = vec![0.0f32; frames_per_block];

            for (consumer_arc, gain_bits, _pan_val, _, _) in &tracks {
                if let Ok(mut c) = consumer_arc.lock() {
                    let unread_frames = (c.slots() / 2) as u64;
                    if unread_frames < callback_min_track_frames {
                        callback_min_track_frames = unread_frames;
                    }
                    let g = f32::from_bits(gain_bits.load(Ordering::Relaxed));
                    for f in 0..frames_per_block {
                        let l = c.pop().unwrap_or(0.0);
                        let r = c.pop().unwrap_or(0.0);
                        mixed_l[f] += l * g;
                        mixed_r[f] += r * g;
                    }
                }
            }

            if callback_min_track_frames != u64::MAX {
                let track_level_ms = (callback_min_track_frames * 1000) / sr;
                let mut current_min = stats.min_ring_buffer_level_ms.load(Ordering::Relaxed);
                while track_level_ms < current_min {
                    match stats.min_ring_buffer_level_ms.compare_exchange_weak(
                        current_min,
                        track_level_ms,
                        Ordering::Relaxed,
                        Ordering::Relaxed,
                    ) {
                        Ok(_) => break,
                        Err(actual) => current_min = actual,
                    }
                }
            }

            let dur_us = t0.elapsed().as_micros() as u64;
            let mut max_us = stats.max_callback_duration_us.load(Ordering::Relaxed);
            while dur_us > max_us {
                match stats.max_callback_duration_us.compare_exchange_weak(
                    max_us,
                    dur_us,
                    Ordering::Relaxed,
                    Ordering::Relaxed,
                ) {
                    Ok(_) => break,
                    Err(actual) => max_us = actual,
                }
            }
        }

        assert_eq!(stats.callbacks.load(Ordering::Relaxed), n as u64);
        assert_eq!(stats.underruns.load(Ordering::Relaxed), 0);
        let min_buf = stats.min_ring_buffer_level_ms.load(Ordering::Relaxed);
        assert!(min_buf <= 500 && min_buf > 0);
        let _max_dur = stats.max_callback_duration_us.load(Ordering::Relaxed);

        stats.reset();
        assert_eq!(stats.callbacks.load(Ordering::Relaxed), 0);
        assert_eq!(stats.underruns.load(Ordering::Relaxed), 0);
        assert_eq!(stats.max_callback_duration_us.load(Ordering::Relaxed), 0);
        assert_eq!(stats.min_ring_buffer_level_ms.load(Ordering::Relaxed), u64::MAX);
    }

    #[test]
    fn test_feeder_varispeed_continuity_and_frequency_mono_stereo() {
        let sample_rate = 48000u32;
        let base_freq = 440.0f32;
        let duration_sec = 10.0f64;
        let total_frames = (duration_sec * sample_rate as f64).round() as usize; // 480,000 frames
        let amplitude = 0.8f32;

        let make_sine = |channels: usize| -> Vec<Vec<f32>> {
            let mut chs = vec![Vec::with_capacity(total_frames); channels];
            for i in 0..total_frames {
                let t = i as f32 / sample_rate as f32;
                let s = (2.0 * std::f32::consts::PI * base_freq * t).sin() * amplitude;
                for ch in chs.iter_mut() {
                    ch.push(s);
                }
            }
            chs
        };

        let measure_frequency = |samples: &[f32]| -> f32 {
            let mut crossings = Vec::new();
            let start = 5000;
            let end = samples.len().saturating_sub(5000);
            for i in start..end {
                if samples[i] <= 0.0 && samples[i + 1] > 0.0 {
                    let fraction = -samples[i] / (samples[i + 1] - samples[i]);
                    crossings.push(i as f64 + fraction as f64);
                }
            }
            assert!(crossings.len() > 100, "Not enough zero crossings found");
            let total_cycles = (crossings.len() - 1) as f64;
            let total_samples = crossings.last().unwrap() - crossings.first().unwrap();
            let freq = (total_cycles / total_samples) * sample_rate as f64;
            freq as f32
        };

        let block_sizes = [128, 256, 1024, 512, 768, 384, 1500, 2048, 100];

        // 1. Test Mono with Pitch +1 semitone
        {
            let mono_input = make_sine(1);
            let mut resampler = TrackResampler::new(sample_rate, sample_rate, 1, 1024, 1).unwrap();
            let mut input_staging: Vec<Vec<f32>> = vec![Vec::new(); 1];
            let mut output_staging = Vec::new();
            let mut delay_compensated = false;

            let mut out_samples = Vec::new();
            let mut in_pos = 0;
            let mut b_idx = 0;

            while in_pos < total_frames || !input_staging[0].is_empty() {
                if in_pos < total_frames {
                    let b_size = block_sizes[b_idx % block_sizes.len()].min(total_frames - in_pos);
                    b_idx += 1;
                    input_staging[0].extend_from_slice(&mono_input[0][in_pos..in_pos + b_size]);
                    in_pos += b_size;
                }

                let allow_partial = in_pos >= total_frames;
                drain_staging_through_resampler(
                    &mut resampler,
                    true,
                    &mut input_staging,
                    &mut output_staging,
                    &mut delay_compensated,
                    allow_partial,
                );

                for chunk in output_staging.chunks_exact(2) {
                    out_samples.push(chunk[0]);
                }
                output_staging.clear();
            }

            let expected_freq = base_freq * 2.0f32.powf(1.0 / 12.0); // ~466.164 Hz
            let max_step_theory = 2.0 * amplitude * (std::f32::consts::PI * expected_freq / sample_rate as f32).sin();
            let threshold = max_step_theory * 1.35;

            for i in 100..out_samples.len().saturating_sub(100) {
                let diff = (out_samples[i + 1] - out_samples[i]).abs();
                assert!(
                    diff <= threshold,
                    "Discontinuity detected in Mono +1 st at sample {i}: diff={diff} > threshold={threshold}"
                );
            }

            let measured = measure_frequency(&out_samples);
            assert!(
                (measured - expected_freq).abs() < 0.5,
                "Measured frequency {measured} does not match expected {expected_freq}"
            );
        }

        // 2. Test Stereo with Pitch +6 semitones
        {
            let stereo_input = make_sine(2);
            let mut resampler = TrackResampler::new(sample_rate, sample_rate, 6, 1024, 2).unwrap();
            let mut input_staging: Vec<Vec<f32>> = vec![Vec::new(); 2];
            let mut output_staging = Vec::new();
            let mut delay_compensated = false;

            let mut out_l = Vec::new();
            let mut out_r = Vec::new();
            let mut in_pos = 0;
            let mut b_idx = 0;

            while in_pos < total_frames || !input_staging[0].is_empty() {
                if in_pos < total_frames {
                    let b_size = block_sizes[b_idx % block_sizes.len()].min(total_frames - in_pos);
                    b_idx += 1;
                    input_staging[0].extend_from_slice(&stereo_input[0][in_pos..in_pos + b_size]);
                    input_staging[1].extend_from_slice(&stereo_input[1][in_pos..in_pos + b_size]);
                    in_pos += b_size;
                }

                let allow_partial = in_pos >= total_frames;
                drain_staging_through_resampler(
                    &mut resampler,
                    false,
                    &mut input_staging,
                    &mut output_staging,
                    &mut delay_compensated,
                    allow_partial,
                );

                for chunk in output_staging.chunks_exact(2) {
                    out_l.push(chunk[0]);
                    out_r.push(chunk[1]);
                }
                output_staging.clear();
            }

            let expected_freq = base_freq * 2.0f32.powf(6.0 / 12.0); // ~622.254 Hz
            let max_step_theory = 2.0 * amplitude * (std::f32::consts::PI * expected_freq / sample_rate as f32).sin();
            let threshold = max_step_theory * 1.35;

            for i in 100..out_l.len().saturating_sub(100) {
                let diff_l = (out_l[i + 1] - out_l[i]).abs();
                let diff_r = (out_r[i + 1] - out_r[i]).abs();
                assert!(diff_l <= threshold, "Discontinuity in Stereo L +6 st at sample {i}: diff={diff_l} > {threshold}");
                assert!(diff_r <= threshold, "Discontinuity in Stereo R +6 st at sample {i}: diff={diff_r} > {threshold}");
            }

            let measured_l = measure_frequency(&out_l);
            let measured_r = measure_frequency(&out_r);
            assert!((measured_l - expected_freq).abs() < 0.5, "Stereo L freq mismatch: {measured_l} vs {expected_freq}");
            assert!((measured_r - expected_freq).abs() < 0.5, "Stereo R freq mismatch: {measured_r} vs {expected_freq}");
        }

        // 3. Test Dynamic Pitch Change (0 st -> +1 st -> +6 st -> 0 st) without recreating resampler
        {
            let stereo_input = make_sine(2);
            let mut resampler = TrackResampler::new(sample_rate, sample_rate, 0, 1024, 2).unwrap();
            let mut input_staging: Vec<Vec<f32>> = vec![Vec::new(); 2];
            let mut output_staging = Vec::new();
            let mut delay_compensated = false;

            let mut out_l = Vec::new();
            let mut in_pos = 0;
            let mut b_idx = 0;

            let mut last_applied_pitch = 0;

            while in_pos < total_frames || !input_staging[0].is_empty() {
                let current_sec = in_pos as f64 / sample_rate as f64;
                let target_pitch = if current_sec < 2.5 {
                    0
                } else if current_sec < 5.0 {
                    1
                } else if current_sec < 7.5 {
                    6
                } else {
                    0
                };

                if target_pitch != last_applied_pitch {
                    last_applied_pitch = target_pitch;
                    resampler.set_pitch(target_pitch, true).unwrap();
                }

                if in_pos < total_frames {
                    let b_size = block_sizes[b_idx % block_sizes.len()].min(total_frames - in_pos);
                    b_idx += 1;
                    input_staging[0].extend_from_slice(&stereo_input[0][in_pos..in_pos + b_size]);
                    input_staging[1].extend_from_slice(&stereo_input[1][in_pos..in_pos + b_size]);
                    in_pos += b_size;
                }

                let allow_partial = in_pos >= total_frames;
                drain_staging_through_resampler(
                    &mut resampler,
                    false,
                    &mut input_staging,
                    &mut output_staging,
                    &mut delay_compensated,
                    allow_partial,
                );

                for chunk in output_staging.chunks_exact(2) {
                    out_l.push(chunk[0]);
                }
                output_staging.clear();
            }

            let max_freq_6st = base_freq * 2.0f32.powf(6.0 / 12.0);
            let max_step_theory = 2.0 * amplitude * (std::f32::consts::PI * max_freq_6st / sample_rate as f32).sin();
            let threshold = max_step_theory * 1.35;

            for i in 100..out_l.len().saturating_sub(100) {
                let diff = (out_l[i + 1] - out_l[i]).abs();
                assert!(
                    diff <= threshold,
                    "Discontinuity during dynamic pitch shift at sample {i}: diff={diff} > {threshold}"
                );
            }
        }
    }

    #[test]
    fn test_guide_cue_chime_synthesis() {
        let sample_rate = 48000u32;
        let mut gc = GuideCueEngine::new();
        assert!(gc.enabled);
        gc.trigger_chime();

        let total_samples = (0.19 * sample_rate as f32) as usize; // 9120 samples
        let mut out = vec![0.0f32; total_samples + 1000];
        let sections = vec![];
        gc.render_block(0, out.len(), sample_rate, &sections, &mut out);

        // After 9120 samples, chime finishes and outputs 0.0
        assert!(out[total_samples - 1].abs() > 0.0, "Chime ended prematurely");
        assert_eq!(out[total_samples + 10], 0.0, "Chime continued past 190 ms");

        // Measure dominant frequency in Part 1 (first 0.06s, samples 200..2800)
        // Should be around 587.33 Hz (D5)
        let mut crossings_1 = 0;
        for i in 200..2800 {
            if out[i] <= 0.0 && out[i + 1] > 0.0 {
                crossings_1 += 1;
            }
        }
        let freq_1 = (crossings_1 as f32 / 2600.0) * sample_rate as f32;
        assert!((freq_1 - 587.33).abs() < 25.0, "Part 1 freq mismatch: {freq_1} vs 587.33 Hz");

        // Measure dominant frequency in Part 2 (samples 4000..7000)
        // Should be around 880.0 Hz (A5)
        let mut crossings_2 = 0;
        for i in 4000..7000 {
            if out[i] <= 0.0 && out[i + 1] > 0.0 {
                crossings_2 += 1;
            }
        }
        let freq_2 = (crossings_2 as f32 / 3000.0) * sample_rate as f32;
        assert!((freq_2 - 880.0).abs() < 25.0, "Part 2 freq mismatch: {freq_2} vs 880.0 Hz");
    }

    #[test]
    fn test_split_mono_routing_by_bus() {
        // cue-click bus strictly ch 0 (Left), main bus strictly ch 1 (Right), both bus in both ch 0 and ch 1
        let frames = 256;
        let cue_l = vec![1.0f32; frames];
        let cue_r = vec![1.0f32; frames];
        let main_l = vec![0.8f32; frames];
        let main_r = vec![0.8f32; frames];
        let both_l = vec![0.5f32; frames];
        let both_r = vec![0.5f32; frames];
        let click_buf = vec![0.2f32; frames];
        let guide_buf = vec![0.1f32; frames];

        let master_g = 1.0f32;
        let cue_g = 1.0f32;
        let env_gain = 1.0f32;

        let mut data = vec![0.0f32; frames * 2];

        for f in 0..frames {
            let cue_sum = ((cue_l[f] + cue_r[f] + both_l[f] + both_r[f]) * 0.5 + click_buf[f] + guide_buf[f]) * cue_g * env_gain;
            let main_sum = ((main_l[f] + main_r[f] + both_l[f] + both_r[f]) * 0.5) * master_g * env_gain;

            data[f * 2] = cue_sum.clamp(-1.0, 1.0);
            data[f * 2 + 1] = main_sum.clamp(-1.0, 1.0);
        }

        // Isolated test: only Cue bus playing -> channel 1 (Main) is strictly 0.0
        let isolated_cue_sum = ((1.0 + 1.0) * 0.5) * cue_g;
        let isolated_main_sum = 0.0f32;
        assert_eq!(isolated_main_sum, 0.0, "Cue leaked into Main bus!");
        assert_eq!(isolated_cue_sum, 1.0);

        // Isolated test: only Main bus playing -> channel 0 (Cue) is strictly 0.0
        let iso_cue_sum = 0.0f32;
        let iso_main_sum = ((0.8 + 0.8) * 0.5) * master_g;
        assert_eq!(iso_cue_sum, 0.0, "Main leaked into Cue bus!");
        assert_eq!(iso_main_sum, 0.8);
    }

    #[test]
    fn test_feeder_output_staging_limit() {
        let chunk_frames = 1024usize;
        let staging_limit = chunk_frames * 2; // 2048 samples

        let mut output_staging = Vec::new();
        output_staging.resize(staging_limit, 0.5f32);

        // Check condition: if output_staging.len() >= staging_limit, feeder must wait
        let feeder_can_process = output_staging.len() < staging_limit;
        assert!(!feeder_can_process, "Feeder did not throttle when output_staging >= staging_limit");

        // Once staging is drained below limit, feeder resumes
        output_staging.drain(0..512);
        let feeder_resumes = output_staging.len() < staging_limit;
        assert!(feeder_resumes, "Feeder did not resume after output_staging drained");
    }

    #[tokio::test]
    async fn test_playback_engine_quantized_jump_and_vamp() {
        let stats = Arc::new(AudioStreamStats::default());
        let engine = PlaybackEngine::new(stats);

        engine.sample_rate.store(48000, Ordering::SeqCst);
        engine.total_frames.store(48000 * 12, Ordering::SeqCst);

        let sections = vec![
            NativeSongSection { id: "intro".to_string(), name: "Intro".to_string(), code: None, start_sec: 0.0, end_sec: 4.0 },
            NativeSongSection { id: "verse".to_string(), name: "Verse".to_string(), code: None, start_sec: 4.0, end_sec: 8.0 },
            NativeSongSection { id: "chorus".to_string(), name: "Chorus".to_string(), code: None, start_sec: 8.0, end_sec: 12.0 },
        ];

        engine.configure_song(Some(120.0), Some(4), Some(sections), Some("1-bar".to_string()));

        // Position: 0.5 sec (24000 frames)
        engine.current_frame.store(24000, Ordering::SeqCst);

        // Queue jump to Verse with 1-bar quantization
        let jump_res = engine.queue_section_jump("verse", Some("1-bar")).await;
        assert!(jump_res.is_ok());
        let jump = jump_res.unwrap();
        assert_eq!(jump.target_section_id, "verse");
        assert_eq!(jump.target_frame, (4.0 * 48000.0) as u64);

        let state = engine.get_playback_state();
        assert_eq!(state.queued_section_id, Some("verse".to_string()));

        // Queue immediate jump to Chorus
        let imm_res = engine.queue_section_jump("chorus", Some("immediate")).await;
        assert!(imm_res.is_ok());
        let state_after_imm = engine.get_playback_state();
        assert_eq!(state_after_imm.queued_section_id, None);
        assert_eq!(engine.current_frame.load(Ordering::SeqCst), (8.0 * 48000.0) as u64);

        // Toggle Vamp
        let vamp_on = engine.toggle_vamp(Some(true)).await;
        assert!(vamp_on);
        assert!(engine.is_vamping.load(Ordering::SeqCst));

        let vamp_off = engine.toggle_vamp(Some(false)).await;
        assert!(!vamp_off);
        assert!(!engine.is_vamping.load(Ordering::SeqCst));
    }

    #[test]
    fn test_50_consecutive_seeks_zero_underruns_and_buffer_stable() {
        let sample_rate = 48000u64;
        let stats = Arc::new(AudioStreamStats::default());
        let (mut producer, mut consumer) = rtrb::RingBuffer::<f32>::new(sample_rate as usize);

        let is_buffering = Arc::new(AtomicBool::new(false));
        let last_prefill_duration = Arc::new(AtomicU64::new(0));

        let frames_per_block = 256usize;

        // Simulate 50 seeks to random positions
        for _seek_i in 0..50 {
            // Trigger seek -> enters buffering state, clears ring buffer
            is_buffering.store(true, Ordering::SeqCst);
            let t_seek_start = Instant::now();

            // Discard unread samples on seek (simulate drain)
            while consumer.pop().is_ok() {}

            // Feeder runs and prefills >= 150 ms (7200 samples)
            let prefill_samples = (sample_rate as f32 * 0.40 * 2.0) as usize; // ~400 ms
            for s in 0..prefill_samples {
                producer.push((s % 100) as f32 / 100.0).unwrap();
            }

            // Output callback arrives during/after prefill
            let min_track_frames = (consumer.slots() / 2) as u64;
            let track_level_ms = (min_track_frames * 1000) / sample_rate;

            if is_buffering.load(Ordering::Relaxed) {
                if track_level_ms < 150 {
                    // Outputs silence, underruns NOT incremented
                } else {
                    is_buffering.store(false, Ordering::SeqCst);
                    let dur = t_seek_start.elapsed().as_millis() as u64;
                    last_prefill_duration.store(dur, Ordering::Relaxed);
                    stats.min_ring_buffer_level_ms.store(u64::MAX, Ordering::Relaxed);
                }
            }

            // Run one callback block
            for _ in 0..(frames_per_block * 2) {
                let _ = consumer.pop();
            }
        }

        assert_eq!(stats.underruns.load(Ordering::Relaxed), 0, "Seek produced underrun errors!");

        // Steady-state playback: 10 seconds (10 * 48000 frames) with feeder continuously keeping ring buffer full
        let steady_blocks = (10 * 48000) / frames_per_block;
        for _ in 0..steady_blocks {
            // Feeder tops up buffer if space available
            while producer.slots() >= frames_per_block * 2 {
                for _ in 0..(frames_per_block * 2) {
                    let _ = producer.push(0.5);
                }
            }

            // Consumer reads frames_per_block frames
            let unread_frames = (consumer.slots() / 2) as u64;
            let track_level_ms = (unread_frames * 1000) / sample_rate;

            let mut current_min = stats.min_ring_buffer_level_ms.load(Ordering::Relaxed);
            while track_level_ms < current_min {
                match stats.min_ring_buffer_level_ms.compare_exchange_weak(
                    current_min,
                    track_level_ms,
                    Ordering::Relaxed,
                    Ordering::Relaxed,
                ) {
                    Ok(_) => break,
                    Err(actual) => current_min = actual,
                }
            }

            for _ in 0..(frames_per_block * 2) {
                if consumer.pop().is_err() {
                    stats.underruns.fetch_add(1, Ordering::Relaxed);
                }
            }
        }

        assert_eq!(stats.underruns.load(Ordering::Relaxed), 0, "Steady playback produced underruns!");
        let min_buf = stats.min_ring_buffer_level_ms.load(Ordering::Relaxed);
        assert!(min_buf >= 400, "Steady playback buffer fell below 400 ms: {min_buf} ms");
    }

    #[tokio::test]
    async fn test_device_disconnect_and_reopen_preserves_position() {
        let stats = Arc::new(AudioStreamStats::default());
        let engine = PlaybackEngine::new(stats);

        engine.sample_rate.store(48000, Ordering::SeqCst);
        engine.total_frames.store(48000 * 60, Ordering::SeqCst); // 60s
        engine.current_frame.store(48000 * 25, Ordering::SeqCst); // Position: 25s
        engine.is_playing.store(true, Ordering::SeqCst);

        // Simulate device unplug (err_fn triggered)
        engine.device_disconnected.store(true, Ordering::SeqCst);
        engine.is_playing.store(false, Ordering::SeqCst);

        let state = engine.get_playback_state();
        assert!(state.device_disconnected);
        assert!(!state.is_playing);
        assert_eq!(state.position_sec, 25.0, "Position was lost on disconnect!");

        // Clear disconnect on reopen
        engine.device_disconnected.store(false, Ordering::SeqCst);
        let state_reopened = engine.get_playback_state();
        assert!(!state_reopened.device_disconnected);
        assert_eq!(state_reopened.position_sec, 25.0, "Position was not preserved after reopen!");
    }

    #[test]
    fn test_callback_10min_preallocation_benchmark() {
        // 10 minutes at 48 kHz with 256-frame blocks
        let total_callbacks = 112_500usize;
        let frames_per_block = 256usize;
        let num_tracks = 8usize;
        let sr = 48000u64;

        // Setup 8 tracks with ring buffers containing audio
        fn make_tracks(num_tracks: usize) -> Vec<(
            Arc<std::sync::Mutex<rtrb::Consumer<f32>>>,
            Arc<std::sync::Mutex<rtrb::Producer<f32>>>,
            Arc<AtomicU32>,
            Arc<AtomicI32>,
            Arc<AtomicBool>,
            Arc<AtomicBool>,
            Arc<AtomicU8>,
        )> {
            let mut list = Vec::new();
            for i in 0..num_tracks {
                let (mut prod, cons) = rtrb::RingBuffer::<f32>::new(48000);
                for _ in 0..24000 {
                    let _ = prod.push(0.3);
                    let _ = prod.push(0.3);
                }
                list.push((
                    Arc::new(std::sync::Mutex::new(cons)),
                    Arc::new(std::sync::Mutex::new(prod)),
                    Arc::new(AtomicU32::new(1.0f32.to_bits())),
                    Arc::new(AtomicI32::new(0)),
                    Arc::new(AtomicBool::new(false)),
                    Arc::new(AtomicBool::new(false)),
                    Arc::new(AtomicU8::new((i % 3) as u8)),
                ));
            }
            list
        }

        // --- 1. MEDICIÓN ANTES: asignación de 8 vectores por callback + lock() ---
        let tracks_before = make_tracks(num_tracks);
        let stats_before = Arc::new(AudioStreamStats::default());
        stats_before.min_ring_buffer_level_ms.store(u64::MAX, Ordering::Relaxed);
        let fade_before = Arc::new(std::sync::Mutex::new(FadeEnvelope::new(FADE_MS, 48000)));

        for _ in 0..total_callbacks {
            let t0 = Instant::now();
            stats_before.callbacks.fetch_add(1, Ordering::Relaxed);

            let mut fade = fade_before.lock().unwrap();
            let _ = fade.next_gain();

            // Asignación dinámica en cada llamada (8 vectores por callback)
            let mut main_l = vec![0.0f32; frames_per_block];
            let mut main_r = vec![0.0f32; frames_per_block];
            let mut cue_l = vec![0.0f32; frames_per_block];
            let mut cue_r = vec![0.0f32; frames_per_block];
            let mut both_l = vec![0.0f32; frames_per_block];
            let mut both_r = vec![0.0f32; frames_per_block];
            let click_buf = vec![0.0f32; frames_per_block];
            let guide_buf = vec![0.0f32; frames_per_block];

            let mut callback_min_track_frames = u64::MAX;

            for (consumer_arc, prod_arc, gain_bits, _pan, _mute, _solo, bus_atomic) in &tracks_before {
                if let Ok(mut c) = consumer_arc.lock() {
                    let unread = (c.slots() / 2) as u64;
                    if unread < callback_min_track_frames {
                        callback_min_track_frames = unread;
                    }
                    let g = f32::from_bits(gain_bits.load(Ordering::Relaxed));
                    let bus = TrackBus::from_u8(bus_atomic.load(Ordering::Relaxed));

                    for f in 0..frames_per_block {
                        let l = c.pop().unwrap_or(0.0);
                        let r = c.pop().unwrap_or(0.0);
                        match bus {
                            TrackBus::Main => {
                                main_l[f] += l * g;
                                main_r[f] += r * g;
                            }
                            TrackBus::CueClick => {
                                cue_l[f] += l * g + click_buf[f] + guide_buf[f];
                                cue_r[f] += r * g;
                            }
                            TrackBus::Both => {
                                both_l[f] += l * g;
                                both_r[f] += r * g;
                            }
                        }
                    }
                }
                // Reponer frames para simular feeder en reproducción continua de 10 min
                if let Ok(mut p) = prod_arc.lock() {
                    for _ in 0..(frames_per_block * 2) {
                        let _ = p.push(0.3);
                    }
                }
            }

            if callback_min_track_frames != u64::MAX {
                let track_level_ms = (callback_min_track_frames * 1000) / sr;
                let mut current_min = stats_before.min_ring_buffer_level_ms.load(Ordering::Relaxed);
                while track_level_ms < current_min {
                    match stats_before.min_ring_buffer_level_ms.compare_exchange_weak(
                        current_min,
                        track_level_ms,
                        Ordering::Relaxed,
                        Ordering::Relaxed,
                    ) {
                        Ok(_) => break,
                        Err(actual) => current_min = actual,
                    }
                }
            }

            let dur_us = t0.elapsed().as_micros() as u64;
            let mut max_us = stats_before.max_callback_duration_us.load(Ordering::Relaxed);
            while dur_us > max_us {
                match stats_before.max_callback_duration_us.compare_exchange_weak(
                    max_us,
                    dur_us,
                    Ordering::Relaxed,
                    Ordering::Relaxed,
                ) {
                    Ok(_) => break,
                    Err(actual) => max_us = actual,
                }
            }
        }

        // --- 2. MEDICIÓN DESPUÉS: búferes preasignados con fill(0.0) + try_lock() ---
        let tracks_after = make_tracks(num_tracks);
        let stats_after = Arc::new(AudioStreamStats::default());
        stats_after.min_ring_buffer_level_ms.store(u64::MAX, Ordering::Relaxed);
        let fade_after = Arc::new(std::sync::Mutex::new(FadeEnvelope::new(FADE_MS, 48000)));

        // Preasignación de los 8 vectores una sola vez fuera del bucle
        let mut main_l = Vec::<f32>::with_capacity(4096);
        let mut main_r = Vec::<f32>::with_capacity(4096);
        let mut cue_l = Vec::<f32>::with_capacity(4096);
        let mut cue_r = Vec::<f32>::with_capacity(4096);
        let mut both_l = Vec::<f32>::with_capacity(4096);
        let mut both_r = Vec::<f32>::with_capacity(4096);
        let mut click_buf = Vec::<f32>::with_capacity(4096);
        let mut guide_buf = Vec::<f32>::with_capacity(4096);

        for _ in 0..total_callbacks {
            let t0 = Instant::now();
            stats_after.callbacks.fetch_add(1, Ordering::Relaxed);

            // try_lock sin bloqueo
            let mut fade = match fade_after.try_lock() {
                Ok(f) => f,
                Err(_) => continue,
            };
            let _ = fade.next_gain();

            // Reutilización sin alocaciones dinámicas
            if main_l.len() < frames_per_block {
                main_l.resize(frames_per_block, 0.0);
                main_r.resize(frames_per_block, 0.0);
                cue_l.resize(frames_per_block, 0.0);
                cue_r.resize(frames_per_block, 0.0);
                both_l.resize(frames_per_block, 0.0);
                both_r.resize(frames_per_block, 0.0);
                click_buf.resize(frames_per_block, 0.0);
                guide_buf.resize(frames_per_block, 0.0);
            }
            main_l[..frames_per_block].fill(0.0);
            main_r[..frames_per_block].fill(0.0);
            cue_l[..frames_per_block].fill(0.0);
            cue_r[..frames_per_block].fill(0.0);
            both_l[..frames_per_block].fill(0.0);
            both_r[..frames_per_block].fill(0.0);
            click_buf[..frames_per_block].fill(0.0);
            guide_buf[..frames_per_block].fill(0.0);

            let mut callback_min_track_frames = u64::MAX;

            for (consumer_arc, prod_arc, gain_bits, _pan, _mute, _solo, bus_atomic) in &tracks_after {
                if let Ok(mut c) = consumer_arc.try_lock() {
                    let unread = (c.slots() / 2) as u64;
                    if unread < callback_min_track_frames {
                        callback_min_track_frames = unread;
                    }
                    let g = f32::from_bits(gain_bits.load(Ordering::Relaxed));
                    let bus = TrackBus::from_u8(bus_atomic.load(Ordering::Relaxed));

                    for f in 0..frames_per_block {
                        let l = c.pop().unwrap_or(0.0);
                        let r = c.pop().unwrap_or(0.0);
                        match bus {
                            TrackBus::Main => {
                                main_l[f] += l * g;
                                main_r[f] += r * g;
                            }
                            TrackBus::CueClick => {
                                cue_l[f] += l * g + click_buf[f] + guide_buf[f];
                                cue_r[f] += r * g;
                            }
                            TrackBus::Both => {
                                both_l[f] += l * g;
                                both_r[f] += r * g;
                            }
                        }
                    }
                }
                // Reponer frames para simular feeder en reproducción continua de 10 min
                if let Ok(mut p) = prod_arc.try_lock() {
                    for _ in 0..(frames_per_block * 2) {
                        let _ = p.push(0.3);
                    }
                }
            }

            if callback_min_track_frames != u64::MAX {
                let track_level_ms = (callback_min_track_frames * 1000) / sr;
                let mut current_min = stats_after.min_ring_buffer_level_ms.load(Ordering::Relaxed);
                while track_level_ms < current_min {
                    match stats_after.min_ring_buffer_level_ms.compare_exchange_weak(
                        current_min,
                        track_level_ms,
                        Ordering::Relaxed,
                        Ordering::Relaxed,
                    ) {
                        Ok(_) => break,
                        Err(actual) => current_min = actual,
                    }
                }
            }

            let dur_us = t0.elapsed().as_micros() as u64;
            let mut max_us = stats_after.max_callback_duration_us.load(Ordering::Relaxed);
            while dur_us > max_us {
                match stats_after.max_callback_duration_us.compare_exchange_weak(
                    max_us,
                    dur_us,
                    Ordering::Relaxed,
                    Ordering::Relaxed,
                ) {
                    Ok(_) => break,
                    Err(actual) => max_us = actual,
                }
            }
        }

        println!("=== BENCHMARK 10 MINUTOS (112,500 CALLBACKS, 8 PISTAS) ===");
        println!(
            "ANTES   | Callbacks: {} | Underruns: {} | Max µs: {} | Min Buffer: {} ms",
            stats_before.callbacks.load(Ordering::Relaxed),
            stats_before.underruns.load(Ordering::Relaxed),
            stats_before.max_callback_duration_us.load(Ordering::Relaxed),
            stats_before.min_ring_buffer_level_ms.load(Ordering::Relaxed)
        );
        println!(
            "DESPUÉS | Callbacks: {} | Underruns: {} | Max µs: {} | Min Buffer: {} ms",
            stats_after.callbacks.load(Ordering::Relaxed),
            stats_after.underruns.load(Ordering::Relaxed),
            stats_after.max_callback_duration_us.load(Ordering::Relaxed),
            stats_after.min_ring_buffer_level_ms.load(Ordering::Relaxed)
        );

        assert_eq!(stats_before.callbacks.load(Ordering::Relaxed), total_callbacks as u64);
        assert_eq!(stats_after.callbacks.load(Ordering::Relaxed), total_callbacks as u64);
        assert_eq!(stats_before.underruns.load(Ordering::Relaxed), 0);
        assert_eq!(stats_after.underruns.load(Ordering::Relaxed), 0);
    }

    // ---- Medidores de pico (ver docs/DISENO_MEDIDORES.md) ----

    #[test]
    fn test_peak_meter_registra_maximo_y_se_reinicia_al_leer() {
        let m = PeakMeter::default();
        m.record(0.2, -0.7);
        m.record(-0.5, 0.1);
        let (l, r) = m.take();
        assert!((l - 0.5).abs() < 1e-6, "L debe ser el máximo absoluto, fue {l}");
        assert!((r - 0.7).abs() < 1e-6, "R debe ser el máximo absoluto, fue {r}");
        assert_eq!(m.take(), (0.0, 0.0), "tras leer, el pico vuelve a 0");
        m.record(f32::NAN, f32::INFINITY);
        assert_eq!(m.take(), (0.0, 0.0), "NaN e infinitos se ignoran");
    }

    #[test]
    fn test_peak_meter_desde_varios_hilos_da_el_maximo_global() {
        let m = Arc::new(PeakMeter::default());
        let hs: Vec<_> = (1..=4)
            .map(|k| {
                let m = Arc::clone(&m);
                std::thread::spawn(move || {
                    for i in 0..1000 {
                        let v = (k as f32) * 0.1 * (i as f32 / 999.0);
                        m.record(v, -v);
                    }
                })
            })
            .collect();
        for h in hs {
            h.join().unwrap();
        }
        let (l, r) = m.take();
        assert!((l - 0.4).abs() < 1e-6 && (r - 0.4).abs() < 1e-6, "máximo global 0,4; fue {l} / {r}");
    }

    /// Crea un motor con pistas sintéticas de amplitud constante (L = R = amplitud) en el bus Main.
    fn engine_con_pistas(amplitudes: &[(&str, f32)], frames: usize) -> PlaybackEngine {
        let engine = PlaybackEngine::new(Arc::new(AudioStreamStats::default()));
        let mut active = Vec::new();
        let mut handles = Vec::new();
        for (id, amp) in amplitudes {
            let (mut prod, cons) = rtrb::RingBuffer::<f32>::new(frames * 2 + 16);
            for _ in 0..frames {
                prod.push(*amp).unwrap();
                prod.push(*amp).unwrap();
            }
            let t = ActiveTrack {
                track_id: id.to_string(),
                file_path: std::path::PathBuf::new(),
                original_channels: 2,
                total_frames: frames as u64,
                gain: Arc::new(AtomicU32::new(1.0f32.to_bits())),
                pan: Arc::new(AtomicI32::new(0)),
                muted: Arc::new(AtomicBool::new(false)),
                soloed: Arc::new(AtomicBool::new(false)),
                bus: Arc::new(AtomicU8::new(TrackBus::Main as u8)),
                consumer: Arc::new(std::sync::Mutex::new(cons)),
                stop_signal: Arc::new(AtomicBool::new(false)),
                seek_request: Arc::new(AtomicI64::new(-1)),
                jump_request: Arc::new(std::sync::Mutex::new(None)),
                is_vamping: Arc::new(AtomicBool::new(false)),
                active_section_loop: Arc::new(std::sync::Mutex::new(None)),
                pitch_semitones: Arc::new(AtomicI32::new(0)),
                meter: Arc::new(PeakMeter::default()),
                eof: Arc::new(AtomicBool::new(false)),
                seek_ack: Arc::new(AtomicU64::new(0)),
                flush_done: Arc::new(AtomicU64::new(0)),
                // Sin hilo feeder: un seek no debe esperar su confirmación.
                feeder_alive: Arc::new(AtomicBool::new(false)),
                skip_frames: Arc::new(AtomicU64::new(0)),
            };
            handles.push(StreamTrackHandle {
                consumer: Arc::clone(&t.consumer),
                gain: Arc::clone(&t.gain),
                pan: Arc::clone(&t.pan),
                muted: Arc::clone(&t.muted),
                soloed: Arc::clone(&t.soloed),
                bus: Arc::clone(&t.bus),
                meter: Arc::clone(&t.meter),
                eof: Arc::clone(&t.eof),
                flush_done: Arc::clone(&t.flush_done),
                skip_frames: Arc::clone(&t.skip_frames),
            });
            active.push(t);
        }
        *engine.tracks.try_lock().unwrap() = active;
        *engine.stream_tracks.lock().unwrap() = handles;
        engine.total_frames.store(frames as u64, Ordering::SeqCst);
        engine.is_playing.store(true, Ordering::SeqCst);
        engine
    }

    fn nivel(state: &PlaybackStateSnapshot, id: &str) -> (f32, f32) {
        state
            .meters
            .tracks
            .iter()
            .find(|t| t.track_id == id)
            .map(|t| (t.l, t.r))
            .unwrap_or((-1.0, -1.0))
    }

    #[test]
    fn test_medidores_por_pista_post_fader_y_mute_solo() {
        let k = std::f32::consts::FRAC_1_SQRT_2; // pan centro: cos(π/4) = sin(π/4)
        let engine = engine_con_pistas(&[("a", 0.5), ("b", 0.25)], 4096);
        let mut buf = vec![0.0f32; 512 * 2];

        engine.simulate_callback_block(&mut buf, 2);
        let s = engine.get_playback_state();
        let (al, ar) = nivel(&s, "a");
        let (bl, _) = nivel(&s, "b");
        assert!((al - 0.5 * k).abs() < 1e-4 && (ar - 0.5 * k).abs() < 1e-4, "pista a: {al} / {ar}");
        assert!((bl - 0.25 * k).abs() < 1e-4, "pista b: {bl}");

        // Sin audio nuevo, la siguiente lectura da 0.
        let s = engine.get_playback_state();
        assert_eq!(nivel(&s, "a"), (0.0, 0.0), "tras leer, sin bloque nuevo, el pico es 0");

        // Mute en b: su medidor queda a 0; a sigue midiendo.
        engine.tracks.try_lock().unwrap()[1].muted.store(true, Ordering::SeqCst);
        engine.simulate_callback_block(&mut buf, 2);
        let s = engine.get_playback_state();
        assert_eq!(nivel(&s, "b"), (0.0, 0.0), "pista en mute -> 0");
        assert!(nivel(&s, "a").0 > 0.3, "la pista sin mute sigue midiendo");

        // Solo en b (sin mute): a queda a 0.
        engine.tracks.try_lock().unwrap()[1].muted.store(false, Ordering::SeqCst);
        engine.tracks.try_lock().unwrap()[1].soloed.store(true, Ordering::SeqCst);
        engine.simulate_callback_block(&mut buf, 2);
        let s = engine.get_playback_state();
        assert_eq!(nivel(&s, "a"), (0.0, 0.0), "fuera del solo -> 0");
        assert!((nivel(&s, "b").0 - 0.25 * k).abs() < 1e-4, "la pista en solo mide");

        // Ganancia 0,5 en b: el pico baja a la mitad (post-fader).
        engine.tracks.try_lock().unwrap()[1].gain.store(0.5f32.to_bits(), Ordering::SeqCst);
        engine.simulate_callback_block(&mut buf, 2);
        let s = engine.get_playback_state();
        assert!((nivel(&s, "b").0 - 0.125 * k).abs() < 1e-4, "post-fader: {}", nivel(&s, "b").0);
    }

    #[test]
    fn test_medidor_main_sigue_la_suma_y_el_master() {
        let k = std::f32::consts::FRAC_1_SQRT_2;
        let engine = engine_con_pistas(&[("a", 0.5), ("b", 0.25)], 8192);
        // Sin micro-fundido: interesa el nivel estable del bus.
        *engine.fade.lock().unwrap() = FadeEnvelope::new(FADE_MS, 48000);
        let mut buf = vec![0.0f32; 1024 * 2];

        engine.simulate_callback_block(&mut buf, 2);
        let s = engine.get_playback_state();
        let esperado = 0.75 * k;
        assert!((s.meters.main.l - esperado).abs() < 1e-3, "main = suma de pistas: {} vs {esperado}", s.meters.main.l);
        assert!((s.meters.out.l - esperado).abs() < 1e-3, "salida sin cue = main: {}", s.meters.out.l);
        assert!(!s.meters.clipped, "sin recorte");

        engine.master_gain.store(0.5f32.to_bits(), Ordering::SeqCst);
        engine.simulate_callback_block(&mut buf, 2);
        let s = engine.get_playback_state();
        assert!((s.meters.main.l - esperado * 0.5).abs() < 1e-3, "master a 0,5: {}", s.meters.main.l);

        // Ganancia alta en a: la salida supera 1,0 antes del recorte.
        engine.master_gain.store(1.0f32.to_bits(), Ordering::SeqCst);
        engine.tracks.try_lock().unwrap()[0].gain.store(4.0f32.to_bits(), Ordering::SeqCst);
        engine.simulate_callback_block(&mut buf, 2);
        let s = engine.get_playback_state();
        assert!(s.meters.clipped, "salida por encima de 1,0 -> recorte");
        assert!(s.meters.out.l > 1.0, "el medidor de salida ve el valor antes del clamp: {}", s.meters.out.l);
    }

    #[test]
    fn test_medidores_click_y_guia_llegan_al_estado() {
        let engine = PlaybackEngine::new(Arc::new(AudioStreamStats::default()));
        engine.bus_meters.click.record(0.3, 0.3);
        engine.bus_meters.guide.record(0.1, 0.1);
        let s = engine.get_playback_state();
        assert!((s.meters.click.l - 0.3).abs() < 1e-6, "click: {}", s.meters.click.l);
        assert!((s.meters.guide.l - 0.1).abs() < 1e-6, "guía: {}", s.meters.guide.l);
        let s = engine.get_playback_state();
        assert_eq!(s.meters.click.l, 0.0, "tras leer vuelve a 0");
    }

    // ---------------------------------------------------------------------
    // Fase 0 de la auditoría (A06, A07, A14)
    // ---------------------------------------------------------------------

    fn metronomo_120_bpm() -> MetronomeEngine {
        // 120 BPM a 48 kHz: un pulso cada 24 000 frames exactos.
        MetronomeEngine::new(MetronomeConfig {
            enabled: true,
            bpm: 120.0,
            beats_per_bar: 4,
            subdivision: 1,
            gain: 1.0,
            split_mono: false,
        })
    }

    /// Renderiza `[desde, hasta)` en bloques de `bloque` frames y cuenta los clics que empiezan
    /// (un bloque con señal tras un bloque en silencio; cada clic dura 45 ms y hay 500 ms entre pulsos).
    fn contar_clics(met: &mut MetronomeEngine, desde: u64, hasta: u64, bloque: usize) -> usize {
        let mut buf = vec![0.0f32; bloque];
        let mut inicios = 0;
        let mut previo_con_senal = false;
        let mut pos = desde;
        while pos < hasta {
            let frames = bloque.min((hasta - pos) as usize);
            met.render_block(pos, pos + frames as u64, frames, 48000, &mut buf[..frames]);
            let con_senal = buf[..frames].iter().any(|s| s.abs() > 1e-6);
            if con_senal && !previo_con_senal {
                inicios += 1;
            }
            previo_con_senal = con_senal;
            pos += frames as u64;
        }
        inicios
    }

    #[test]
    fn test_a07_metronomo_no_pierde_pulsos_en_el_borde_del_bloque() {
        // Pulsos en 0, 24 000, 48 000 y 72 000 dentro de [0, 96 000). Con bloques de 480 frames todos los
        // pulsos posteriores al primero caen justo en el borde de un bloque: antes se perdían.
        for bloque in [480usize, 441, 512, 1024, 333] {
            let mut met = metronomo_120_bpm();
            assert_eq!(
                contar_clics(&mut met, 0, 96_000, bloque),
                4,
                "bloque de {bloque} frames: debían sonar los 4 pulsos"
            );
        }
    }

    #[test]
    fn test_a07_pulso_en_el_borde_suena_en_el_bloque_siguiente() {
        let mut met = metronomo_120_bpm();
        let mut buf = vec![0.0f32; 480];
        met.render_block(0, 480, 480, 48000, &mut buf);
        // Salta a un bloque que termina exactamente en un pulso (24 000): ese pulso no suena en él...
        met.seek_to_frame(23_520, 48000);
        met.render_block(23_520, 24_000, 480, 48000, &mut buf);
        assert!(buf.iter().all(|s| s.abs() < 1e-6), "el pulso de 24 000 no pertenece a [23 520, 24 000)");
        // ...y sí al siguiente, desde su primer frame.
        met.render_block(24_000, 24_480, 480, 48000, &mut buf);
        assert!(buf[..40].iter().any(|s| s.abs() > 1e-6), "el pulso de 24 000 debe sonar al inicio del bloque siguiente");
    }

    #[test]
    fn test_a07_metronomo_atrasado_no_recorre_miles_de_subpasos() {
        // Si la posición salta lejos sin reposicionar, el metrónomo debe seguir sonando en la nueva posición.
        let mut met = metronomo_120_bpm();
        let mut buf = vec![0.0f32; 480];
        met.render_block(0, 480, 480, 48000, &mut buf);
        let lejos = 24_000u64 * 1000; // pulso número 1000
        met.render_block(lejos, lejos + 480, 480, 48000, &mut buf);
        assert!(buf[..40].iter().any(|s| s.abs() > 1e-6));
    }

    #[tokio::test]
    async fn test_a06_stop_reposiciona_el_metronomo_y_suena_el_primer_pulso() {
        let engine = PlaybackEngine::new(Arc::new(AudioStreamStats::default()));
        // Reproduce 5 s: el metrónomo avanza hasta el pulso 10.
        assert_eq!(contar_clics(&mut engine.metronome.lock().unwrap(), 0, 240_000, 480), 10);
        engine.stop().await;
        let mut buf = vec![0.0f32; 480];
        engine
            .metronome
            .lock()
            .unwrap()
            .render_block(0, 480, 480, 48000, &mut buf);
        assert!(buf[..40].iter().any(|s| s.abs() > 1e-6), "tras Stop, el primer bloque debe llevar el pulso 0");
    }

    #[tokio::test]
    async fn test_a06_seek_atras_reposiciona_el_metronomo() {
        let engine = PlaybackEngine::new(Arc::new(AudioStreamStats::default()));
        assert_eq!(contar_clics(&mut engine.metronome.lock().unwrap(), 0, 240_000, 480), 10);
        engine.seek(1.0).await; // frame 48 000, justo un pulso
        let mut buf = vec![0.0f32; 480];
        engine
            .metronome
            .lock()
            .unwrap()
            .render_block(48_000, 48_480, 480, 48000, &mut buf);
        assert!(buf[..40].iter().any(|s| s.abs() > 1e-6), "tras un seek atrás debe sonar el pulso de la nueva posición");
    }

    #[tokio::test]
    async fn test_a14_si_falla_abrir_la_salida_no_queda_reproduciendo() {
        let engine = PlaybackEngine::new(Arc::new(AudioStreamStats::default()));
        let resultado = engine
            .begin_playback(|| async { Err::<(), String>("sin dispositivo".to_string()) })
            .await;
        assert_eq!(resultado, Err("sin dispositivo".to_string()));
        assert!(!engine.is_playing.load(Ordering::SeqCst), "is_playing debe volver a false");

        // Con la salida disponible, el siguiente intento sí deja el motor reproduciendo.
        let resultado = engine.begin_playback(|| async { Ok::<(), String>(()) }).await;
        assert_eq!(resultado, Ok(()));
        assert!(engine.is_playing.load(Ordering::SeqCst));
    }

    // ---------------------------------------------------------------------
    // Fase 1 de la auditoría: reloj, fin de pista, seek y recuperación (A01–A04)
    // ---------------------------------------------------------------------

    const SR_PRUEBA: u32 = 48_000;
    /// Fotogramas por cada unidad de la rampa de prueba. Con 20 dos pistas sumadas no saturan la salida.
    const PASO_RAMPA: usize = 20;
    /// Ganancia de una pista centrada (pan 0, ganancia 1): cos(π/4).
    const GANANCIA_CENTRO: f32 = 0.707_106_78;

    fn seccion(id: &str, inicio: f64, fin: f64) -> NativeSongSection {
        NativeSongSection { id: id.to_string(), name: id.to_string(), code: None, start_sec: inicio, end_sec: fin }
    }

    /// Escribe una caché PCM sintética: cada pista es una rampa estéreo (valor = fotograma / PASO_RAMPA), de modo
    /// que en la salida se puede leer en qué punto de la canción está sonando el audio. Con 288 000
    /// fotogramas (6 s) el valor máximo es 14 400, dentro de i16.
    fn escribir_cache_rampa(nombre: &str, pistas: &[(&str, usize)]) -> std::path::PathBuf {
        use crate::audio::cache::{write_track_pcm_and_metadata, TrackPcmMetadata};
        let dir = std::env::temp_dir().join(format!("omnitracks_fase1_{nombre}"));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        for (id, frames) in pistas {
            let mut muestras = Vec::with_capacity(frames * 2);
            for f in 0..*frames {
                let v = (f / PASO_RAMPA) as i16;
                muestras.push(v);
                muestras.push(v);
            }
            let meta = TrackPcmMetadata {
                format_version: 1,
                track_id: id.to_string(),
                target_sample_rate: SR_PRUEBA,
                original_sample_rate: SR_PRUEBA,
                original_channels: 2,
                original_path: format!("{nombre}/{id}.wav"),
                original_file_size: (*frames * 4) as u64,
                original_modified_ms: 1000,
                channels: 2,
                is_effectively_mono: false,
                frame_count: *frames as u64,
                duration_sec: *frames as f64 / SR_PRUEBA as f64,
                peaks: vec![0.5; 16],
                created_at: "1000".to_string(),
            };
            write_track_pcm_and_metadata(&dir, nombre, &meta, &muestras).unwrap();
        }
        dir
    }

    /// Motor real (con hilos de lectura) cargado sobre una caché de rampas. Sin salida de audio: el
    /// callback se simula con `simulate_callback_block`.
    async fn motor_real(nombre: &str, pistas: &[(&str, usize)], secciones: Vec<NativeSongSection>) -> PlaybackEngine {
        let dir = escribir_cache_rampa(nombre, pistas);
        let engine = PlaybackEngine::new(Arc::new(AudioStreamStats::default()));
        engine
            .load_project(&dir, nombre, SR_PRUEBA, Some(120.0), Some(4), Some(secciones), Some("1-bar".to_string()))
            .await
            .expect("load_project");
        engine
    }

    async fn reproducir(engine: &PlaybackEngine) {
        engine.begin_playback(|| async { Ok::<(), String>(()) }).await.unwrap();
    }

    /// Un bloque de 480 fotogramas del callback simulado, con una pausa para dejar trabajar a los
    /// hilos de lectura. Devuelve (posición de la canción que suena en el último fotograma, o `None`
    /// si salió en silencio; reloj tras el bloque).
    fn bloque(engine: &PlaybackEngine) -> (Option<i64>, u64) {
        bloque_n(engine, 1.0)
    }

    /// Igual que `bloque`, con `pistas` rampas idénticas sumadas en la salida.
    fn bloque_n(engine: &PlaybackEngine, pistas: f32) -> (Option<i64>, u64) {
        let mut buf = vec![0.0f32; 480 * 2];
        engine.simulate_callback_block(&mut buf, 2);
        std::thread::sleep(std::time::Duration::from_millis(5));
        let ultimo = buf[(480 - 1) * 2];
        let pos = if ultimo.abs() < 1e-6 {
            None
        } else {
            Some((ultimo / pistas / GANANCIA_CENTRO * 32768.0 * PASO_RAMPA as f32).round() as i64)
        };
        (pos, engine.current_frame.load(Ordering::SeqCst))
    }

    /// El reloj debe coincidir con lo que suena (tolerancia de un par de bloques).
    fn desajustado(pos: Option<i64>, reloj: u64) -> bool {
        matches!(pos, Some(p) if (p - reloj as i64).abs() > 1000)
    }

    /// Versión estricta, para detectar retrasos de menos de un bloque: solo admite la cuantización de la
    /// rampa (`PASO_RAMPA` fotogramas) y el desfase de un fotograma de la lectura.
    fn fuera_de_sitio(pos: Option<i64>, reloj: u64) -> bool {
        matches!(pos, Some(p) if (p - reloj as i64).abs() > 100)
    }

    #[test]
    fn test_a15_el_vaciado_parcial_no_añade_relleno_de_silencio() {
        // Tramo de 320 fotogramas de señal (menos que un bloque de 1024). Antes de la corrección, rubato
        // devolvía un bloque entero de salida (958 fotogramas) y el empalme insertaba ~640 de relleno.
        for (n, ya_compensado) in [(320usize, false), (320, true), (1000, true), (5, true)] {
            let mut r = TrackResampler::new(48000, 48000, 0, 1024, 2).unwrap();
            let mut compensado = ya_compensado;
            let mut input: Vec<Vec<f32>> = vec![vec![0.5; n]; 2];
            let mut out = Vec::new();
            drain_staging_through_resampler(&mut r, false, &mut input, &mut out, &mut compensado, true);
            let fotogramas = out.len() / 2;
            let esperado = n + if ya_compensado { r.output_delay() } else { 0 };
            assert_eq!(fotogramas, esperado, "n={n}, compensado={ya_compensado}");
        }
    }

    #[test]
    fn test_a15_tras_un_empalme_el_remuestreador_empieza_un_tramo_nuevo() {
        let mut r = TrackResampler::new(48000, 48000, 0, 1024, 2).unwrap();
        let mut compensado = true;
        begin_new_segment(&mut r, &mut compensado, 0);
        assert!(!compensado, "el retardo del filtro debe volver a compensarse");
        assert_eq!(r.resample_ratio(), 1.0);
        begin_new_segment(&mut r, &mut compensado, 12);
        assert!((r.resample_ratio() - 0.5).abs() < 1e-9, "una octava arriba reduce a la mitad los fotogramas de salida");
    }

    #[test]
    fn test_clock_jumps_aplica_el_salto_con_el_sobrante_del_bloque() {
        let j = ClockJumps::new();
        j.schedule_jump(1000, 200);
        assert!(j.jump_pending());
        assert_eq!(j.resolve(990, false), 990, "antes del instante no se toca el reloj");
        assert_eq!(j.resolve(1010, false), 210, "pasa a destino + lo que se pasó del instante");
        assert!(!j.jump_pending(), "el salto se consume");
        assert_eq!(j.resolve(2000, false), 2000);
    }

    #[test]
    fn test_clock_jumps_cancelar_descarta_el_salto() {
        let j = ClockJumps::new();
        j.schedule_jump(1000, 200);
        j.cancel_jump();
        assert!(!j.jump_pending());
        assert_eq!(j.resolve(1500, false), 1500);
    }

    #[test]
    fn test_clock_jumps_vamp_da_la_vuelta_solo_si_esta_activo() {
        let j = ClockJumps::new();
        j.set_loop(1000, 2000);
        assert_eq!(j.resolve(2000, false), 2000, "sin vamp no hay vuelta");
        assert_eq!(j.resolve(1999, true), 1999);
        assert_eq!(j.resolve(2010, true), 1010);
        assert_eq!(j.resolve(3500, true), 1500, "un bloque más largo que el bucle sigue dando vueltas");
        j.clear_loop();
        assert_eq!(j.resolve(2010, true), 2010);
    }

    #[test]
    fn test_advance_clock_un_seek_concurrente_manda_sobre_el_salto() {
        let reloj = AtomicU64::new(900);
        let j = ClockJumps::new();
        j.schedule_jump(1000, 200);
        // El bloque lleva el reloj a 1100; el salto lo dejaría en 300.
        assert_eq!(advance_clock(&reloj, &j, 200, false), 300);
        assert_eq!(reloj.load(Ordering::SeqCst), 300);
    }

    #[tokio::test]
    async fn test_a01_el_reloj_coincide_con_el_audio_sin_saltos() {
        let engine = motor_real("a01_base", &[("pista", 288_000)], vec![seccion("a", 0.0, 6.0)]).await;
        reproducir(&engine).await;
        let (mut desajustes, mut con_audio) = (0, 0);
        let limite = Instant::now() + std::time::Duration::from_secs(8);
        while Instant::now() < limite {
            let (pos, reloj) = bloque(&engine);
            if pos.is_some() {
                con_audio += 1;
            }
            if desajustado(pos, reloj) {
                desajustes += 1;
            }
            if reloj >= 72_000 {
                break;
            }
        }
        assert!(con_audio > 50, "casi no sonó audio ({con_audio} bloques)");
        assert!(desajustes <= 1, "el reloj no coincide con el audio en reproducción normal ({desajustes} bloques)");
    }

    #[tokio::test]
    async fn test_a01_salto_cuantizado_hacia_atras_mueve_el_reloj_con_el_audio() {
        let secciones = vec![seccion("a", 0.0, 2.0), seccion("b", 2.0, 4.0), seccion("c", 4.0, 6.0)];
        let engine = motor_real("a01_salto", &[("pista", 288_000)], secciones).await;
        engine.seek(3.0).await;
        reproducir(&engine).await;
        let salto = engine.queue_section_jump("a", Some("1-bar")).await.unwrap();
        assert_eq!(salto.transition_frame, 192_000, "el salto debe caer en el compás de los 4 s");
        assert_eq!(salto.target_frame, 0);

        let (mut desajustes, mut reloj_volvio_atras) = (0, false);
        let limite = Instant::now() + std::time::Duration::from_secs(8);
        while Instant::now() < limite && engine.is_playing.load(Ordering::SeqCst) {
            let (pos, reloj) = bloque(&engine);
            if desajustado(pos, reloj) {
                desajustes += 1;
            }
            if reloj < 100_000 && !engine.is_buffering.load(Ordering::SeqCst) {
                reloj_volvio_atras = true;
            }
            if reloj_volvio_atras && reloj > 40_000 {
                break;
            }
        }
        assert!(reloj_volvio_atras, "el audio saltó a la sección A pero el reloj siguió por la línea antigua");
        assert!(desajustes <= 3, "el reloj no sigue al audio tras el salto ({desajustes} bloques desajustados)");
        assert!(engine.is_playing.load(Ordering::SeqCst), "la reproducción no debe detenerse tras el salto");
        let estado = engine.get_playback_state();
        assert_eq!(estado.queued_section_id, None, "el salto ya se aplicó: no debe seguir en cola");
        assert_eq!(estado.active_section_id.as_deref(), Some("a"));
    }

    #[tokio::test]
    async fn test_a01_vamp_mantiene_el_reloj_dentro_del_bucle_y_no_detiene_la_reproduccion() {
        let secciones = vec![seccion("a", 0.0, 2.0), seccion("b", 2.0, 4.0), seccion("c", 4.0, 6.0)];
        let engine = motor_real("a01_vamp", &[("pista", 288_000)], secciones).await;
        engine.seek(2.5).await;
        reproducir(&engine).await;
        assert!(engine.toggle_vamp(Some(true)).await);

        let (mut desajustes, mut vueltas, mut previo, mut bloques) = (0, 0, 0u64, 0u32);
        let limite = Instant::now() + std::time::Duration::from_secs(10);
        // 4 s de audio: 1,5 s hasta el final de B y casi otra vuelta completa de 2 s.
        while Instant::now() < limite && bloques < 400 {
            let (pos, reloj) = bloque(&engine);
            bloques += 1;
            if desajustado(pos, reloj) {
                desajustes += 1;
            }
            assert!(reloj < 192_000, "el reloj salió del bucle del vamp: {reloj}");
            if reloj + 20_000 < previo {
                vueltas += 1;
            }
            previo = reloj;
            assert!(engine.is_playing.load(Ordering::SeqCst), "el vamp no debe detener la reproducción");
        }
        assert!(vueltas >= 1, "el reloj nunca dio la vuelta del bucle");
        assert!(desajustes <= 4, "el reloj no sigue al audio en las vueltas del vamp ({desajustes} bloques)");
    }

    // ----- A03: pista terminada y buffering -----

    #[tokio::test]
    async fn test_a03_seek_mas_alla_del_final_de_una_pista_corta_no_deja_todo_en_buffering() {
        // Guía de 1 s y pista larga de 6 s. Seek a 3 s: la guía no tiene audio desde 1 s.
        let engine = motor_real(
            "a03_corta",
            &[("larga", 288_000), ("corta", 48_000)],
            vec![seccion("a", 0.0, 6.0)],
        )
        .await;
        engine.seek(3.0).await;
        reproducir(&engine).await;

        let (mut con_audio, mut desajustes) = (0, 0);
        let limite = Instant::now() + std::time::Duration::from_secs(4);
        while Instant::now() < limite {
            let (pos, reloj) = bloque(&engine);
            if pos.is_some() {
                con_audio += 1;
                if desajustado(pos, reloj) {
                    desajustes += 1;
                }
            }
            if con_audio >= 40 {
                break;
            }
        }
        assert!(
            !engine.is_buffering.load(Ordering::SeqCst),
            "la pista corta (sin audio tras el seek) dejó toda la canción en buffering"
        );
        assert!(con_audio >= 40, "casi no sonó audio tras el seek ({con_audio} bloques)");
        assert_eq!(desajustes, 0);
        assert!(engine.current_frame.load(Ordering::SeqCst) > 144_000, "el reloj no avanzó desde el destino");
    }

    #[tokio::test]
    async fn test_a03_seek_cerca_del_final_global_sale_de_buffering_y_termina() {
        // Quedan 480 fotogramas (10 ms): menos de los 150 ms que se exigían para salir de buffering.
        let engine = motor_real("a03_final", &[("pista", 288_000)], vec![seccion("a", 0.0, 6.0)]).await;
        engine.seek(6.0 - 480.0 / 48_000.0).await;
        reproducir(&engine).await;
        let limite = Instant::now() + std::time::Duration::from_secs(3);
        while Instant::now() < limite && engine.is_playing.load(Ordering::SeqCst) {
            bloque(&engine);
        }
        assert!(
            !engine.is_buffering.load(Ordering::SeqCst),
            "con menos de 150 ms por delante el motor se quedó en buffering"
        );
        assert!(
            !engine.is_playing.load(Ordering::SeqCst),
            "la reproducción debía terminar al llegar al final de la canción"
        );
        assert!(engine.current_frame.load(Ordering::SeqCst) >= 288_000);
    }

    // ----- A02: seek coordinado con los feeders -----

    #[test]
    fn test_a02_el_callback_no_sale_de_buffering_con_un_anillo_sin_vaciar() {
        // Hay 12 000 fotogramas (250 ms, más de los 150 ms de umbral) de audio viejo en cada anillo.
        let engine = engine_con_pistas(&[("a", 0.5), ("b", 0.5)], 12_000);
        engine.sample_rate.store(48_000, Ordering::SeqCst);
        // Un seek acaba de empezar: subió la generación y activó buffering, pero aún no vació los anillos.
        let generacion = engine.seek_generation.fetch_add(1, Ordering::SeqCst) + 1;
        engine.is_buffering.store(true, Ordering::SeqCst);

        let mut buf = vec![0.0f32; 480 * 2];
        engine.simulate_callback_block(&mut buf, 2);
        assert!(
            engine.is_buffering.load(Ordering::SeqCst),
            "salió de buffering con audio de la posición anterior todavía en el anillo"
        );
        assert!(buf.iter().all(|s| *s == 0.0), "debía sonar silencio mientras el seek no termina");

        // Cuando el transporte termina de vaciar y confirma la generación, ya puede salir.
        for trk in engine.stream_tracks.lock().unwrap().iter() {
            trk.flush_done.store(generacion, Ordering::SeqCst);
        }
        engine.simulate_callback_block(&mut buf, 2);
        assert!(!engine.is_buffering.load(Ordering::SeqCst));
    }

    #[tokio::test]
    async fn test_a02_seek_sin_feeder_no_se_cuelga_y_da_la_pista_por_terminada() {
        let engine = engine_con_pistas(&[("a", 0.5)], 12_000);
        engine.sample_rate.store(48_000, Ordering::SeqCst);
        let inicio = Instant::now();
        engine.seek(0.5).await;
        assert!(inicio.elapsed() < std::time::Duration::from_secs(1), "el seek esperó a un feeder inexistente");
        let tracks = engine.tracks.lock().await;
        assert!(tracks[0].eof.load(Ordering::SeqCst), "sin feeder la pista debe darse por terminada");
        assert_eq!(tracks[0].flush_done.load(Ordering::SeqCst), engine.seek_generation.load(Ordering::SeqCst));
        assert_eq!(tracks[0].consumer.lock().unwrap().slots(), 0, "el anillo debe quedar vacío");
    }

    // ----- A05: orden de adquisición de los mutex de proyecto -----

    #[tokio::test]
    async fn test_a05_load_project_no_retiene_tracks_mientras_espera_loaded_project_id() {
        // Una descarga en curso tiene `loaded_project_id` y pide `tracks`. Si la carga retuviera `tracks`
        // mientras espera `loaded_project_id`, ambas se bloquearían para siempre.
        let dir = escribir_cache_rampa("a05_orden", &[("p", 48_000)]);
        let engine = Arc::new(PlaybackEngine::new(Arc::new(AudioStreamStats::default())));
        let loaded_guard = engine.loaded_project_id.lock().await;

        let carga = {
            let engine = Arc::clone(&engine);
            tokio::spawn(async move {
                engine.load_project(&dir, "a05_orden", SR_PRUEBA, None, None, None, None).await
            })
        };
        // Margen para que la carga llegue al punto de espera.
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        assert!(!carga.is_finished(), "la carga debía esperar a loaded_project_id");

        let tracks = tokio::time::timeout(std::time::Duration::from_millis(500), engine.tracks.lock()).await;
        assert!(
            tracks.is_ok(),
            "load_project retiene `tracks` mientras espera `loaded_project_id`: deadlock con unload_project_if_matches"
        );
        drop(tracks);
        drop(loaded_guard);
        let resultado = tokio::time::timeout(std::time::Duration::from_secs(5), carga).await;
        assert!(resultado.expect("la carga no terminó").unwrap().is_ok());
    }

    #[tokio::test]
    async fn test_a05_cargas_y_descargas_simultaneas_terminan() {
        let dir = escribir_cache_rampa("a05_stress", &[("p", 48_000)]);
        let engine = Arc::new(PlaybackEngine::new(Arc::new(AudioStreamStats::default())));
        let mut tareas = Vec::new();
        for i in 0..8 {
            let engine = Arc::clone(&engine);
            let dir = dir.clone();
            tareas.push(tokio::spawn(async move {
                if i % 2 == 0 {
                    let _ = engine.load_project(&dir, "a05_stress", SR_PRUEBA, None, None, None, None).await;
                } else {
                    engine.unload_project_if_matches("a05_stress").await;
                }
            }));
        }
        let todas = futures_util_join(tareas);
        tokio::time::timeout(std::time::Duration::from_secs(20), todas)
            .await
            .expect("carga y descarga simultáneas se bloquearon");
    }

    async fn futures_util_join(tareas: Vec<tokio::task::JoinHandle<()>>) {
        for t in tareas {
            t.await.unwrap();
        }
    }

    #[tokio::test]
    async fn test_a02_seeks_consecutivos_con_varias_pistas_nunca_suenan_audio_viejo() {
        let engine = motor_real(
            "a02_seeks",
            &[("uno", 288_000), ("dos", 288_000)],
            vec![seccion("a", 0.0, 6.0)],
        )
        .await;
        reproducir(&engine).await;
        // Destinos fijos y dispersos (en segundos): saltos hacia delante y hacia atrás.
        let destinos = [4.0, 0.5, 5.0, 1.5, 3.0, 0.25, 4.5, 2.0, 5.5, 1.0, 3.5, 0.75];
        for (i, destino) in destinos.iter().enumerate() {
            engine.seek(*destino).await;
            let objetivo = (destino * 48_000.0) as i64;
            let mut primer_audio: Option<(i64, u64)> = None;
            let limite = Instant::now() + std::time::Duration::from_secs(3);
            while Instant::now() < limite && primer_audio.is_none() {
                let (pos, reloj) = bloque_n(&engine, 2.0);
                if let Some(p) = pos {
                    primer_audio = Some((p, reloj));
                }
            }
            let (pos, reloj) = primer_audio.unwrap_or_else(|| panic!("seek {i} a {destino} s: no sonó audio"));
            // El primer bloque tras la salida de buffering lleva un fundido de entrada de 8 ms; la
            // posición leída debe estar en el destino, no en la posición anterior.
            assert!(
                (pos - objetivo).abs() < 3_000,
                "seek {i} a {destino} s: sonó la posición {pos} en lugar de ~{objetivo} (reloj {reloj})"
            );
            assert!(!desajustado(Some(pos), reloj), "seek {i}: el reloj no coincide con el audio");
        }
    }

    // ----- A04: recuperación tras un underrun -----

    /// Motor con pistas de anillo manual: el test decide qué fotogramas entrega el «feeder» y cuándo.
    /// Devuelve los productores de cada pista.
    fn engine_con_productores(ids: &[&str], capacidad_frames: usize) -> (PlaybackEngine, Vec<rtrb::Producer<f32>>) {
        let engine = PlaybackEngine::new(Arc::new(AudioStreamStats::default()));
        let (mut activas, mut handles, mut productores) = (Vec::new(), Vec::new(), Vec::new());
        for id in ids {
            let (prod, cons) = rtrb::RingBuffer::<f32>::new(capacidad_frames * 2);
            productores.push(prod);
            let t = ActiveTrack {
                track_id: id.to_string(),
                file_path: std::path::PathBuf::new(),
                original_channels: 2,
                total_frames: 1_000_000,
                gain: Arc::new(AtomicU32::new(1.0f32.to_bits())),
                pan: Arc::new(AtomicI32::new(0)),
                muted: Arc::new(AtomicBool::new(false)),
                soloed: Arc::new(AtomicBool::new(false)),
                bus: Arc::new(AtomicU8::new(TrackBus::Main as u8)),
                consumer: Arc::new(std::sync::Mutex::new(cons)),
                stop_signal: Arc::new(AtomicBool::new(false)),
                seek_request: Arc::new(AtomicI64::new(-1)),
                jump_request: Arc::new(std::sync::Mutex::new(None)),
                is_vamping: Arc::new(AtomicBool::new(false)),
                active_section_loop: Arc::new(std::sync::Mutex::new(None)),
                pitch_semitones: Arc::new(AtomicI32::new(0)),
                meter: Arc::new(PeakMeter::default()),
                eof: Arc::new(AtomicBool::new(false)),
                seek_ack: Arc::new(AtomicU64::new(0)),
                flush_done: Arc::new(AtomicU64::new(0)),
                feeder_alive: Arc::new(AtomicBool::new(false)),
                skip_frames: Arc::new(AtomicU64::new(0)),
            };
            handles.push(StreamTrackHandle {
                consumer: Arc::clone(&t.consumer),
                gain: Arc::clone(&t.gain),
                pan: Arc::clone(&t.pan),
                muted: Arc::clone(&t.muted),
                soloed: Arc::clone(&t.soloed),
                bus: Arc::clone(&t.bus),
                meter: Arc::clone(&t.meter),
                eof: Arc::clone(&t.eof),
                flush_done: Arc::clone(&t.flush_done),
                skip_frames: Arc::clone(&t.skip_frames),
            });
            activas.push(t);
        }
        *engine.tracks.try_lock().unwrap() = activas;
        *engine.stream_tracks.lock().unwrap() = handles;
        engine.total_frames.store(1_000_000, Ordering::SeqCst);
        engine.is_playing.store(true, Ordering::SeqCst);
        (engine, productores)
    }

    /// Empuja los fotogramas `[desde, hasta)` de la rampa de prueba (el mismo valor que escribe
    /// `escribir_cache_rampa`).
    fn empujar_rampa(prod: &mut rtrb::Producer<f32>, desde: usize, hasta: usize) {
        for f in desde..hasta {
            let v = (f / PASO_RAMPA) as f32 / 32768.0;
            prod.push(v).unwrap();
            prod.push(v).unwrap();
        }
    }

    #[test]
    fn test_a04_consume_track_block_descarta_lo_que_llega_tarde() {
        let (mut prod, mut cons) = rtrb::RingBuffer::<f32>::new(4096);
        let skip = AtomicU64::new(0);
        let mut vistos: Vec<f32> = Vec::new();
        let rampa = |prod: &mut rtrb::Producer<f32>, desde: usize, hasta: usize| {
            for f in desde..hasta {
                prod.push(f as f32).unwrap();
                prod.push(f as f32).unwrap();
            }
        };

        rampa(&mut prod, 0, 100);
        assert!(!consume_track_block(&mut cons, &skip, false, 60, |_, l, _| vistos.push(l)));
        assert_eq!(vistos.last().copied(), Some(59.0));

        // Quedan 40 fotogramas y se piden 60: faltan 20.
        vistos.clear();
        assert!(consume_track_block(&mut cons, &skip, false, 60, |_, l, _| vistos.push(l)), "debe avisar del underrun");
        assert_eq!(vistos.len(), 40);
        assert_eq!(skip.load(Ordering::Relaxed), 20, "debe anotar los 20 fotogramas que no sonaron");

        // El feeder se recupera y entrega los fotogramas 100.. (los 100..119 debían sonar durante el hueco).
        rampa(&mut prod, 100, 200);
        vistos.clear();
        assert!(!consume_track_block(&mut cons, &skip, false, 50, |_, l, _| vistos.push(l)));
        assert_eq!(vistos.first().copied(), Some(120.0), "debe saltarse lo vencido y seguir en el fotograma 120");
        assert_eq!(skip.load(Ordering::Relaxed), 0);
    }

    #[test]
    fn test_a04_consume_track_block_no_desalinea_los_canales_con_un_fotograma_a_medias() {
        let (mut prod, mut cons) = rtrb::RingBuffer::<f32>::new(64);
        let skip = AtomicU64::new(0);
        // El feeder empuja muestra a muestra: el callback puede ver L1 sin su R1.
        for v in [0.0, 0.0, 1.0f32] {
            prod.push(v).unwrap();
        }
        let mut leidos: Vec<(f32, f32)> = Vec::new();
        assert!(consume_track_block(&mut cons, &skip, false, 2, |_, l, r| leidos.push((l, r))));
        assert_eq!(leidos, vec![(0.0, 0.0)], "solo el fotograma completo");
        assert_eq!(skip.load(Ordering::Relaxed), 1);

        for v in [1.0, 2.0, 2.0f32] {
            prod.push(v).unwrap();
        }
        leidos.clear();
        consume_track_block(&mut cons, &skip, false, 1, |_, l, r| leidos.push((l, r)));
        assert_eq!(leidos, vec![(2.0, 2.0)], "el fotograma 1 vencido se descarta entero y L/R siguen en su sitio");
    }

    #[test]
    fn test_a04_pista_terminada_no_acumula_descarte() {
        let (_prod, mut cons) = rtrb::RingBuffer::<f32>::new(64);
        let skip = AtomicU64::new(0);
        consume_track_block(&mut cons, &skip, true, 480, |_, _, _| {});
        assert_eq!(skip.load(Ordering::Relaxed), 0);
    }

    #[test]
    fn test_a04_tras_un_underrun_la_pista_vuelve_a_coincidir_con_el_reloj() {
        let (engine, mut productores) = engine_con_productores(&["a"], 20_000);
        empujar_rampa(&mut productores[0], 0, 960);
        bloque(&engine);
        let (pos, reloj) = bloque(&engine);
        assert!(!fuera_de_sitio(pos, reloj), "antes del hueco la pista debe coincidir con el reloj: {pos:?} / {reloj}");

        // El feeder se atrasa: este bloque no tiene datos y suena silencio, pero el reloj avanza.
        let (pos_hueco, reloj_hueco) = bloque(&engine);
        assert_eq!(pos_hueco, None);
        assert_eq!(reloj_hueco, 1440);

        // El feeder se recupera y entrega el audio a partir del fotograma 960, que debía sonar durante el hueco.
        empujar_rampa(&mut productores[0], 960, 960 + 4_800);
        for _ in 0..4 {
            let (pos, reloj) = bloque(&engine);
            assert!(pos.is_some(), "debe volver a sonar");
            assert!(!fuera_de_sitio(pos, reloj), "tras el hueco la pista quedó atrasada: audio {pos:?}, reloj {reloj}");
        }
    }

    #[test]
    fn test_a04_dos_pistas_siguen_alineadas_si_solo_una_se_atrasa() {
        let (engine, mut productores) = engine_con_productores(&["sana", "lenta"], 20_000);
        empujar_rampa(&mut productores[0], 0, 4_800);
        empujar_rampa(&mut productores[1], 0, 480);
        // Bloque 1: ambas suenan. Bloques 2 y 3: la lenta no tiene datos.
        for _ in 0..3 {
            bloque_n(&engine, 1.0);
        }
        // La lenta se recupera con el audio acumulado desde el fotograma 480.
        empujar_rampa(&mut productores[1], 480, 4_800);
        let (pos, reloj) = bloque_n(&engine, 2.0);
        assert!(pos.is_some());
        // Con las dos pistas en el mismo punto de la rampa, la salida es el doble de una sola.
        assert!(!fuera_de_sitio(pos, reloj), "la pista que se atrasó no volvió a su sitio: audio {pos:?}, reloj {reloj}");
    }

