// Pruebas de los medidores de escritorio: balística pura y motor nativo sin simulación.

function assert(condition: boolean, msg: string) {
  if (!condition) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
}

const close = (a: number, b: number, tol = 1e-6) => Math.abs(a - b) <= tol;

// pcmReaderClient (importado por el motor) crea un Worker al cargarse: no existe en Node.
(globalThis as any).Worker = class {
  postMessage() {}
  terminate() {}
  addEventListener() {}
  removeEventListener() {}
  onmessage: unknown = null;
  onerror: unknown = null;
};
(globalThis as any).window = {
  __TAURI__: {
    core: { invoke: async () => null },
    event: { listen: async () => () => {} },
  },
  setInterval: () => 0,
  clearInterval: () => {},
};

const raw = (tracks: [string, number][], main = 0, clipped = false) => ({
  tracks: tracks.map(([trackId, v]) => ({ trackId, l: v, r: v * 0.5 })),
  main: { l: main, r: main },
  cue: { l: 0, r: 0 },
  out: { l: main, r: main },
  click: { l: 0.2, r: 0.2 },
  guide: { l: 0, r: 0 },
  clipped,
});

async function main() {
  const { MeterBallistics, CLIP_HOLD_MS } = await import('../src/audio/meterBallistics');
  const { NativeAudioEngine } = await import('../src/audio/nativeAudioEngine');
  console.log('=== PRUEBAS: medidores reales de escritorio ===');

  // 1. Transporte parado: todo a 0.
  const b = new MeterBallistics();
  b.update(raw([['a', 0.8]], 0.9), 0);
  const parado = b.snapshot(['a'], 0, false);
  assert(parado.tracks.a.peak === 0 && parado.master.peak === 0, 'parado -> 0');
  console.log('OK 1: con el transporte parado todo es 0');

  // 2. El valor llega tal cual (máximo de L y R) y una pista desconocida para el motor da 0.
  const s = b.snapshot(['a', 'otra'], 0, true);
  assert(close(s.tracks.a.peak, 0.8) && close(s.tracks.a.rms, 0.8), `pista a = 0,8 (fue ${s.tracks.a.peak})`);
  assert(s.tracks.otra.peak === 0, 'pista sin dato -> 0');
  assert(close(s.master.peak, 0.9), 'main real');
  assert(close(s.nativeBuses!.click.l, 0.2), 'click real');
  console.log('OK 2: valores reales y 0 para pistas sin dato');

  // 3. Caída: 20 dB/s -> a los 500 ms baja 10 dB (×0,316); nunca sube sin dato nuevo.
  const t500 = b.snapshot(['a'], 500, true).tracks.a.peak;
  assert(close(t500, 0.8 * Math.pow(10, -10 / 20), 1e-4), `caída a 500 ms (fue ${t500})`);
  const t600 = b.snapshot(['a'], 600, true).tracks.a.peak;
  assert(t600 < t500, 'sigue bajando sin dato nuevo');

  // 4. Un pico nuevo menor que el valor ya caído no lo hace bajar de golpe.
  b.update(raw([['a', 0.01]], 0), 600);
  assert(close(b.snapshot(['a'], 600, true).tracks.a.peak, t600, 1e-6), 'mantiene el mayor entre nuevo y caído');
  b.update(raw([['a', 0.7]], 0), 650);
  assert(close(b.snapshot(['a'], 650, true).tracks.a.peak, 0.7), 'un pico mayor sube al instante');
  console.log('OK 3-4: caída de 20 dB/s y subida instantánea');

  // 5. Pistas que mide el motor aunque la vista no las conozca (copia de proyecto desfasada).
  b.update(raw([['solo-motor', 0.5]], 0), 700);
  assert(close(b.snapshot([], 700, true).tracks['solo-motor'].peak, 0.5), 'incluye pistas medidas por el motor');
  console.log('OK 5: se incluyen las pistas que el motor está midiendo');

  // 6. Aviso de recorte: se mantiene CLIP_HOLD_MS y luego se apaga.
  b.update(raw([], 1.2, true), 1000);
  assert(b.snapshot([], 1000, true).master.clipping, 'recorte encendido');
  assert(b.snapshot([], 1000 + CLIP_HOLD_MS + 1, true).master.clipping === false, 'recorte se apaga tras el tiempo de retención');
  console.log('OK 6: aviso de recorte con retención');

  // 7. Motor nativo: sin datos del backend, sonando, no inventa niveles ni oscila con el reloj.
  const engine = new NativeAudioEngine();
  (engine as any).currentProject = { id: 'p', tracks: [{ id: 'stem-01' }, { id: 'stem-02' }] };
  (engine as any).currentTransport = { ...(engine as any).currentTransport, isPlaying: true };
  const lecturas: number[] = [];
  for (let i = 0; i < 5; i++) {
    const m = engine.getTrackMeters();
    lecturas.push(m.tracks['stem-01'].rms, m.tracks['stem-02'].rms, m.master.rms);
    await new Promise((r) => setTimeout(r, 30));
  }
  assert(lecturas.every((v) => v === 0), `sin datos reales todo es 0 (fue ${lecturas.join(',')})`);
  console.log('OK 7: el motor nativo ya no simula niveles');

  console.log('\nTODAS LAS PRUEBAS PASARON');
  process.exit(0);
}

main().catch((e) => {
  console.error('FAIL (excepción):', e);
  process.exit(1);
});
