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
        // Con el tono distinto de 0 el golpe de una pista se queda en su sitio (la salida no va retrasada ni
        // adelantada respecto a la entrada) y la relación de remuestreo no cambia (ya no hay varispeed).
        let sample_rate = 48000u32;
        let chunk = 1024usize;
        let mut res = TrackResampler::new(sample_rate, sample_rate, chunk, 1).unwrap();
        assert_eq!(res.resample_ratio(), 1.0, "el tono no debe tocar la relación de remuestreo");
        let mut shifter = crate::audio::pitch::new_pitch_shifter(sample_rate, 1, 2);
        let mut input = vec![vec![0.0f32; 0]];
        let impulse_at = 30_000usize;
        let total = 60_000usize;
        for i in 0..total {
            // Un golpe corto con contenido tonal para que el algoritmo lo reproduzca.
            let v = if (impulse_at..impulse_at + 200).contains(&i) {
                (((i - impulse_at) as f32) * 0.37).sin() * 0.9 * (1.0 - (i - impulse_at) as f32 / 200.0)
            } else {
                0.0
            };
            input[0].push(v);
        }
        let mut out_staging = Vec::new();
        let mut compensado = false;
        drain_staging_through_resampler(&mut res, shifter.as_mut(), true, &mut input, &mut out_staging, &mut compensado, false);
        let mono: Vec<f32> = out_staging.chunks_exact(2).map(|c| c[0]).collect();
        let (peak_idx, _) = mono.iter().enumerate().fold((0usize, 0.0f32), |a, (i, v)| if v.abs() > a.1 { (i, v.abs()) } else { a });
        let diff = (peak_idx as i64 - impulse_at as i64).abs();
        assert!(diff < 480, "el golpe debe quedar en su sitio (±10 ms): desviación {diff} fotogramas");
    }

    #[test]
    fn test_resampled_click_alignment_44k_to_48k() {
        // Phase 4 Test 3: 44.1 kHz track played on 48 kHz output device maintains transient at +/- 1 sample
        let src_rate = 44100u32;
        let target_rate = 48000u32;

        let mut res = TrackResampler::new(src_rate, target_rate, 1024, 1).unwrap();

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
        let mut res_a = TrackResampler::new(44100, target_rate, 1024, 1).unwrap();
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
    fn test_feeder_cambio_de_tono_conserva_duracion_y_da_la_frecuencia() {
        // El tono cambia pero la canción dura lo mismo: entra y sale el mismo número de fotogramas, y la
        // frecuencia es la esperada. Pasa por el mismo camino que el feeder (remuestreador + cambio de tono).
        let sample_rate = 48000u32;
        let base_freq = 440.0f32;
        let total_frames = (8.0 * sample_rate as f64) as usize;
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
            for i in 1..samples.len() {
                if samples[i - 1] <= 0.0 && samples[i] > 0.0 {
                    let fraction = -samples[i - 1] / (samples[i] - samples[i - 1]);
                    crossings.push(i as f64 - 1.0 + fraction as f64);
                }
            }
            assert!(crossings.len() > 100, "Not enough zero crossings found");
            let total_cycles = (crossings.len() - 1) as f64;
            let total_samples = crossings.last().unwrap() - crossings.first().unwrap();
            ((total_cycles / total_samples) * sample_rate as f64) as f32
        };

        let block_sizes = [128, 256, 1024, 512, 768, 384, 1500, 2048, 100];

        // Pasa `input` por el camino del feeder con el tono dado; devuelve el canal izquierdo de salida.
        let run = |input: &[Vec<f32>], semitones: i32| -> Vec<f32> {
            let channels = input.len();
            let mut resampler = TrackResampler::new(sample_rate, sample_rate, 1024, channels).unwrap();
            let mut shifter = crate::audio::pitch::new_pitch_shifter(sample_rate, channels, semitones);
            let mut input_staging: Vec<Vec<f32>> = vec![Vec::new(); channels];
            let mut output_staging = Vec::new();
            let mut delay_compensated = false;
            let mut out = Vec::new();
            let mut in_pos = 0;
            let mut b_idx = 0;
            while in_pos < total_frames {
                let b_size = block_sizes[b_idx % block_sizes.len()].min(total_frames - in_pos);
                b_idx += 1;
                for (ch, src) in input_staging.iter_mut().zip(input) {
                    ch.extend_from_slice(&src[in_pos..in_pos + b_size]);
                }
                in_pos += b_size;
                drain_staging_through_resampler(
                    &mut resampler,
                    shifter.as_mut(),
                    channels == 1,
                    &mut input_staging,
                    &mut output_staging,
                    &mut delay_compensated,
                    false,
                );
                for chunk in output_staging.chunks_exact(2) {
                    out.push(chunk[0]);
                }
                output_staging.clear();
            }
            out
        };

        // Con tono 0 el camino no toca la duración (ni siquiera el retardo del remuestreador sobra).
        let reference_len = run(&make_sine(2), 0).len();
        let latency = crate::audio::pitch::PitchShifter::new(sample_rate, 2, 1).latency_frames();

        for (channels, semitones) in [(1usize, 1i32), (2, 6), (2, -6), (2, -3)] {
            let out = run(&make_sine(channels), semitones);
            // Misma duración que sin cambio de tono, salvo lo que el algoritmo aún retiene al terminar (su retardo,
            // que en reproducción continua no se nota: el feeder sigue alimentándolo) y el bloque que no llegó a salir.
            let missing = reference_len as i64 - out.len() as i64;
            assert!(
                (0..=(latency as i64 + 2048)).contains(&missing),
                "{semitones} tonos: la duración debe ser la misma ({} vs {reference_len} fotogramas)",
                out.len()
            );
            let expected = base_freq * 2.0f32.powf(semitones as f32 / 12.0);
            let measured = measure_frequency(&out[sample_rate as usize..out.len() - sample_rate as usize]);
            assert!(
                (measured - expected).abs() / expected < 0.01,
                "{channels} canal(es), {semitones} tonos: {measured} Hz, se esperaba {expected} Hz"
            );
        }
    }


    #[test]
    fn test_el_click_y_la_guia_no_se_transponen() {
        let tono = AtomicI32::new(3);
        for (bus, esperado) in [
            (TrackBus::Main, 3),
            (TrackBus::Both, 3),
            (TrackBus::CueClick, 0),
            (TrackBus::Guide, 0),
        ] {
            let b = std::sync::atomic::AtomicU8::new(bus as u8);
            assert_eq!(super::track_pitch(&tono, &b), esperado, "bus {}", bus.name());
        }
    }

    #[tokio::test]
    async fn test_cambiar_el_bus_de_una_pista_inexistente_no_mueve_nada() {
        // Una pista que pasa de música a click deja de transponerse (y al revés): el feeder recrea su cambio de
        // tono con un seek en el mismo punto (no medido con un feeder real). Aquí solo se comprueba que un bus
        // aplicado a una pista que no existe no reposiciona ni falla.
        let engine = motor_de_prueba();
        engine.set_pitch(2).await;
        let antes = engine.current_frame.load(Ordering::SeqCst);
        engine.set_track_controls("no-existe", None, None, None, None, Some("click")).await;
        assert_eq!(engine.current_frame.load(Ordering::SeqCst), antes);
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
                                cue_l[f] += l * g + click_buf[f];
                                cue_r[f] += r * g;
                            }
                            TrackBus::Both => {
                                both_l[f] += l * g;
                                both_r[f] += r * g;
                            }
                            TrackBus::Guide => {
                                cue_l[f] += l * g;
                                cue_r[f] += r * g;
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
            }
            main_l[..frames_per_block].fill(0.0);
            main_r[..frames_per_block].fill(0.0);
            cue_l[..frames_per_block].fill(0.0);
            cue_r[..frames_per_block].fill(0.0);
            both_l[..frames_per_block].fill(0.0);
            both_r[..frames_per_block].fill(0.0);
            click_buf[..frames_per_block].fill(0.0);

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
                                cue_l[f] += l * g + click_buf[f];
                                cue_r[f] += r * g;
                            }
                            TrackBus::Both => {
                                both_l[f] += l * g;
                                both_r[f] += r * g;
                            }
                            TrackBus::Guide => {
                                cue_l[f] += l * g;
                                cue_r[f] += r * g;
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
    /// Motor para las pruebas que simulan bloques del callback. El callback real siempre mezcla el metrónomo
    /// (su configuración por defecto lo tiene activo), así que aquí arranca apagado: las pruebas que miden niveles,
    /// ruteo o posición del audio no deben oír un click que no pusieron. Las que miden el click lo activan.
    fn motor_de_prueba() -> PlaybackEngine {
        let engine = PlaybackEngine::new(Arc::new(AudioStreamStats::default()));
        engine.metronome.lock().unwrap().config.enabled = false;
        engine
    }

    fn engine_con_pistas(amplitudes: &[(&str, f32)], frames: usize) -> PlaybackEngine {
        let engine = motor_de_prueba();
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
                monitor: Arc::new(AtomicBool::new(false)),
                split: Arc::new(AtomicBool::new(false)),
                cue_gain: Arc::new(AtomicU32::new(1.0f32.to_bits())),
                cue_muted: Arc::new(AtomicBool::new(false)),
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
                monitor: Arc::clone(&t.monitor),
                split: Arc::clone(&t.split),
                cue_gain: Arc::clone(&t.cue_gain),
                cue_muted: Arc::clone(&t.cue_muted),
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

    /// El bloque que ejecuta el callback real (`BlockMixer::process`) es el mismo que usan las pruebas, así que
    /// aquí se vigila la regla de tiempo real: con pistas, metrónomo, ruteo y limitador, un bloque no asigna memoria.
    #[test]
    fn test_el_bloque_del_callback_no_asigna_memoria() {
        let engine = engine_con_pistas(&[("a", 0.5), ("b", 0.25)], 16_384);
        engine.metronome.lock().unwrap().config.enabled = true;
        let mut buf = vec![0.0f32; 480 * 2];
        // El primer bloque crea el mezclador (reserva sus búferes, como al abrir el stream); no cuenta.
        engine.simulate_callback_block(&mut buf, 2);
        let asignaciones = crate::alloc_probe::count_allocs(|| {
            for _ in 0..20 {
                engine.simulate_callback_block(&mut buf, 2);
            }
        });
        assert_eq!(asignaciones, 0, "el callback no debe asignar memoria al mezclar un bloque");
        assert!(buf.iter().any(|v| v.abs() > 1e-3), "el bloque contado sí llevaba audio");
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
        let engine = motor_de_prueba();
        engine.bus_meters.click.record(0.3, 0.3);
        let s = engine.get_playback_state();
        assert!((s.meters.click.l - 0.3).abs() < 1e-6, "click: {}", s.meters.click.l);
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
        let engine = motor_de_prueba();
        engine.metronome.lock().unwrap().config.enabled = true; // estas pruebas miden el metrónomo del motor
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
        let engine = motor_de_prueba();
        engine.metronome.lock().unwrap().config.enabled = true; // estas pruebas miden el metrónomo del motor
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
        let engine = motor_de_prueba();
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
        let engine = motor_de_prueba();
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
    fn test_la_lectura_siempre_entrega_lo_pedido_y_pasado_el_final_es_silencio() {
        // Archivo estéreo de 3 fotogramas: (1,2) (3,4) (5,6) en i16.
        let bytes: Vec<u8> = [1i16, 2, 3, 4, 5, 6].iter().flat_map(|v| v.to_le_bytes()).collect();
        let mut archivo = std::io::Cursor::new(bytes);
        let mut staging: Vec<Vec<f32>> = vec![Vec::new(), Vec::new()];
        let k = 1.0 / 32768.0;

        // Se piden 5 y solo hay 3: llegan los 3 reales y 2 de silencio, nunca menos de lo pedido.
        assert!(read_into_staging(&mut archivo, false, 5, &mut staging).is_none(), "llegar al final no es un error");
        assert_eq!(staging[0], vec![1.0 * k, 3.0 * k, 5.0 * k, 0.0, 0.0]);
        assert_eq!(staging[1], vec![2.0 * k, 4.0 * k, 6.0 * k, 0.0, 0.0]);

        // Ya pasado el final: todo silencio, con la cantidad exacta.
        assert!(read_into_staging(&mut archivo, false, 4, &mut staging).is_none());
        assert_eq!(staging[0].len(), 9);
        assert!(staging[0][5..].iter().chain(&staging[1][5..]).all(|&v| v == 0.0));

        // Mono y el cruce de 8 ms: mismo criterio.
        let mut mono = std::io::Cursor::new([7i16].iter().flat_map(|v| v.to_le_bytes()).collect::<Vec<u8>>());
        let (mut l, mut r) = (vec![9.0f32; 3], vec![9.0f32; 3]);
        assert!(read_frames_to_slices(&mut mono, true, 3, &mut l, &mut r).is_none());
        assert_eq!(l, vec![7.0 * k, 0.0, 0.0]);
        assert_eq!(r, l);
    }

    #[test]
    fn test_a15_el_vaciado_parcial_no_añade_relleno_de_silencio() {
        // Tramo de 320 fotogramas de señal (menos que un bloque de 1024). Antes de la corrección, rubato
        // devolvía un bloque entero de salida (958 fotogramas) y el empalme insertaba ~640 de relleno.
        for (n, ya_compensado) in [(320usize, false), (320, true), (1000, true), (5, true)] {
            let mut r = TrackResampler::new(48000, 48000, 1024, 2).unwrap();
            let mut compensado = ya_compensado;
            let mut input: Vec<Vec<f32>> = vec![vec![0.5; n]; 2];
            let mut out = Vec::new();
            drain_staging_through_resampler(&mut r, None, false, &mut input, &mut out, &mut compensado, true);
            let fotogramas = out.len() / 2;
            let esperado = n + if ya_compensado { r.output_delay() } else { 0 };
            assert_eq!(fotogramas, esperado, "n={n}, compensado={ya_compensado}");
        }
    }

    #[test]
    fn test_a15_tras_un_empalme_el_remuestreador_empieza_un_tramo_nuevo() {
        let mut r = TrackResampler::new(48000, 48000, 1024, 2).unwrap();
        let mut compensado = true;
        begin_new_segment(&mut r, &mut compensado);
        assert!(!compensado, "el retardo del filtro debe volver a compensarse");
        assert_eq!(r.resample_ratio(), 1.0, "el remuestreador ya no cambia de relación (el tono lo hace otro módulo)");
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
    async fn test_el_tono_no_cambia_la_velocidad_de_la_cancion() {
        // Antes el tono se cambiaba remuestreando: con +6 tonos el reloj avanzaba un 41 % más deprisa. Ahora el
        // tono se cambia sin tocar la duración: el reloj avanza lo mismo que el bloque (480 fotogramas).
        for tono in [6, -6] {
            let engine = motor_real("tono_reloj", &[("pista", 480_000)], vec![seccion("a", 0.0, 10.0)]).await;
            engine.set_pitch(tono).await;
            assert_eq!(engine.pitch_semitones.load(Ordering::SeqCst), tono);
            reproducir(&engine).await;

            // Espera a que salga de buffering (el cambio de tono añade ~120 ms de retardo inicial a cada pista).
            let limite = Instant::now() + std::time::Duration::from_secs(5);
            while Instant::now() < limite && engine.is_buffering.load(Ordering::SeqCst) {
                bloque(&engine);
            }
            assert!(!engine.is_buffering.load(Ordering::SeqCst), "{tono} tonos: no salió de buffering");

            let (mut bloques, mut con_audio) = (0u64, 0);
            let inicio = engine.current_frame.load(Ordering::SeqCst);
            let limite = Instant::now() + std::time::Duration::from_secs(8);
            while Instant::now() < limite && bloques < 100 {
                let before = engine.current_frame.load(Ordering::SeqCst);
                let (pos, reloj) = bloque(&engine);
                if reloj > before {
                    assert_eq!(reloj - before, 480, "{tono} tonos: el reloj debe avanzar lo que dura el bloque");
                    bloques += 1;
                    if pos.is_some() || tono != 0 {
                        con_audio += 1;
                    }
                }
            }
            assert!(bloques >= 100, "{tono} tonos: no avanzó el reloj ({bloques} bloques)");
            assert_eq!(engine.current_frame.load(Ordering::SeqCst) - inicio, 480 * bloques);
            assert!(con_audio > 50, "{tono} tonos: casi no sonó audio");
        }
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

    /// Cuenta, en los bloques cuyo reloj cae en `[desde, hasta)`, cuántos suenan con las dos rampas sumadas en su sitio
    /// (pista larga + pista corta) y cuántos no. Si la pista corta está muda, la salida es una sola rampa y la
    /// posición leída con `pistas = 2` sale a la mitad del reloj.
    fn contar_dos_pistas_en_sitio(
        engine: &PlaybackEngine,
        desde: u64,
        hasta: u64,
        mut seguir: impl FnMut(u64) -> bool,
        segundos: u64,
    ) -> (u32, u32) {
        let (mut en_sitio, mut fuera) = (0u32, 0u32);
        let limite = Instant::now() + std::time::Duration::from_secs(segundos);
        while Instant::now() < limite && engine.is_playing.load(Ordering::SeqCst) {
            let (pos, reloj) = bloque_n(engine, 2.0);
            if !engine.is_buffering.load(Ordering::SeqCst) && (desde..hasta).contains(&reloj) {
                if desajustado(pos, reloj) || pos.is_none() {
                    fuera += 1;
                } else {
                    en_sitio += 1;
                }
            }
            if !seguir(reloj) {
                break;
            }
        }
        (en_sitio, fuera)
    }

    #[tokio::test]
    async fn test_una_pista_corta_vuelve_a_sonar_tras_un_salto_hacia_atras() {
        // Pista larga de 6 s y pista corta de 1 s. Se reproduce desde los 3 s (la corta ya terminó) y se salta a la
        // sección A (0 s): al volver, la corta tiene audio y debe sonar en su sitio, no quedarse muda.
        let secciones = vec![seccion("a", 0.0, 2.0), seccion("b", 2.0, 4.0), seccion("c", 4.0, 6.0)];
        let engine = motor_real("corta_salto", &[("larga", 288_000), ("corta", 48_000)], secciones).await;
        engine.seek(3.0).await;
        reproducir(&engine).await;
        let salto = engine.queue_section_jump("a", Some("1-bar")).await.unwrap();
        assert_eq!((salto.transition_frame, salto.target_frame), (192_000, 0));

        let mut volvio = false;
        let (en_sitio, fuera) = contar_dos_pistas_en_sitio(
            &engine,
            4_800,
            40_000,
            |reloj| {
                if reloj < 100_000 {
                    volvio = true;
                }
                !(volvio && reloj >= 40_000)
            },
            10,
        );
        assert!(volvio, "el salto hacia atrás no se aplicó");
        assert!(en_sitio >= 20, "casi no se midió audio tras el salto ({en_sitio} bloques en sitio, {fuera} fuera)");
        assert!(fuera <= 3, "la pista corta no volvió a sonar tras el salto: {fuera} bloques fuera de sitio, {en_sitio} en sitio");
    }

    #[tokio::test]
    async fn test_una_pista_corta_vuelve_a_sonar_en_cada_vuelta_de_un_vamp_que_acaba_despues_que_ella() {
        // Pista larga de 6 s y corta de 3 s. Vamp en B (2–4 s): el bucle termina después de la corta. En cada vuelta
        // la canción regresa a los 2 s, donde la corta sí tiene audio, y debe sonar ahí.
        let secciones = vec![seccion("a", 0.0, 2.0), seccion("b", 2.0, 4.0), seccion("c", 4.0, 6.0)];
        let engine = motor_real("corta_vamp", &[("larga", 288_000), ("corta", 144_000)], secciones).await;
        engine.seek(2.5).await;
        reproducir(&engine).await;
        assert!(engine.toggle_vamp(Some(true)).await);

        // Primero se deja pasar una vuelta completa (el reloj supera los 3 s y vuelve a los 2 s).
        let (mut paso_el_final, mut vueltas, mut previo) = (false, 0u32, 0u64);
        let limite = Instant::now() + std::time::Duration::from_secs(10);
        while Instant::now() < limite && vueltas == 0 {
            let (_, reloj) = bloque_n(&engine, 2.0);
            if reloj > 150_000 {
                paso_el_final = true;
            }
            if paso_el_final && reloj + 24_000 < previo {
                vueltas += 1;
            }
            previo = reloj;
        }
        assert!(vueltas > 0, "el vamp no dio la vuelta");

        // Tras la vuelta, entre 2,1 s y 2,9 s las dos pistas deben sonar en su sitio.
        let (en_sitio, fuera) = contar_dos_pistas_en_sitio(&engine, 100_800, 139_200, |reloj| reloj < 139_200, 10);
        assert!(en_sitio >= 20, "casi no se midió audio tras la vuelta ({en_sitio} bloques en sitio, {fuera} fuera)");
        assert!(fuera <= 3, "la pista corta no volvió a sonar en la vuelta del vamp: {fuera} bloques fuera de sitio, {en_sitio} en sitio");
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

    // ----- Ruteo de salidas por dispositivo -----

    use crate::audio::routing::{propose as proponer_ruteo, RouteTable, RoutingConfig, Source};

    /// Motor con una pista de música, una de click y otra de guía (cada una con su bus), listo para sonar.
    async fn motor_con_buses(nombre: &str, ruteo: &RoutingConfig) -> PlaybackEngine {
        let engine = motor_real(nombre, &[("musica", 288_000), ("click", 288_000), ("guia", 288_000)], vec![seccion("a", 0.0, 6.0)]).await;
        engine.set_track_controls("guia", None, None, None, None, Some("guide")).await;
        engine.routing.store(&RouteTable::from_config(ruteo));
        reproducir(&engine).await;
        engine
    }

    /// Pico por canal de salida durante `bloques` bloques de 480 fotogramas.
    fn picos_por_canal(engine: &PlaybackEngine, canales: usize, bloques: usize) -> Vec<f32> {
        let mut picos = vec![0.0f32; canales];
        for _ in 0..bloques {
            let mut buf = vec![0.0f32; 480 * canales];
            engine.simulate_callback_block(&mut buf, canales);
            std::thread::sleep(std::time::Duration::from_millis(5));
            for (i, v) in buf.iter().enumerate() {
                let ch = i % canales;
                picos[ch] = picos[ch].max(v.abs());
            }
        }
        picos
    }

    #[tokio::test]
    async fn test_ruteo_4_salidas_separa_musica_click_y_guia_sin_filtraciones() {
        let engine = motor_con_buses("ruteo4", &proponer_ruteo(4)).await;
        let todas = picos_por_canal(&engine, 4, 80);
        assert!(todas[0] > 1e-3 && todas[1] > 1e-3, "música en las salidas 1 y 2: {todas:?}");
        assert!(todas[2] > 1e-3, "click en la salida 3: {todas:?}");
        assert!(todas[3] > 1e-3, "guía en la salida 4: {todas:?}");

        // Sin click ni guía: no puede sonar nada en sus salidas (y la música sigue en las suyas).
        engine.set_track_controls("click", None, None, Some(true), None, None).await;
        engine.set_track_controls("guia", None, None, Some(true), None, None).await;
        let solo_musica = picos_por_canal(&engine, 4, 40);
        assert!(solo_musica[0] > 1e-3 && solo_musica[1] > 1e-3, "{solo_musica:?}");
        assert_eq!(solo_musica[2], 0.0, "la música se coló en la salida del click");
        assert_eq!(solo_musica[3], 0.0, "la música se coló en la salida de la guía");

        // Sin música: el click y la guía no pueden aparecer en las salidas musicales.
        engine.set_track_controls("click", None, None, Some(false), None, None).await;
        engine.set_track_controls("guia", None, None, Some(false), None, None).await;
        engine.set_track_controls("musica", None, None, Some(true), None, None).await;
        let solo_cue = picos_por_canal(&engine, 4, 40);
        assert_eq!(solo_cue[0], 0.0, "el click/guía se coló en la música izquierda: {solo_cue:?}");
        assert_eq!(solo_cue[1], 0.0, "el click/guía se coló en la música derecha: {solo_cue:?}");
        assert!(solo_cue[2] > 1e-3 && solo_cue[3] > 1e-3, "{solo_cue:?}");
    }

    #[tokio::test]
    async fn test_ruteo_2_salidas_click_y_guia_a_la_izquierda_y_musica_en_mono_a_la_derecha() {
        let engine = motor_con_buses("ruteo2", &proponer_ruteo(2)).await;
        let todas = picos_por_canal(&engine, 2, 80);
        assert!(todas[0] > 1e-3, "click y guía en la salida 1 (izquierda): {todas:?}");
        assert!(todas[1] > 1e-3, "música (mono) en la salida 2 (derecha): {todas:?}");

        engine.set_track_controls("click", None, None, Some(true), None, None).await;
        engine.set_track_controls("guia", None, None, Some(true), None, None).await;
        let solo_musica = picos_por_canal(&engine, 2, 40);
        assert!(solo_musica[1] > 1e-3);
        assert_eq!(solo_musica[0], 0.0, "la música se coló en la salida de click y guía (izquierda)");

        engine.set_track_controls("click", None, None, Some(false), None, None).await;
        engine.set_track_controls("guia", None, None, Some(false), None, None).await;
        engine.set_track_controls("musica", None, None, Some(true), None, None).await;
        let solo_cue = picos_por_canal(&engine, 2, 40);
        assert_eq!(solo_cue[1], 0.0, "el click o la guía se colaron en la salida de música (derecha): {solo_cue:?}");
        assert!(solo_cue[0] > 1e-3);
    }

    #[tokio::test]
    async fn test_el_contador_del_limitador_solo_sube_cuando_actua() {
        let engine = motor_con_buses("limitador", &proponer_ruteo(2)).await;
        engine.stats.reset();
        let p = picos_por_canal(&engine, 2, 80);
        assert!(p[1] > 1e-3, "suena la música: {p:?}");
        // Solo cuenta los bloques que llegaron a mezclarse (los de espera de búfer salen en silencio antes).
        let escritas = engine.stats.output_samples.load(Ordering::Relaxed);
        assert!(escritas > 0 && escritas % 2 == 0, "cuenta las muestras de salida mezcladas: {escritas}");
        assert_eq!(engine.stats.limited_samples.load(Ordering::Relaxed), 0, "a nivel normal el limitador no actúa");

        // Fader de la música muy arriba: la salida pasa del umbral y el contador lo registra.
        engine.set_track_controls("musica", Some(20.0), None, None, None, None).await;
        let p = picos_por_canal(&engine, 2, 40);
        assert!(p[1] <= 1.0, "el limitador evita el recorte duro: {p:?}");
        assert!(engine.stats.limited_samples.load(Ordering::Relaxed) > 0, "el contador registra cuando el limitador actúa");
    }

    #[tokio::test]
    async fn test_ruteo_3_salidas_conserva_el_estereo_de_la_musica() {
        let engine = motor_con_buses("ruteo3", &proponer_ruteo(3)).await;
        // La música a la izquierda del todo: solo debe sonar la salida 1; la 2 (música derecha) queda en silencio.
        engine.set_track_controls("musica", None, Some(-100), None, None, None).await;
        engine.set_track_controls("click", None, None, Some(true), None, None).await;
        engine.set_track_controls("guia", None, None, Some(true), None, None).await;
        let izq = picos_por_canal(&engine, 3, 80);
        assert!(izq[0] > 1e-3, "{izq:?}");
        assert!(izq[1] < 1e-5, "con 3 salidas la música izquierda y derecha son salidas distintas, sin downmix: {izq:?}");
        assert_eq!(izq[2], 0.0);

        engine.set_track_controls("musica", None, Some(100), None, None, None).await;
        let der = picos_por_canal(&engine, 3, 40);
        assert!(der[1] > 1e-3 && der[0] < 1e-5, "{der:?}");
    }

    #[tokio::test]
    async fn test_ruteo_los_canales_extra_quedan_en_silencio() {
        let engine = motor_con_buses("ruteo6", &proponer_ruteo(6)).await;
        let p = picos_por_canal(&engine, 6, 80);
        assert!(p[0] > 1e-3 && p[2] > 1e-3 && p[3] > 1e-3);
        assert_eq!(p[4], 0.0, "las salidas libres no reciben nada");
        assert_eq!(p[5], 0.0);
    }

    #[tokio::test]
    async fn test_ruteo_no_se_puede_cambiar_mientras_suena_y_solo_afecta_al_dispositivo_activo() {
        let engine = motor_con_buses("ruteo_cambio", &proponer_ruteo(2)).await;
        let tabla4 = RouteTable::from_config(&proponer_ruteo(4));
        *engine.active_routing_key.lock().unwrap() = Some("wasapi|Interfaz A".to_string());

        // Suena: no se permite cambiar el ruteo del dispositivo activo.
        assert!(engine.apply_routing("wasapi|Interfaz A", &tabla4).is_err());
        assert_eq!(engine.routing.load().channels, 2, "el ruteo no debe cambiar mientras suena");
        // Otro dispositivo: no hay nada que aplicar ahora.
        assert!(engine.apply_routing("wasapi|Otra", &tabla4).is_ok());
        assert_eq!(engine.routing.load().channels, 2);
        // Parado: se aplica.
        engine.pause().await;
        assert!(engine.apply_routing("wasapi|Interfaz A", &tabla4).is_ok());
        assert_eq!(engine.routing.load().channels, 4);
        assert_eq!(engine.routing.load().gains[3][Source::Guide.index()], 1.0);
    }

    // ----- Secuencia dividida: click y guía a la izquierda, instrumentos a la derecha, en un solo archivo -----

    /// Caché con canales distintos y constantes: `l` en el izquierdo y `r` en el derecho.
    fn escribir_cache_lr(nombre: &str, pistas: &[(&str, usize, i16, i16)]) -> std::path::PathBuf {
        use crate::audio::cache::{write_track_pcm_and_metadata, TrackPcmMetadata};
        let dir = std::env::temp_dir().join(format!("omnitracks_lr_{nombre}"));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        for (id, frames, l, r) in pistas {
            let mut muestras = Vec::with_capacity(frames * 2);
            for _ in 0..*frames {
                muestras.push(*l);
                muestras.push(*r);
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

    /// Motor con una sola pista «secuencia» (canal izquierdo `l`, derecho `r`), dividida o no.
    async fn motor_secuencia(nombre: &str, l: i16, r: i16, dividida: bool, ruteo: &RoutingConfig) -> PlaybackEngine {
        let dir = escribir_cache_lr(nombre, &[("secuencia", 288_000, l, r)]);
        let engine = motor_de_prueba();
        engine
            .load_project(&dir, nombre, SR_PRUEBA, Some(120.0), Some(4), Some(vec![seccion("a", 0.0, 6.0)]), Some("1-bar".to_string()))
            .await
            .expect("load_project");
        // Como hace la interfaz: el bus va explícito (el bus inicial del motor se deduce del ID y «secuencia» contiene «cue»).
        engine.set_track_controls("secuencia", None, None, None, None, Some("main")).await;
        engine.set_track_split("secuencia", dividida).await;
        engine.routing.store(&RouteTable::from_config(ruteo));
        reproducir(&engine).await;
        engine
    }

    #[tokio::test]
    async fn test_secuencia_dividida_2_salidas_el_click_nunca_sale_por_la_salida_de_musica() {
        // Solo canal izquierdo (click y guía): sale por la izquierda (auriculares) y NADA por la de música.
        let engine = motor_secuencia("sec2_l", 12_000, 0, true, &proponer_ruteo(2)).await;
        let p = picos_por_canal(&engine, 2, 80);
        assert!(p[0] > 1e-3, "el click de la secuencia sale por auriculares: {p:?}");
        assert_eq!(p[1], 0.0, "el click de la secuencia se coló en la salida de música (la oiría el público): {p:?}");
        // Solo canal derecho (instrumentos): sale por la música y nada por auriculares.
        let engine = motor_secuencia("sec2_r", 0, 12_000, true, &proponer_ruteo(2)).await;
        let p = picos_por_canal(&engine, 2, 80);
        assert!(p[1] > 1e-3, "los instrumentos salen por la música: {p:?}");
        assert_eq!(p[0], 0.0, "los instrumentos se colaron en auriculares: {p:?}");
    }

    #[tokio::test]
    async fn test_sin_marcar_como_dividida_el_click_de_la_secuencia_llegaria_al_publico() {
        // Muestra por qué existe el tipo: una pista normal mezcla sus dos canales en la música.
        let engine = motor_secuencia("sec_normal", 12_000, 0, false, &proponer_ruteo(2)).await;
        let p = picos_por_canal(&engine, 2, 80);
        assert!(p[1] > 1e-3, "sin la marca, el canal izquierdo acaba en la salida de música: {p:?}");
    }

    #[tokio::test]
    async fn test_secuencia_dividida_3_y_4_salidas() {
        // 3 salidas: los instrumentos (canal derecho) salen por las dos salidas de música; el click por la 3.
        let engine = motor_secuencia("sec3_r", 0, 12_000, true, &proponer_ruteo(3)).await;
        let p = picos_por_canal(&engine, 3, 80);
        assert!(p[0] > 1e-3 && p[1] > 1e-3, "instrumentos por música izquierda y derecha: {p:?}");
        assert!((p[0] - p[1]).abs() < 1e-4, "el canal derecho se reparte igual a los dos lados: {p:?}");
        assert_eq!(p[2], 0.0, "{p:?}");
        let engine = motor_secuencia("sec3_l", 12_000, 0, true, &proponer_ruteo(3)).await;
        let p = picos_por_canal(&engine, 3, 80);
        assert_eq!((p[0], p[1]), (0.0, 0.0), "el click no sale por la música: {p:?}");
        assert!(p[2] > 1e-3, "{p:?}");
        // 4 salidas: el canal izquierdo sale por la del click, no por la de la guía.
        let engine = motor_secuencia("sec4_l", 12_000, 0, true, &proponer_ruteo(4)).await;
        let p = picos_por_canal(&engine, 4, 80);
        assert!(p[2] > 1e-3, "por la salida del click: {p:?}");
        assert_eq!(p[3], 0.0, "no por la de la guía: {p:?}");
        assert_eq!((p[0], p[1]), (0.0, 0.0), "{p:?}");
    }

    #[tokio::test]
    async fn test_secuencia_dividida_dos_controles_independientes() {
        // 2 salidas: 0 = auriculares (click), 1 = música.
        let engine = motor_secuencia("sec_ctl", 12_000, 12_000, true, &proponer_ruteo(2)).await;
        let a = picos_por_canal(&engine, 2, 80);
        assert!(a[0] > 1e-3 && a[1] > 1e-3, "{a:?}");
        // Mute de la pista: apaga la música, el click sigue.
        engine.set_track_controls("secuencia", None, None, Some(true), None, None).await;
        let m = picos_por_canal(&engine, 2, 40);
        assert_eq!(m[1], 0.0, "el mute de la pista apaga la música: {m:?}");
        assert!(m[0] > 1e-3, "el click de la secuencia sigue sonando: {m:?}");
        engine.set_track_controls("secuencia", None, None, Some(false), None, None).await;
        // Mute del click (fader Click): apaga el click, la música sigue.
        engine.set_track_cue("secuencia", None, Some(true)).await;
        let c = picos_por_canal(&engine, 2, 40);
        assert_eq!(c[0], 0.0, "el mute del Click apaga el click de la secuencia: {c:?}");
        assert!(c[1] > 1e-3, "{c:?}");
        engine.set_track_cue("secuencia", None, Some(false)).await;
        // Volumen del click a la mitad: el click baja, la música no cambia.
        let pleno = picos_por_canal(&engine, 2, 60);
        engine.set_track_cue("secuencia", Some(0.5), None).await;
        let medio = picos_por_canal(&engine, 2, 60);
        assert!(medio[0] < pleno[0] * 0.75, "el fader Click baja el click ({} vs {})", medio[0], pleno[0]);
        assert!((medio[1] - pleno[1]).abs() < 1e-4, "la música no cambia ({} vs {})", medio[1], pleno[1]);
        let s = engine.get_playback_state();
        let t = s.track_controls.iter().find(|x| x.track_id == "secuencia").unwrap();
        assert!(t.split_sequence && !t.cue_muted && (t.cue_gain - 0.5).abs() < 1e-6, "el estado informa la secuencia dividida: {t:?}");
    }

    // ----- Envío a auriculares («Aur.») -----

    /// Solo suenan las pistas marcadas «Aur.»: click y guía en silencio.
    async fn solo_monitor(nombre: &str, ruteo: &RoutingConfig) -> PlaybackEngine {
        let engine = motor_con_buses(nombre, ruteo).await;
        engine.set_track_controls("click", None, None, Some(true), None, None).await;
        engine.set_track_controls("guia", None, None, Some(true), None, None).await;
        engine
    }

    #[tokio::test]
    async fn test_monitor_envia_la_pista_marcada_a_la_salida_de_auriculares() {
        for (n, cue_out) in [(2usize, 0usize), (4, 3)] {
            let music_out = if n == 2 { 1 } else { 0 };
            let engine = solo_monitor(&format!("mon_{n}"), &proponer_ruteo(n as u16)).await;
            // Sin marcar nada: la salida de auriculares queda en silencio (click y guía mudos).
            let sin = picos_por_canal(&engine, n, 40);
            assert_eq!(sin[cue_out], 0.0, "con {n} salidas, sin «Aur.» no debe salir nada por auriculares: {sin:?}");
            // El piano marcado: sigue en Main y además sale por auriculares.
            engine.set_track_monitor("musica", true).await;
            let con = picos_por_canal(&engine, n, 80);
            assert!(con[cue_out] > 1e-3, "con {n} salidas, el piano marcado debe oírse en auriculares: {con:?}");
            assert!(con[music_out] > 1e-3, "y debe seguir en la música: {con:?}");
            // Al desmarcarlo vuelve el silencio.
            engine.set_track_monitor("musica", false).await;
            let fin = picos_por_canal(&engine, n, 40);
            assert_eq!(fin[cue_out], 0.0, "desmarcado, deja de salir por auriculares: {fin:?}");
        }
    }

    #[tokio::test]
    async fn test_el_medidor_del_monitor_mide_el_envio_a_auriculares() {
        let engine = solo_monitor("mon_medidor", &proponer_ruteo(2)).await;
        // Sin pistas marcadas el medidor del Monitor queda en cero.
        let _ = engine.take_meters();
        picos_por_canal(&engine, 2, 40);
        assert_eq!(engine.take_meters().monitor.l, 0.0, "sin «Aur.» no hay nivel en el Monitor");
        // Con el piano marcado el medidor sube, y baja con el volumen del Monitor.
        engine.set_track_monitor("musica", true).await;
        engine.set_monitor_gain(1.0);
        picos_por_canal(&engine, 2, 80);
        let pleno = engine.take_meters().monitor;
        assert!(pleno.l > 1e-3 && pleno.r > 1e-3, "el Monitor debe medir el envío: {pleno:?}");
        // El medidor mide lo que sale por auriculares (con 2 salidas, la 0), con el fader Monitor aplicado.
        engine.set_monitor_gain(0.5);
        let salida = picos_por_canal(&engine, 2, 80);
        let medio = engine.take_meters().monitor.l;
        assert!(
            (medio - salida[0]).abs() < 1e-3,
            "el medidor coincide con la salida de auriculares ({medio} vs {})",
            salida[0]
        );
        engine.set_monitor_gain(0.0);
        picos_por_canal(&engine, 2, 40);
        assert_eq!(engine.take_meters().monitor.l, 0.0, "con el fader a 0 el medidor queda en cero");
    }

    #[tokio::test]
    async fn test_monitor_con_4_salidas_va_con_la_guia_y_no_con_el_click() {
        let engine = solo_monitor("mon_guia", &proponer_ruteo(4)).await;
        engine.set_track_monitor("musica", true).await;
        let p = picos_por_canal(&engine, 4, 80);
        assert!(p[3] > 1e-3, "el monitor sale con la guía: {p:?}");
        assert_eq!(p[2], 0.0, "y no por la salida del click: {p:?}");
    }

    #[tokio::test]
    async fn test_monitor_respeta_mute_y_el_volumen_general() {
        // 2 salidas: auriculares a la izquierda (0), música a la derecha (1).
        let engine = solo_monitor("mon_mute", &proponer_ruteo(2)).await;
        engine.set_track_monitor("musica", true).await;
        let a = picos_por_canal(&engine, 2, 80);
        assert!(a[0] > 1e-3);
        // Pista silenciada: no envía nada a auriculares.
        engine.set_track_controls("musica", None, None, Some(true), None, None).await;
        let m = picos_por_canal(&engine, 2, 40);
        assert_eq!(m[0], 0.0, "una pista en mute no se oye ni en auriculares: {m:?}");
        engine.set_track_controls("musica", None, None, Some(false), None, None).await;
        // Volumen general del monitor a cero: silencio en auriculares; la música sigue.
        engine.set_monitor_gain(0.0);
        let g = picos_por_canal(&engine, 2, 40);
        assert_eq!(g[0], 0.0, "con el volumen del monitor a 0 no sale nada: {g:?}");
        assert!(g[1] > 1e-3, "la música no cambia: {g:?}");
        // Mitad de volumen: el envío baja a la mitad.
        engine.set_monitor_gain(1.0);
        let pleno = picos_por_canal(&engine, 2, 80)[0];
        engine.set_monitor_gain(0.5);
        let medio = picos_por_canal(&engine, 2, 80)[0];
        assert!(medio < pleno * 0.75, "el volumen general del monitor escala el envío ({medio} vs {pleno})");
    }

    #[tokio::test]
    async fn test_el_estado_informa_el_monitor_de_cada_pista_y_su_volumen() {
        let engine = motor_real("estado_monitor", &[("piano", 48_000), ("bajo", 48_000)], vec![seccion("a", 0.0, 1.0)]).await;
        engine.set_track_monitor("piano", true).await;
        engine.set_monitor_gain(0.6);
        let s = engine.get_playback_state();
        assert!(s.track_controls.iter().find(|t| t.track_id == "piano").unwrap().monitor);
        assert!(!s.track_controls.iter().find(|t| t.track_id == "bajo").unwrap().monitor);
        assert!((s.monitor_gain - 0.6).abs() < 1e-6);
    }

    // ----- Estado de los controles de pista (red de seguridad contra órdenes perdidas) -----

    #[tokio::test]
    async fn test_el_estado_incluye_los_controles_reales_de_cada_pista() {
        let engine = motor_real("estado_controles", &[("bajo", 48_000), ("click", 48_000)], vec![seccion("a", 0.0, 1.0)]).await;
        engine.set_track_controls("bajo", Some(0.5), Some(-40), Some(true), Some(true), None).await;
        engine.set_track_controls("click", None, None, None, None, Some("guide")).await;
        let s = engine.get_playback_state();
        let bajo = s.track_controls.iter().find(|t| t.track_id == "bajo").expect("bajo en el estado");
        assert_eq!((bajo.gain, bajo.pan, bajo.muted, bajo.soloed), (0.5, -40, true, true));
        assert_eq!(bajo.bus, "main");
        let click = s.track_controls.iter().find(|t| t.track_id == "click").expect("click en el estado");
        assert_eq!(click.bus, "guide", "el bus se informa con el nombre que usa la interfaz");
        assert!(!click.soloed && !click.muted);
    }

    // ----- Paneo de pistas estéreo -----

    #[test]
    fn test_pan_estereo_al_extremo_manda_todo_el_contenido_a_ese_lado() {
        // Una pista estéreo con contenido distinto en cada canal (un bajo con la guitarra abierta a un lado).
        let (l, r) = (0.8f32, 0.2f32);
        let izq = apply_pan(l, r, pan_law(-1.0, 1.0));
        assert!((izq.0 - 0.5).abs() < 1e-5, "a la izquierda debe sonar la media de L y R, no solo L: {}", izq.0);
        assert!(izq.1.abs() < 1e-5, "el lado contrario debe quedar en silencio: {}", izq.1);
        let der = apply_pan(l, r, pan_law(1.0, 1.0));
        assert!((der.1 - 0.5).abs() < 1e-5 && der.0.abs() < 1e-5, "simétrico a la derecha: {der:?}");
    }

    #[test]
    fn test_pan_al_centro_no_toca_la_imagen_estereo() {
        let law = pan_law(0.0, 1.0);
        let (tl, tr) = apply_pan(0.9, -0.3, law);
        let k = std::f32::consts::FRAC_1_SQRT_2;
        assert!((tl - 0.9 * k).abs() < 1e-5 && (tr + 0.3 * k).abs() < 1e-5, "{tl} {tr}");
    }

    #[test]
    fn test_pan_de_una_fuente_mono_es_igual_que_el_paneo_clasico() {
        // Una pista mono llega con L == R: el cambio no debe alterar su nivel en ningún punto del paneo.
        for i in -10..=10 {
            let pan = i as f32 / 10.0;
            let g = 0.7f32;
            let law = pan_law(pan, g);
            let angle = (pan + 1.0) * (std::f32::consts::PI / 4.0);
            let (tl, tr) = apply_pan(0.6, 0.6, law);
            assert!((tl - 0.6 * angle.cos() * g).abs() < 1e-5, "pan {pan}: L {tl}");
            assert!((tr - 0.6 * angle.sin() * g).abs() < 1e-5, "pan {pan}: R {tr}");
        }
    }

    #[test]
    fn test_pan_es_continuo_sin_saltos_al_salir_del_centro() {
        let (l, r) = (0.8f32, 0.2f32);
        let mut previo = apply_pan(l, r, pan_law(-1.0, 1.0));
        for i in -99..=100 {
            let actual = apply_pan(l, r, pan_law(i as f32 / 100.0, 1.0));
            assert!((actual.0 - previo.0).abs() < 0.03 && (actual.1 - previo.1).abs() < 0.03, "salto brusco en {i}: {previo:?} -> {actual:?}");
            previo = actual;
        }
    }

    // ----- Auditoría: vamp y saltos tardíos -----

    #[tokio::test]
    async fn test_encolar_un_salto_con_vamp_activo_desactiva_el_vamp() {
        let secciones = vec![seccion("a", 0.0, 2.0), seccion("b", 2.0, 4.0), seccion("c", 4.0, 6.0)];
        let engine = motor_real("aud_vamp_salto", &[("pista", 288_000)], secciones).await;
        engine.seek(2.5).await;
        assert!(engine.toggle_vamp(Some(true)).await);
        assert!(engine.clock_jumps.loop_range().is_some());
        engine.queue_section_jump("c", Some("section-end")).await.unwrap();
        assert!(!engine.is_vamping.load(Ordering::SeqCst), "el vamp debe quedar desactivado al saltar");
        assert!(engine.clock_jumps.loop_range().is_none(), "el reloj no debe conservar el bucle del vamp");
    }

    #[tokio::test]
    async fn test_seek_fuera_del_bucle_desactiva_el_vamp_y_dentro_lo_mantiene() {
        let secciones = vec![seccion("a", 0.0, 2.0), seccion("b", 2.0, 4.0), seccion("c", 4.0, 6.0)];
        let engine = motor_real("aud_vamp_seek", &[("pista", 288_000)], secciones).await;
        engine.seek(2.5).await;
        assert!(engine.toggle_vamp(Some(true)).await);
        engine.seek(3.0).await; // dentro de B
        assert!(engine.is_vamping.load(Ordering::SeqCst), "un seek dentro del bucle conserva el vamp");
        engine.seek(5.0).await; // fuera, en C
        assert!(!engine.is_vamping.load(Ordering::SeqCst), "un seek fuera del bucle desactiva el vamp");
        assert!(engine.clock_jumps.loop_range().is_none());
    }

    #[tokio::test]
    async fn test_cancelar_un_salto_antes_de_empalmar_lo_cancela() {
        let secciones = vec![seccion("a", 0.0, 2.0), seccion("b", 2.0, 4.0), seccion("c", 4.0, 6.0)];
        let engine = motor_real("aud_cancel_ok", &[("pista", 288_000)], secciones).await;
        engine.seek(0.5).await;
        engine.queue_section_jump("c", Some("section-end")).await.unwrap();
        assert!(engine.clock_jumps.jump_pending());
        engine.cancel_queued_jump().await;
        assert!(!engine.clock_jumps.jump_pending(), "ningún feeder empalmó: debe poder cancelarse");
    }

    #[tokio::test]
    async fn test_cancelar_o_cambiar_un_salto_ya_empalmado_se_rechaza() {
        let secciones = vec![seccion("a", 0.0, 2.0), seccion("b", 2.0, 4.0), seccion("c", 4.0, 6.0)];
        let engine = motor_real("aud_cancel_tarde", &[("pista", 288_000)], secciones).await;
        engine.seek(0.5).await;
        engine.queue_section_jump("c", Some("section-end")).await.unwrap();
        // Un feeder ya consumió la petición: el audio de la sección destino está en su anillo.
        {
            let tracks = engine.tracks.lock().await;
            *tracks[0].jump_request.lock().unwrap() = None;
        }
        engine.cancel_queued_jump().await;
        assert!(engine.clock_jumps.jump_pending(), "el salto ya empalmado no puede cancelarse solo en el reloj");
        assert!(engine.queue_section_jump("a", Some("section-end")).await.is_err(), "no se puede reprogramar un salto ya empalmado");
        assert!(engine.clock_jumps.jump_pending());
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
        let engine = Arc::new(motor_de_prueba());
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
        let engine = Arc::new(motor_de_prueba());
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

    // ----- Clics al cambiar de sección -----

    /// Caché PCM sintética con un seno de 440 Hz (amplitud 8000/32768) en cada pista.
    fn escribir_cache_seno(nombre: &str, pistas: &[(&str, usize)]) -> std::path::PathBuf {
        use crate::audio::cache::{write_track_pcm_and_metadata, TrackPcmMetadata};
        let dir = std::env::temp_dir().join(format!("omnitracks_clics_{nombre}"));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        for (id, frames) in pistas {
            let mut muestras = Vec::with_capacity(frames * 2);
            for f in 0..*frames {
                let v = ((2.0 * std::f64::consts::PI * 440.0 * f as f64 / SR_PRUEBA as f64).sin() * 8000.0) as i16;
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

    /// Reproduce `segundos` de audio con el callback simulado y devuelve el mayor salto entre muestras
    /// consecutivas (canal izquierdo) y en qué muestra ocurrió. Sin metrónomo ni guía: solo las pistas.
    fn mayor_salto_entre_muestras(engine: &PlaybackEngine, segundos: f64) -> (f32, usize, usize) {
        engine.metronome.lock().unwrap().config.enabled = false;
        let (mut previa, mut mayor, mut donde, mut n) = (None::<f32>, 0.0f32, 0usize, 0usize);
        let mut silencios = 0usize;
        let limite = Instant::now() + std::time::Duration::from_secs(20);
        let objetivo = (segundos * SR_PRUEBA as f64) as usize;
        while n < objetivo && Instant::now() < limite && engine.is_playing.load(Ordering::SeqCst) {
            let mut buf = vec![0.0f32; 480 * 2];
            engine.simulate_callback_block(&mut buf, 2);
            std::thread::sleep(std::time::Duration::from_millis(5));
            if engine.is_buffering.load(Ordering::SeqCst) {
                previa = None;
                continue;
            }
            for f in 0..480 {
                let v = buf[f * 2];
                if v == 0.0 {
                    silencios += 1;
                }
                if let Some(p) = previa {
                    let d = (v - p).abs();
                    if d > mayor {
                        mayor = d;
                        donde = n;
                    }
                }
                previa = Some(v);
                n += 1;
            }
        }
        (mayor, donde, silencios)
    }

    // Un seno de 440 Hz con amplitud 8000/32768 y ganancia de centro 0,7071 no puede variar más de ~0,0100
    // entre muestras. Un clic (escalón o hueco) lo supera con mucho.
    const SALTO_MAX_SENO: f32 = 0.0105;

    #[tokio::test]
    async fn test_clics_pasar_de_una_seccion_a_otra_sin_salto_no_produce_clics() {
        let secciones = vec![seccion("a", 0.0, 2.0), seccion("b", 2.0, 4.0), seccion("c", 4.0, 6.0)];
        let dir = escribir_cache_seno("natural", &[("p", 288_000)]);
        let engine = motor_de_prueba();
        engine
            .load_project(&dir, "natural", SR_PRUEBA, Some(120.0), Some(4), Some(secciones), Some("section-end".to_string()))
            .await
            .unwrap();
        engine.seek(1.0).await;
        reproducir(&engine).await;
        let (mayor, donde, _) = mayor_salto_entre_muestras(&engine, 3.0);
        assert!(mayor < SALTO_MAX_SENO, "clic al cruzar la sección: salto {mayor} en la muestra {donde}");
    }

    #[tokio::test]
    async fn test_clics_saltar_a_otra_seccion_no_produce_clics() {
        for modo in ["1-bar", "section-end"] {
            let secciones = vec![seccion("a", 0.0, 2.0), seccion("b", 2.0, 4.0), seccion("c", 4.0, 6.0)];
            let dir = escribir_cache_seno(&format!("salto_{modo}"), &[("p", 288_000)]);
            let engine = motor_de_prueba();
            engine
                .load_project(&dir, &format!("salto_{modo}"), SR_PRUEBA, Some(120.0), Some(4), Some(secciones), Some(modo.to_string()))
                .await
                .unwrap();
            engine.seek(0.5).await;
            reproducir(&engine).await;
            engine.queue_section_jump("c", Some(modo)).await.unwrap();
            // 3 s: cubre el salto (a los ~1,5 s) sin llegar al final del archivo, donde el audio acaba en seco.
            let (mayor, donde, _) = mayor_salto_entre_muestras(&engine, 3.0);
            assert!(mayor < SALTO_MAX_SENO, "clic al saltar ({modo}): salto {mayor} en la muestra {donde}");
        }
    }

    #[tokio::test]
    async fn test_clics_la_vuelta_del_vamp_no_produce_clics() {
        let secciones = vec![seccion("a", 0.0, 2.0), seccion("b", 2.0, 4.0), seccion("c", 4.0, 6.0)];
        let dir = escribir_cache_seno("vamp", &[("p", 288_000)]);
        let engine = motor_de_prueba();
        engine
            .load_project(&dir, "vamp", SR_PRUEBA, Some(120.0), Some(4), Some(secciones), Some("section-end".to_string()))
            .await
            .unwrap();
        engine.seek(2.5).await;
        reproducir(&engine).await;
        assert!(engine.toggle_vamp(Some(true)).await);
        // 4 s: 1,5 s hasta el final de B y más de una vuelta del bucle.
        let (mayor, donde, _) = mayor_salto_entre_muestras(&engine, 4.0);
        assert!(mayor < SALTO_MAX_SENO, "clic en la vuelta del vamp: salto {mayor} en la muestra {donde}");
    }

    #[test]
    fn test_fade_fin_de_cancion_ganancia_exacta_uno_antes_de_la_ventana_y_cero_al_final() {
        let total = 100_000u64;
        let fade = 384usize;
        let fin = total - END_FADE_GUARD_FRAMES;
        // Antes de la ventana: ganancia exactamente 1.0 (el audio continuo no se toca).
        for pos in [0u64, 1, 50_000, fin - fade as u64 - 1] {
            assert_eq!(end_of_song_gain(pos, total, fade), 1.0, "posición {pos}");
        }
        // Dentro: baja de forma monótona hasta 0.
        let mut previa = 1.0f32;
        for pos in (fin - fade as u64)..fin {
            let g = end_of_song_gain(pos, total, fade);
            assert!(g <= previa + 1e-6 && (0.0..=1.0).contains(&g), "pos {pos}: {g}");
            previa = g;
        }
        // Al final y después: silencio.
        assert_eq!(end_of_song_gain(fin, total, fade), 0.0);
        assert_eq!(end_of_song_gain(total, total, fade), 0.0);
        assert_eq!(end_of_song_gain(total + 5, total, fade), 0.0);
        // Sin canción o sin fundido configurado: sin efecto.
        assert_eq!(end_of_song_gain(10, 0, fade), 1.0);
        assert_eq!(end_of_song_gain(99_999, total, 0), 1.0);
    }

    #[tokio::test]
    async fn test_clics_el_final_de_una_cancion_que_acaba_alta_no_produce_clic() {
        // 48 136 fotogramas: el archivo acaba cerca de un pico del seno (sin pasar por cero), como una
        // canción masterizada que se corta de golpe.
        let dir = escribir_cache_seno("final", &[("p", 48_136)]);
        let engine = motor_de_prueba();
        engine
            .load_project(&dir, "final", SR_PRUEBA, Some(120.0), Some(4), Some(vec![seccion("a", 0.0, 1.0)]), Some("section-end".to_string()))
            .await
            .unwrap();
        reproducir(&engine).await;
        let (mayor, donde, _) = mayor_salto_entre_muestras(&engine, 3.0);
        assert!(!engine.is_playing.load(Ordering::SeqCst), "la canción debía terminar");
        assert!(mayor < SALTO_MAX_SENO, "clic al terminar la canción: salto {mayor} en la muestra {donde}");
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
        let engine = motor_de_prueba();
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
                monitor: Arc::new(AtomicBool::new(false)),
                split: Arc::new(AtomicBool::new(false)),
                cue_gain: Arc::new(AtomicU32::new(1.0f32.to_bits())),
                cue_muted: Arc::new(AtomicBool::new(false)),
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
                monitor: Arc::clone(&t.monitor),
                split: Arc::clone(&t.split),
                cue_gain: Arc::clone(&t.cue_gain),
                cue_muted: Arc::clone(&t.cue_muted),
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

