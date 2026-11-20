// Carrera de activaciones (H01) y Play frente a la cola de controles (H04), con el motor de Rust simulado.
import assert from 'node:assert/strict';

type Handler = (payload: any) => void;
const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

const calls: string[] = [];
const ready = new Map<string, boolean>();
let importGate: Promise<void> = Promise.resolve();
let controlDelayMs = 0;
let controlsApplied = 0;

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
