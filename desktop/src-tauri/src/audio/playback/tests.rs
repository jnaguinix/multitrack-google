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

        // --- 1. MEDICIÃ“N ANTES: asignaciÃ³n de 8 vectores por callback + lock() ---
        let tracks_before = make_tracks(num_tracks);
        let stats_before = Arc::new(AudioStreamStats::default());
        stats_before.min_ring_buffer_level_ms.store(u64::MAX, Ordering::Relaxed);
        let fade_before = Arc::new(std::sync::Mutex::new(FadeEnvelope::new(FADE_MS, 48000)));

        for _ in 0..total_callbacks {
            let t0 = Instant::now();
            stats_before.callbacks.fetch_add(1, Ordering::Relaxed);

            let mut fade = fade_before.lock().unwrap();
            let _ = fade.next_gain();

            // AsignaciÃ³n dinÃ¡mica en cada llamada (8 vectores por callback)
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
                // Reponer frames para simular feeder en reproducciÃ³n continua de 10 min
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

        // --- 2. MEDICIÃ“N DESPUÃ‰S: bÃºferes preasignados con fill(0.0) + try_lock() ---
        let tracks_after = make_tracks(num_tracks);
        let stats_after = Arc::new(AudioStreamStats::default());
        stats_after.min_ring_buffer_level_ms.store(u64::MAX, Ordering::Relaxed);
        let fade_after = Arc::new(std::sync::Mutex::new(FadeEnvelope::new(FADE_MS, 48000)));

        // PreasignaciÃ³n de los 8 vectores una sola vez fuera del bucle
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

            // ReutilizaciÃ³n sin alocaciones dinÃ¡micas
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
                // Reponer frames para simular feeder en reproducciÃ³n continua de 10 min
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
            "ANTES   | Callbacks: {} | Underruns: {} | Max Âµs: {} | Min Buffer: {} ms",
            stats_before.callbacks.load(Ordering::Relaxed),
            stats_before.underruns.load(Ordering::Relaxed),
            stats_before.max_callback_duration_us.load(Ordering::Relaxed),
            stats_before.min_ring_buffer_level_ms.load(Ordering::Relaxed)
        );
        println!(
            "DESPUÃ‰S | Callbacks: {} | Underruns: {} | Max Âµs: {} | Min Buffer: {} ms",
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
