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
  const songLabel = (song) => song ? song.title : '—';
  let state = {};
  let controls = [];
  let clock = null;
  let socket = null;
  let retryMs = 500;
  let connected = false;

  byId('title').textContent = canMix ? 'Mezclador' : 'Monitor';
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
    const song = state.currentSong;
    const beat = song ? Math.floor(current * song.bpm / 60) : 0;
    byId('bar').textContent = song ? (Math.floor(beat / song.beatsPerBar) + 1) + ' · ' + (beat % song.beatsPerBar + 1) : '—';
  }

  function send(command) {
    if (!connected || !state.acceptingCommands || socket?.readyState !== WebSocket.OPEN) return;
    if (socket.bufferedAmount > 1024) return;
    socket.send(JSON.stringify({ ...command, revision: state.revision }));
  }

  function newTrack(index) {
    const row = document.createElement('div');
    row.className = 'track';
    const label = document.createElement('label');
    const name = document.createElement('span');
    const slider = document.createElement('input');
    slider.type = 'range';
    slider.min = '0';
    slider.max = '1';
    slider.step = '0.01';
    const value = document.createElement('output');
    const mute = document.createElement('button');
    const control = { name, slider, value, mute, dragging: false };
    mute.type = 'button';
    mute.textContent = 'Mute';
    slider.addEventListener('pointerdown', () => { control.dragging = true; });
    slider.addEventListener('pointerup', () => { control.dragging = false; });
    slider.addEventListener('pointercancel', () => { control.dragging = false; });
    slider.addEventListener('blur', () => { control.dragging = false; });
    slider.addEventListener('input', () => { value.textContent = Math.round(Number(slider.value) * 100) + '%'; });
    slider.addEventListener('change', () => send({ type: 'setTrackGain', trackIndex: index, gain: Number(slider.value) }));
    mute.addEventListener('click', () => send({ type: 'setTrackMute', trackIndex: index, muted: !state.tracks[index].muted }));
    label.append(name, slider);
    row.append(label, value, mute);
    trackList.append(row);
    return control;
  }

  function renderTracks(rebuild) {
    if (!canMix) return;
    const tracks = state.tracks ?? [];
    if (rebuild || controls.length !== tracks.length) {
      trackList.replaceChildren();
      controls = tracks.map((_, index) => newTrack(index));
    }
    tracks.forEach((track, index) => {
      const { name, slider, value, mute, dragging } = controls[index];
      name.textContent = track.name;
      if (!dragging) {
        slider.value = String(Math.min(1, Math.max(0, track.gain)));
        value.textContent = Math.round(track.gain * 100) + '%';
      }
      mute.setAttribute('aria-label', 'Mute de ' + track.name);
      mute.setAttribute('aria-pressed', String(track.muted));
      slider.disabled = mute.disabled = !connected || !state.acceptingCommands;
    });
    if (!state.acceptingCommands) notice.textContent = 'Espera a que el portátil cargue una canción.';
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
      renderClock();
    }
    if ('currentSong' in changes || 'nextSong' in changes || 'setlist' in changes) {
      const song = state.currentSong;
      byId('song').textContent = song ? song.title : 'Sin canción cargada';
      byId('details').textContent = song ? song.key + ' · ' + song.bpm + ' BPM · ' + song.beatsPerBar + '/' + song.beatUnit : '';
      byId('next-song').textContent = songLabel(state.nextSong);
      byId('songs').replaceChildren(...state.setlist.map((entry) => {
        const item = document.createElement('li');
        item.textContent = entry.title + ' · ' + entry.key;
        if (entry.id === song?.id) item.setAttribute('aria-current', 'true');
        return item;
      }));
    }
    if ('currentSection' in changes || 'vamping' in changes) {
      byId('section').textContent = state.currentSection ? state.currentSection.name + (state.vamping ? ' · En bucle' : '') : '—';
    }
    if ('nextSection' in changes) byId('next-section').textContent = state.nextSection?.name || '—';
    if ('queuedJump' in changes) {
      const jump = state.queuedJump;
      byId('jump').textContent = jump ? jump.section.name + (jump.targetBar ? ' · Compás ' + jump.targetBar : '') : '—';
    }
    if ('tracks' in changes || 'acceptingCommands' in changes || 'revision' in changes) {
      notice.textContent = '';
      renderTracks('revision' in changes);
    }
    byId('performance').hidden = false;
    byId('mix').hidden = !canMix;
    byId('queue').hidden = false;
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
        connection.textContent = 'Conectado al portátil';
      };
      socket.onmessage = (event) => apply(JSON.parse(event.data));
      socket.onclose = (event) => {
        if (clock) clock = { ...clock, positionSec: position(), playing: false };
        connected = false;
        renderTracks(false);
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
