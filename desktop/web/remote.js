(() => {
  'use strict';

  const role = location.pathname === '/mezclador' ? 'mezclador' : 'monitor';
  const canMix = role === 'mezclador';
  const sessionUrl = '/session/' + role;
  const token = location.hash.slice(1);
  const byId = (id) => document.getElementById(id);
  const connection = byId('connection');
  const notice = byId('notice');
  const trackList = byId('tracks');
  const progress = byId('progress');
  const time = byId('time');
  const remaining = byId('remaining');
  const remainingProgress = byId('remaining-progress');
  const totalDuration = byId('duration');
  const songLabel = (song) => song ? song.title : '—';
  let state = {};
  let controls = [];
  let clock = null;
  let socket = null;
  let retryMs = 500;
  let connected = false;

  document.title = byId('title').textContent = canMix ? 'Mezclador' : 'Monitor';
  if (canMix) {
    const cues = byId('cues');
    const details = document.createElement('details');
    const summary = document.createElement('summary');
    summary.textContent = 'Detalles de reproducción';
    byId('live-beat').hidden = false;
    byId('performance').append(details);
    details.append(summary, cues);
  }
  if (token) history.replaceState(null, '', location.pathname);

  function mmss(seconds) {
    const safe = Math.max(0, Math.floor(seconds));
    return String(Math.floor(safe / 60)).padStart(2, '0') + ':' + String(safe % 60).padStart(2, '0');
  }

  function position() {
    if (!clock) return 0;
    const elapsed = connected && clock.playing ? (performance.now() - clock.receivedAt) / 1000 : 0;
    return Math.min(clock.durationSec, Math.max(0, clock.positionSec + elapsed * clock.rate));
  }

  function renderClock() {
    const duration = clock?.durationSec || 0;
    const current = position();
    progress.max = duration || 1;
    progress.value = current;
    time.textContent = mmss(current) + ' / ' + mmss(duration);
    if (canMix) {
      const song = state.currentSong;
      const beat = song ? Math.floor(current * song.bpm / 60) : 0;
      byId('bar').textContent = song ? (Math.floor(beat / song.beatsPerBar) + 1) + ' · ' + (beat % song.beatsPerBar + 1) : '—';
    } else {
      const left = Math.max(0, duration - current);
      const label = duration > 0 ? mmss(Math.ceil(left)) : '--:--';
      if (remaining.textContent !== label) remaining.textContent = label;
      remainingProgress.max = duration || 1;
      remainingProgress.value = left;
    }
  }

  function renderPlayState() {
    const icon = byId('play-state');
    if (!connected) {
      icon.textContent = '—';
      icon.setAttribute('aria-label', 'Sin conexión');
      return;
    }
    const playing = clock?.playing;
    icon.textContent = playing ? 'Ⅱ' : state.currentSong ? '▶' : '■';
    icon.setAttribute('aria-label', playing ? 'Reproduciendo' : state.currentSong ? 'Sin reproducción' : 'Sin canción');
  }

  function send(command) {
    if (!connected || !state.acceptingCommands || socket?.readyState !== WebSocket.OPEN) return;
    if (socket.bufferedAmount > 1024) return;
    socket.send(JSON.stringify({ ...command, revision: state.revision }));
  }

  const MIN_DB = -40;
  const MAX_DB = 10;
  const MUTE_TRAVEL = 0.04;

  function gainToDb(gain) {
    if (!Number.isFinite(gain) || gain <= 0) return -Infinity;
    return Math.round(200 * Math.log10(gain)) / 10;
  }

  function dbToGain(db) {
    if (!Number.isFinite(db)) return 0;
    const clamped = Math.max(MIN_DB, Math.min(MAX_DB, db));
    return Number((10 ** (clamped / 20)).toFixed(4));
  }

  function posFromDb(db) {
    if (!Number.isFinite(db)) return 0;
    const normalized = Math.max(0, Math.min(1, (db - MIN_DB) / (MAX_DB - MIN_DB)));
    return MUTE_TRAVEL + normalized * (1 - MUTE_TRAVEL);
  }

  function dbFromPos(pos) {
    if (pos < MUTE_TRAVEL) return -Infinity;
    return MIN_DB + (pos - MUTE_TRAVEL) / (1 - MUTE_TRAVEL) * (MAX_DB - MIN_DB);
  }

  function gainToPos(gain) {
    return Number(posFromDb(gainToDb(gain)).toFixed(3));
  }

  function posToGain(pos) {
    const db = dbFromPos(Math.max(0, Math.min(1, pos)));
    return !Number.isFinite(db) ? 0 : dbToGain(Math.round(db * 10) / 10);
  }

  function gainText(gain) {
    const db = gainToDb(gain);
    if (!Number.isFinite(db)) return ['−∞ dB', 'Silencio'];
    const decibels = (db > 0 ? '+' : '') + db.toFixed(1) + ' dB';
    return [decibels, decibels];
  }

  function newRange(index, kind, min, step, format, commit, toSlider = (v) => v, fromSlider = (v) => v) {
    const slider = document.createElement('input');
    slider.id = 'track-' + kind + '-' + index;
    slider.className = 'track-' + kind;
    slider.type = 'range';
    slider.min = String(min);
    slider.max = '1';
    slider.step = String(step);
    const value = document.createElement('output');
    value.setAttribute('for', slider.id);
    value.setAttribute('aria-live', 'off');
    const updateText = (next) => {
      const [visible, accessible] = format(next);
      value.textContent = visible;
      slider.setAttribute('aria-valuetext', accessible);
    };
    const control = {
      slider, value, dragging: false,
      update(next, label, disabled) {
        if (!control.dragging || disabled) {
          slider.value = String(toSlider(next));
          updateText(next);
        }
        slider.setAttribute('aria-label', label);
        slider.disabled = disabled;
      },
    };
    slider.addEventListener('pointerdown', () => { control.dragging = true; });
    for (const event of ['pointerup', 'pointercancel', 'blur']) {
      slider.addEventListener(event, () => { control.dragging = false; });
    }
    slider.addEventListener('input', () => updateText(fromSlider(Number(slider.value))));
    slider.addEventListener('change', () => commit(fromSlider(Number(slider.value))));
    return control;
  }

  function newGainFader(gain) {
    const { slider } = gain;
    const fader = document.createElement('div');
    fader.className = 'track-fader';
    const lane = document.createElement('div');
    lane.className = 'track-fader-lane';
    const thumb = document.createElement('span');
    thumb.className = 'track-fader-thumb';
    lane.setAttribute('aria-hidden', 'true');
    lane.append(thumb);
    fader.append(slider, lane);
    let drag = null;
    const sync = () => {
      if (slider.disabled && drag) {
        drag = null;
        gain.dragging = false;
      }
      lane.style.setProperty('--position', (Number(slider.value) * 100).toFixed(1) + '%');
    };
    slider.addEventListener('input', sync);
    thumb.addEventListener('pointerdown', (event) => {
      if (slider.disabled || event.button !== 0 || drag) return;
      const width = lane.getBoundingClientRect().width;
      if (!width) return;
      if (event.pointerType === 'mouse') slider.focus({ preventScroll: true });
      thumb.setPointerCapture(event.pointerId);
      drag = { id: event.pointerId, x: event.clientX, width, value: Number(slider.value), moved: false };
      gain.dragging = true;
    });
    thumb.addEventListener('pointermove', (event) => {
      if (drag?.id !== event.pointerId || slider.disabled) return;
      const distance = event.clientX - drag.x;
      if (!drag.moved && Math.abs(distance) < 5) return;
      drag.moved = true;
      const next = Math.max(0, Math.min(1, drag.value + distance / drag.width)).toFixed(3);
      if (Number(slider.value) === Number(next)) return;
      slider.value = next;
      slider.dispatchEvent(new Event('input'));
    });
    function end(event) {
      if (drag?.id !== event.pointerId) return;
      const changed = drag.moved && Number(slider.value) !== drag.value;
      gain.dragging = false;
      drag = null;
      if (event.type === 'pointerup' && changed && !slider.disabled) slider.dispatchEvent(new Event('change'));
      else renderTracks(false);
    }
    for (const event of ['pointerup', 'pointercancel', 'lostpointercapture']) thumb.addEventListener(event, end);
    return { fader, sync };
  }

  function panText(pan) {
    const amount = Math.round(Math.abs(pan) * 100) + '%';
    if (pan < 0) return ['L ' + amount, 'Izquierda ' + amount];
    if (pan > 0) return ['R ' + amount, 'Derecha ' + amount];
    return ['C', 'Centrado'];
  }

  function newTrack(index) {
    const row = document.createElement('div');
    row.className = 'track';
    const name = document.createElement('div');
    name.className = 'track-name';
    const gain = newRange(index, 'gain', 0, 0.001, gainText,
      (gain) => send({ type: 'setTrackGain', trackIndex: index, gain }), gainToPos, posToGain);
    const gainFader = newGainFader(gain);
    const pan = newRange(index, 'pan', -1, 0.01, panText,
      (pan) => send({ type: 'setTrackPan', trackIndex: index, pan }));
    const panToggle = document.createElement('button');
    panToggle.type = 'button';
    panToggle.className = 'track-pan-toggle';
    panToggle.append('Pan ', pan.value);
    panToggle.setAttribute('aria-controls', pan.slider.id);
    panToggle.setAttribute('aria-expanded', 'false');
    pan.slider.hidden = true;
    panToggle.addEventListener('click', () => {
      pan.slider.hidden = !pan.slider.hidden;
      panToggle.setAttribute('aria-expanded', String(!pan.slider.hidden));
    });
    const meter = document.createElement('meter');
    meter.className = 'track-meter';
    meter.max = 100;
    const buttons = document.createElement('div');
    buttons.className = 'track-buttons';
    const mute = document.createElement('button');
    const solo = document.createElement('button');
    mute.type = solo.type = 'button';
    mute.className = 'track-mute';
    solo.className = 'track-solo';
    mute.textContent = 'M';
    solo.textContent = 'S';
    mute.addEventListener('click', () => send({ type: 'setTrackMute', trackIndex: index, muted: !state.tracks[index].muted }));
    solo.addEventListener('click', () => send({ type: 'setTrackSolo', trackIndex: index, soloed: !state.tracks[index].soloed }));
    buttons.append(mute, solo);
    gain.value.className = 'track-level';
    const heading = document.createElement('div');
    heading.className = 'track-heading';
    heading.append(name, gain.value, panToggle, buttons);
    row.append(heading, gainFader.fader, meter, pan.slider);
    trackList.append(row);
    return { row, name, gain, gainFader, pan, panToggle, meter, mute, solo };
  }

  function renderTracks(rebuild) {
    if (!canMix) return;
    const tracks = state.tracks ?? [];
    if (rebuild || controls.length !== tracks.length) {
      trackList.replaceChildren();
      controls = tracks.map((_, index) => newTrack(index));
    }
    tracks.forEach((track, index) => {
      const { row, name, gain, gainFader, pan, panToggle, meter, mute, solo } = controls[index];
      name.textContent = track.name;
      row.style.setProperty('--track-color', /^#(?:[\da-f]{3}|[\da-f]{6})$/i.test(track.color) ? track.color : '');
      const disabled = !connected || !state.acceptingCommands;
      gain.update(track.gain, 'Volumen de ' + track.name, disabled);
      gainFader.sync();
      pan.update(track.pan ?? 0, 'Paneo de ' + track.name, disabled);
      panToggle.setAttribute('aria-label', 'Paneo de ' + track.name + ', ' + panText(track.pan ?? 0)[1]);
      meter.setAttribute('aria-label', 'Nivel de señal de ' + track.name);
      mute.setAttribute('aria-label', 'Mute de ' + track.name);
      mute.setAttribute('aria-pressed', String(track.muted));
      solo.setAttribute('aria-label', 'Solo de ' + track.name);
      solo.setAttribute('aria-pressed', String(Boolean(track.soloed)));
      mute.disabled = solo.disabled = panToggle.disabled = disabled;
    });
    if (!state.acceptingCommands) notice.textContent = 'Espera a que el portátil cargue una canción.';
  }

  function renderMeters() {
    controls.forEach(({ meter }, index) => {
      meter.value = connected ? state.levels?.[index] ?? 0 : 0;
    });
  }

  function apply(message) {
    if (message.type === 'rejected') {
      notice.textContent = 'El portátil no aceptó el ajuste. Inténtalo de nuevo.';
      return;
    }
    if (message.type !== 'snapshot' && message.type !== 'delta') return;
    const changes = message.state;
    state = message.type === 'snapshot' ? changes : { ...state, ...changes };
    if ('clock' in changes) {
      const anchor = state.clock;
      // Both timestamps come from the laptop. Interpolation uses the phone's monotonic clock.
      const transit = Math.max(0, message.sentAtMs - anchor.sampledAtMs) / 1000;
      clock = { ...anchor, receivedAt: performance.now(), positionSec: anchor.positionSec + transit * anchor.rate };
      if (!canMix) {
        totalDuration.textContent = 'Duración total ' + (clock.durationSec > 0 ? mmss(clock.durationSec) : '--:--');
      }
      renderClock();
    }
    if ('currentSong' in changes || 'nextSong' in changes || 'setlist' in changes) {
      const song = state.currentSong;
      byId('song').textContent = song ? song.title : 'Sin canción cargada';
      byId('details').textContent = song
        ? song.key + ' · ' + song.bpm + ' BPM' + (canMix ? ' · ' + song.beatsPerBar + '/' + song.beatUnit : '') : '';
      byId('next-song').textContent = songLabel(state.nextSong);
      const currentIndex = state.setlist.findIndex((entry) => entry.id === song?.id);
      byId('songs').replaceChildren(...state.setlist.map((entry, index) => {
        const item = document.createElement('li');
        const songInfo = document.createElement('div');
        const title = document.createElement('span');
        const key = document.createElement('span');
        title.textContent = entry.title;
        key.textContent = entry.key;
        key.className = 'song-key';
        const meta = document.createElement('div');
        meta.className = 'song-meta';
        meta.append(key);
        const cue = index === currentIndex ? 'Actual'
          : index === currentIndex + 1 && entry.id === state.nextSong?.id ? 'Sigue' : '';
        if (cue) {
          const status = document.createElement('span');
          status.className = 'song-status';
          status.textContent = cue;
          meta.append(status);
        }
        songInfo.append(title, meta);
        item.append(songInfo);
        if (index === currentIndex) item.setAttribute('aria-current', 'true');
        return item;
      }));
    }
    if ('currentSection' in changes || 'vamping' in changes) {
      byId('section').textContent = state.currentSection ? state.currentSection.name + (state.vamping ? ' · En bucle' : '') : '—';
    }
    if ('nextSection' in changes) byId('next-section').textContent = state.nextSection?.name || '—';
    if ('queuedJump' in changes) {
      const jump = state.queuedJump;
      byId('jump').textContent = jump ? jump.section.name + (canMix && jump.targetBar ? ' · Compás ' + jump.targetBar : '') : '—';
    }
    if ('tracks' in changes || 'acceptingCommands' in changes || 'revision' in changes) {
      notice.textContent = '';
      renderTracks('revision' in changes);
    }
    if ('levels' in changes || 'tracks' in changes || 'revision' in changes) renderMeters();
    byId('performance').hidden = false;
    byId('monitor').hidden = canMix;
    byId('mix').hidden = !canMix;
    byId('queue').hidden = false;
    if ('clock' in changes || 'currentSong' in changes) renderPlayState();
  }

  async function connect() {
    try {
      const session = await fetch(sessionUrl, { cache: 'no-store' });
      if (session.status === 401 || session.status === 403) {
        connection.textContent = 'Sesión terminada. Escanea el QR del portátil.';
        return;
      }
      if (!session.ok) throw new Error('session unavailable');
      socket = new WebSocket('ws://' + location.host + '/ws/' + role);
      socket.onopen = () => {
        connected = true;
        retryMs = 500;
        connection.textContent = '';
      };
      socket.onmessage = (event) => apply(JSON.parse(event.data));
      socket.onclose = (event) => {
        if (clock) clock = { ...clock, positionSec: position(), playing: false };
        connected = false;
        renderPlayState();
        renderTracks(false);
        renderMeters();
        if (event.code === 4403 || event.code === 1008) {
          connection.textContent = 'Sesión cerrada por el portátil. Escanea el QR para entrar.';
        } else {
          retry();
        }
      };
    } catch {
      retry();
    }
  }

  function retry() {
    connection.textContent = 'Sin conexión. Intentando reconectar…';
    setTimeout(connect, retryMs);
    retryMs = Math.min(8000, retryMs * 2);
  }

  async function start() {
    try {
      if (token) {
        const response = await fetch(sessionUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token }),
          cache: 'no-store',
        });
        if (response.status === 503) {
          connection.textContent = 'El portátil no admite más dispositivos en este momento. Libera un cupo y vuelve a abrir el QR.';
          return;
        }
        if (!response.ok) throw new Error('pairing failed');
      }
      await connect();
      setInterval(renderClock, 200);
    } catch {
      connection.textContent = 'No se pudo abrir la sesión. Escanea el QR vigente.';
    }
  }

  void start();
})();
