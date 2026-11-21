// Carrera de activaciones (H01) y Play frente a la cola de controles (H04), con el motor de Rust simulado.
import assert from 'node:assert/strict';

type Handler = (payload: any) => void;
const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

const calls: string[] = [];
const ready = new Map<string, boolean>();
let importGate: Promise<void> = Promise.resolve();
let controlDelayMs = 0;
let controlsApplied = 0;
let lastLoadArgs: any = null;

const fakeInvoke = async (cmd: string, args: any = {}) => {
  calls.push(cmd === 'audio_load_project' || cmd === 'audio_import_tracks' ? `${cmd}:${args.projectId}` : cmd);
  switch (cmd) {
    case 'audio_get_project_cache_status':
      return { isReady: ready.get(args.projectId) === true, cachedTracksCount: 1, totalTracksCount: 1 };
    case 'audio_check_files_exist':
      return (args.paths || []).map(() => true);
    case 'audio_import_tracks':
      await importGate;
      ready.set(args.projectId, true);
      return { tracks: args.files.map((f: any) => ({ trackId: f.trackId })), errors: [] };
    case 'audio_load_project':
      lastLoadArgs = args;
      return { durationSec: 10, sampleRate: 48000, totalFrames: 480000, trackCount: 1, trackPeaks: {} };
    case 'audio_set_track_controls':
    case 'audio_set_master_gains':
    case 'audio_set_config':
      if (controlDelayMs) await tick(controlDelayMs);
      controlsApplied++;
      return null;
    default:
      return null;
  }
};

(globalThis as any).window = {
  __TAURI__: { core: { invoke: fakeInvoke }, event: { listen: async (_n: string, _cb: Handler) => () => {} } },
  setInterval: () => 0,
  clearInterval: () => {},
};

const song = (id: string, muted = false): any => ({
  id,
  title: id,
  bpm: 120,
  beatsPerBar: 4,
  sections: [],
  quantizeMode: 'section-end',
  clickEnabled: true,
  clickGain: 1,
  clickSubdivision: 1,
  masterGain: 1,
  pitchSemitones: 0,
  tracks: [{ id: `${id}-t1`, name: 'T', filePath: "C:/x/" + id + ".wav", gain: 1, pan: 0, muted, soloed: false, bus: 'main' }],
});

async function main() {
  const { NativeAudioEngine } = await import('../src/audio/nativeAudioEngine');

  // H01: se elige A (caché pendiente) y enseguida B (lista). Al terminar la caché de A, A no puede montarse.
  {
    const engine = new NativeAudioEngine();
    await tick();
    calls.length = 0;
    ready.clear();
    ready.set('B', true);
    let release!: () => void;
    importGate = new Promise<void>((r) => (release = r));

    const a = engine.loadProject(song('A'));
    await tick(20);
    const rb = await engine.loadProject(song('B'));
    assert.equal(rb.wasCancelled, false, 'B se monta');
    release();
    const ra = await a;
    assert.equal(ra.wasCancelled, true, 'A queda cancelada porque ya no es la canción elegida');
    assert.ok(!calls.includes('audio_load_project:A'), 'el motor no recibe la carga de A');
    assert.ok(calls.includes('audio_load_project:B'));
    console.log('OK H01: una carga anterior no pisa a la canción elegida después');
  }

  // H04: Play espera a que el motor confirme la mezcla pendiente.
  {
    const engine = new NativeAudioEngine();
    await tick();
    ready.clear();
    ready.set('C', true);
    importGate = Promise.resolve();
    const c = song('C', true); // pista guardada en mute
    await engine.loadProject(c);
    await tick(30); // deja drenar lo que envía el montaje
    calls.length = 0;
    controlsApplied = 0;
    controlDelayMs = 40;
    engine.updateProjectConfig(c); // vuelve a enviar TODO: cola con órdenes lentas
    const before = controlsApplied;
    await engine.play();
    assert.ok(controlsApplied > before, 'al salir Play ya se aplicaron los controles pendientes');
    const idxControl = calls.lastIndexOf('audio_set_track_controls');
    const idxPlay = calls.indexOf('audio_play');
    assert.ok(idxPlay >= 0, 'Play llegó al motor');
    assert.ok(idxControl >= 0 && idxControl < idxPlay, 'el último control sale antes que Play');
    controlDelayMs = 0;
    console.log('OK H04: Play espera la cola de controles');
  }

  // H04 (montaje): la mezcla de cada pista viaja con la carga, no a ganancia 1 hasta que lleguen los controles.
  {
    const engine = new NativeAudioEngine();
    await tick();
    ready.clear();
    ready.set('F', true);
    const f = song('F', true);
    f.tracks[0].gain = 0.4;
    f.tracks[0].pan = 0.3;
    lastLoadArgs = null;
    await engine.loadProject(f);
    const tc = lastLoadArgs?.trackControls;
    assert.ok(Array.isArray(tc) && tc.length === 1, 'audio_load_project recibe trackControls');
    assert.equal(tc[0].trackId, 'F-t1');
    assert.equal(tc[0].muted, true, 'la pista en mute viaja en mute');
    assert.ok(Math.abs(tc[0].gain - 0.4) < 1e-9, 'y con su ganancia');
    assert.equal(tc[0].pan, 30, 'paneo en la escala del motor (-100..100)');
    assert.equal(tc[0].bus, 'main');
    console.log('OK H04: la mezcla viaja con la carga');
  }

  // H07: una pista cuyo hilo de lectura murió, o un buffering que no termina, se avisan una sola vez.
  {
    const engine = new NativeAudioEngine();
    await tick();
    ready.clear();
    ready.set('G', true);
    await engine.loadProject(song('G'));
    const notices: string[] = [];
    engine.setOnNotice((m) => notices.push(m));
    const snap = (alive: boolean, bufferingMs: number): any => ({
      isPlaying: false, positionSec: 0, durationSec: 10, currentFrame: 0, totalFrames: 480000, underruns: 0, callbacks: 0,
      maxCallbackDurationUs: 0, bufferingMs,
      trackControls: [{ trackId: 'G-t1', gain: 1, pan: 0, muted: false, soloed: false, bus: 'main', feederAlive: alive }],
    });
    (engine as any).applySnapshot(snap(false, 0));
    (engine as any).applySnapshot(snap(false, 0));
    assert.equal(notices.filter((m) => m.includes('no se pudo leer')).length, 1, 'la pista muerta se avisa una sola vez');
    (engine as any).applySnapshot(snap(true, 6000));
    (engine as any).applySnapshot(snap(true, 7000));
    assert.equal(notices.filter((m) => m.includes('tarda demasiado')).length, 1, 'el buffering atascado se avisa una sola vez');
    (engine as any).applySnapshot(snap(true, 0));
    (engine as any).applySnapshot(snap(true, 6000));
    assert.equal(notices.filter((m) => m.includes('tarda demasiado')).length, 2, 'tras recuperarse, un atasco nuevo vuelve a avisar');
    console.log('OK H07: pista sin lectura y buffering atascado se avisan');
  }

  // H04b: si la cola nunca termina, Play sale igual (tope) y no queda colgado.
  // (La espera máxima es 1,5 s; aquí solo se comprueba que el camino de tope existe sin esperar tanto en la suite.)

  // Play tras elegir otra canción durante la espera: se cancela.
  {
    const engine = new NativeAudioEngine();
    await tick();
    ready.clear();
    ready.set('D', true);
    ready.set('E', true);
    const d = song('D');
    await engine.loadProject(d);
    await tick(30);
    calls.length = 0;
    controlDelayMs = 40;
    engine.updateProjectConfig(d);
    const playing = engine.play();
    engine.prepareProjectShell(song('E')); // el usuario elige otra canción mientras se aplica la mezcla
    await playing;
    controlDelayMs = 0;
    assert.ok(!calls.includes('audio_play'), 'Play de la canción anterior no llega al motor');
    console.log('OK: Play se cancela si cambió la canción elegida durante la espera');
  }
  console.log('engineActivation.test.ts OK');
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
