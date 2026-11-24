// Pruebas de la cola ordenada, la sincronización por diferencias y la autocorrección de los controles de la mezcla.
import { ControlQueue } from '../src/audio/controlQueue';
import {
  ControlSync,
  CONFIRM_POLLS,
  MAX_RESYNC_PER_WINDOW,
  RESYNC_WINDOW_MS,
  SETTLE_MS,
  desiredTrack,
  diffProjectControls,
  findTrackMismatches,
  isContinuousOnly,
  type EngineTrackControl,
} from '../src/audio/controlSync';
import { FlightRecorder } from '../src/utils/flightRecorder';
import { SaveScheduler } from '../src/storage/saveScheduler';
import { createPadOnlySong } from '../src/utils/padSong';
import type { SongProject } from '../src/types/project';

function assert(condition: boolean, msg: string) {
  if (!condition) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
}
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Generador pseudoaleatorio determinista. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeProject(n = 6): SongProject {
  const roles = ['bass', 'drums', 'keys', 'guitar', 'click', 'guide'] as const;
  const names = ['Bajo', 'Batería', 'Teclado', 'Guitarra eléctrica', 'Click', 'Guía'];
  return {
    id: 'p1',
    title: 'Prueba',
    bpm: 120,
    beatsPerBar: 4,
    quantizeMode: 'section-end',
    clickEnabled: false,
    clickGain: 1,
    clickSubdivision: 1,
    masterGain: 1,
    cueMasterGain: 0.708,
    pitchSemitones: 0,
    sections: [],
    tracks: Array.from({ length: n }, (_, i) => ({
      id: `t${i}`,
      name: names[i % names.length],
      role: roles[i % roles.length],
      color: '#fff',
      gain: 1,
      pan: 0,
      muted: false,
      soloed: false,
      bus: 'main',
      peaks: [],
    })),
  } as unknown as SongProject;
}

/** Motor simulado: aplica las órdenes con una latencia aleatoria, como las tareas independientes de Tauri. */
class FakeEngine {
  tracks = new Map<string, { gain: number; pan: number; muted: boolean; soloed: boolean; bus: string; monitor: boolean }>();
  master = { masterGain: 1, cueMasterGain: 0.708, monitorGain: 1 };
  pitch = 0;
  calls: string[] = [];
  /** Si es `true`, ignora las órdenes de pista (simula un motor que no obedece). */
  deaf = false;
  constructor(private readonly maxDelay: number, private readonly random: () => number) {}

  invoke = async (cmd: string, args?: Record<string, unknown>): Promise<void> => {
    this.calls.push(cmd);
    if (this.maxDelay > 0) await sleep(Math.floor(this.random() * this.maxDelay));
    const a = args ?? {};
    if (cmd === 'audio_set_track_controls' && !this.deaf) {
      const t = this.tracks.get(a.trackId as string) ?? { gain: 1, pan: 0, muted: false, soloed: false, bus: 'main', monitor: false };
      for (const k of ['gain', 'pan', 'muted', 'soloed', 'bus', 'monitor'] as const) if (k in a) (t as Record<string, unknown>)[k] = a[k];
      this.tracks.set(a.trackId as string, t);
    } else if (cmd === 'audio_set_master_gains') {
      if ('masterGain' in a) this.master.masterGain = a.masterGain as number;
      if ('cueMasterGain' in a) this.master.cueMasterGain = a.cueMasterGain as number;
      if ('monitorGain' in a) this.master.monitorGain = a.monitorGain as number;
    } else if (cmd === 'audio_set_pitch') {
      this.pitch = a.semitones as number;
    }
  };

  report(): EngineTrackControl[] {
    return [...this.tracks.entries()].map(([trackId, t]) => ({ trackId, ...t }));
  }
}

function matches(engine: FakeEngine, p: SongProject): boolean {
  if (engine.master.masterGain !== p.masterGain || engine.master.cueMasterGain !== p.cueMasterGain || engine.master.monitorGain !== (p.monitorGain ?? 1) || engine.pitch !== p.pitchSemitones) return false;
  return p.tracks.every((t) => {
    const d = desiredTrack(t);
    const e = engine.tracks.get(t.id);
    return !!e && Math.abs(e.gain - d.gain) < 1e-9 && e.pan === d.pan && e.muted === d.muted && e.soloed === d.soloed && e.bus === d.bus && e.monitor === d.monitor;
  });
}

/** Cambio aleatorio de la mezcla (lo que hace un operador con los dedos). */
function randomChange(p: SongProject, random: () => number): SongProject {
  const next = { ...p, tracks: p.tracks.map((t) => ({ ...t })) } as SongProject;
  const i = Math.floor(random() * next.tracks.length);
  const t = next.tracks[i];
  const r = random();
  if (r < 0.3) t.soloed = !t.soloed;
  else if (r < 0.4) t.monitor = !t.monitor;
  else if (r < 0.5) t.muted = !t.muted;
  else if (r < 0.75) t.gain = Math.round(random() * 200) / 100;
  else if (r < 0.9) t.pan = Math.round((random() * 2 - 1) * 100) / 100;
  else if (r < 0.95) next.masterGain = Math.round(random() * 150) / 100;
  else next.pitchSemitones = Math.floor(random() * 13) - 6;
  return next;
}

async function main() {
  // ------------------------------------------------------------------ cola: orden y fusión
  {
    const seen: string[] = [];
    const rnd = rng(1);
    const q = new ControlQueue(
      () => async (cmd, args) => {
        await sleep(Math.floor(rnd() * 4));
        seen.push(`${cmd}:${JSON.stringify(args)}`);
      },
      () => {}
    );
    q.enqueue({ key: 'a', cmd: 'x', args: { v: 1 } });
    q.enqueue({ key: 'b', cmd: 'y', args: { v: 2 } });
    q.enqueue({ key: 'a', cmd: 'x', args: { w: 3 } }); // se fusiona con la pendiente de «a»
    await q.idle();
    assert(seen.length === 3 || seen.length === 2, 'la cola procesa lo encolado');
    assert(q.isIdle(), 'la cola queda en reposo');
    // La primera orden ya estaba en vuelo cuando llegó la tercera (no se fusiona con una en vuelo): lo importante es el orden
    assert(seen[0].startsWith('x:'), 'sale primero lo primero que se pidió');
  }
  {
    const seen: number[] = [];
    const q = new ControlQueue(
      () => async (_c, args) => {
        await sleep(2);
        seen.push(args!.v as number);
      },
      () => {}
    );
    for (let i = 0; i < 50; i++) q.enqueue({ key: 'fader', cmd: 'x', args: { v: i } });
    await q.idle();
    assert(seen[seen.length - 1] === 49, 'al arrastrar un fader solo importa el último valor');
    assert(seen.length <= 3, `se fusionan los valores intermedios (${seen.length} envíos en vez de 50)`);
  }
  {
    const errors: string[] = [];
    const done: string[] = [];
    const q = new ControlQueue(
      () => async (cmd) => {
        if (cmd === 'malo') throw new Error('falla');
        done.push(cmd);
      },
      (op) => errors.push(op.cmd)
    );
    q.enqueue({ key: '1', cmd: 'bueno1', args: {} });
    q.enqueue({ key: '2', cmd: 'malo', args: {} });
    q.enqueue({ key: '3', cmd: 'bueno2', args: {} });
    await q.idle();
    assert(errors.join() === 'malo', 'el fallo se informa');
    assert(done.join() === 'bueno1,bueno2', 'un fallo no detiene el resto de la cola');
  }

  // ------------------------------------------------------------------ diferencias: solo lo que cambió
  {
    const p = makeProject();
    const todo = diffProjectControls(null, p);
    assert(todo.filter((o) => o.key.startsWith('track:')).length === p.tracks.length, 'carga completa: una orden por pista');
    assert(todo.some((o) => o.key === 'song') && todo.some((o) => o.key === 'metronome') && todo.some((o) => o.key === 'master') && todo.some((o) => o.key === 'pitch'), 'carga completa: también la cabecera');

    const solo = { ...p, tracks: p.tracks.map((t, i) => (i === 2 ? { ...t, soloed: true } : t)) } as SongProject;
    const ops = diffProjectControls(p, solo);
    assert(ops.length === 1 && ops[0].key === 'track:t2', 'un solo cambio genera una sola orden, no 17');
    assert(JSON.stringify(ops[0].args) === JSON.stringify({ trackId: 't2', soloed: true }), 'la orden lleva solo el campo cambiado');
    assert(diffProjectControls(p, p).length === 0, 'sin cambios no se envía nada');
    assert(isContinuousOnly(diffProjectControls(p, { ...p, tracks: p.tracks.map((t, i) => (i === 0 ? { ...t, gain: 0.5 } : t)) } as SongProject)), 'un fader es un cambio continuo');
    assert(!isContinuousOnly(ops), 'un solo no es continuo: se guarda al momento');
  }

  // ------------------------------------------------------------------ contrato con el motor (lo que verify:ipc no puede ver: argumentos armados con claves dinámicas)
  {
    const project = makeProject();
    project.tracks[0].pan = 0.35; // el pan decimal de la interfaz debe llegar como entero
    project.tracks[1].pan = -1;
    const allowed: Record<string, string[]> = {
      audio_set_track_controls: ['trackId', 'gain', 'pan', 'muted', 'soloed', 'bus', 'monitor', 'splitSequence', 'cueGain', 'cueMuted'],
      audio_set_master_gains: ['masterGain', 'cueMasterGain', 'monitorGain'],
      audio_set_pitch: ['semitones'],
      audio_set_metronome: ['config'],
      audio_configure_song: ['bpm', 'beatsPerBar', 'sections', 'quantizeMode'],
    };
    for (const op of diffProjectControls(null, project)) {
      assert(op.cmd in allowed, `comando desconocido: ${op.cmd}`);
      for (const k of Object.keys(op.args)) assert(allowed[op.cmd].includes(k), `${op.cmd}: argumento «${k}» que el motor no tiene`);
      if (op.cmd === 'audio_set_track_controls') {
        const a = op.args as { pan?: number; bus?: string; gain?: number; trackId?: string };
        assert(typeof a.trackId === 'string', 'la orden de pista lleva trackId');
        assert(Number.isInteger(a.pan) && a.pan! >= -100 && a.pan! <= 100, `el pan debe llegar como entero -100..100: ${a.pan}`);
        assert(['main', 'click', 'guide'].includes(a.bus as string), `bus válido: ${a.bus}`);
      }
    }
    const t0 = diffProjectControls(null, project).find((o) => o.key === 'track:t0')!;
    assert((t0.args as { pan: number }).pan === 35, 'pan 0,35 → 35');
    const t1 = diffProjectControls(null, project).find((o) => o.key === 'track:t1')!;
    assert((t1.args as { pan: number }).pan === -100, 'pan -1 → -100');
    // El click y la guía llegan al motor con su propio bus para poder sacarlos por salidas distintas
    const buses = new Map(diffProjectControls(null, project).filter((o) => o.key.startsWith('track:')).map((o) => [o.key, (o.args as { bus: string }).bus]));
    assert(buses.get('track:t4') === 'click' && buses.get('track:t5') === 'guide' && buses.get('track:t0') === 'main', 'bus por tipo de pista');
  }

  // ------------------------------------------------------------------ Monitor («Aur.»)
  {
    const p = makeProject();
    const marcado = { ...p, tracks: p.tracks.map((t, i) => (i === 2 ? { ...t, monitor: true } : t)) } as SongProject;
    const ops = diffProjectControls(p, marcado);
    assert(ops.length === 1 && JSON.stringify(ops[0].args) === JSON.stringify({ trackId: 't2', monitor: true }), 'marcar «Aur.» envía solo ese campo de esa pista');
    assert(!isContinuousOnly(ops), 'marcar «Aur.» se guarda al momento');
    const vol = diffProjectControls(p, { ...p, monitorGain: 0.4 } as SongProject);
    assert(vol.length === 1 && vol[0].key === 'master' && (vol[0].args as { monitorGain: number }).monitorGain === 0.4, 'el volumen del monitor va por las ganancias maestras');
    assert(isContinuousOnly(vol), 'mover el volumen del monitor es un cambio continuo');
    // La autocorrección también vigila el monitor: un envío que quedó puesto (o quitado) en el motor se corrige
    const engine = new FakeEngine(0, rng(11));
    let clock = 5_000;
    const sync = new ControlSync({ getInvoke: () => engine.invoke, onError: () => {}, recorder: new FlightRecorder(50), now: () => clock });
    sync.syncAll(marcado);
    await sync.queue.idle();
    assert(engine.tracks.get('t2')!.monitor === true, 'el motor recibe el envío a auriculares');
    engine.tracks.get('t2')!.monitor = false;
    clock += SETTLE_MS + 1;
    const snap = () => ({ trackControls: engine.report(), monitorGain: 1 });
    sync.reconcile(snap(), marcado);
    sync.reconcile(snap(), marcado);
    await sync.queue.idle();
    assert(engine.tracks.get('t2')!.monitor === true, 'si el motor pierde un «Aur.», se corrige solo');
  }

  // ------------------------------------------------------------------ Secuencia dividida
  {
    const p = makeProject();
    const sec = { ...p, tracks: p.tracks.map((t, i) => (i === 1 ? { ...t, splitSequence: true } : t)) } as SongProject;
    const ops = diffProjectControls(p, sec);
    assert(ops.length === 1 && JSON.stringify(ops[0].args) === JSON.stringify({ trackId: 't1', splitSequence: true }), 'marcar la secuencia envía solo ese campo');
    const vol = diffProjectControls(sec, { ...sec, tracks: sec.tracks.map((t, i) => (i === 1 ? { ...t, cueGain: 0.5 } : t)) } as SongProject);
    assert(vol.length === 1 && (vol[0].args as { cueGain: number }).cueGain === 0.5, 'el fader Click de la secuencia envía cueGain');
    assert(isContinuousOnly(vol), 'mover el fader Click de la secuencia es un cambio continuo');
    const mute = diffProjectControls(sec, { ...sec, tracks: sec.tracks.map((t, i) => (i === 1 ? { ...t, cueMuted: true } : t)) } as SongProject);
    assert(mute.length === 1 && (mute[0].args as { cueMuted: boolean }).cueMuted === true && !isContinuousOnly(mute), 'el mute del click se guarda al momento');
    const todo = diffProjectControls(null, sec).find((o) => o.key === 'track:t1')!;
    assert((todo.args as { splitSequence: boolean }).splitSequence === true && (todo.args as { cueGain: number }).cueGain === 1, 'la carga completa incluye la secuencia y su volumen de click');
  }

  // ------------------------------------------------------------------ modelo aleatorio: con la cola, el motor siempre termina igual que la interfaz
  {
    let fallos = 0;
    for (let seed = 1; seed <= 60; seed++) {
      const random = rng(seed);
      const engine = new FakeEngine(4, rng(seed + 1000));
      const sync = new ControlSync({ getInvoke: () => engine.invoke, onError: () => {}, recorder: new FlightRecorder(50) });
      let project = makeProject();
      sync.syncAll(project);
      for (let step = 0; step < 150; step++) {
        const next = randomChange(project, random);
        sync.applyChange(project, next);
        project = next;
        if (random() < 0.15) await sleep(1);
      }
      await sync.queue.idle();
      if (!matches(engine, project)) fallos++;
    }
    assert(fallos === 0, `con la cola, el motor debe terminar igual que la interfaz (fallos: ${fallos} de 60 secuencias)`);
  }

  // ------------------------------------------------------------------ control: sin la cola, las órdenes concurrentes SÍ terminan desordenadas
  {
    let fallos = 0;
    for (let seed = 1; seed <= 60; seed++) {
      const random = rng(seed);
      const engine = new FakeEngine(4, rng(seed + 1000));
      let project = makeProject();
      const pending: Promise<void>[] = [];
      for (const op of diffProjectControls(null, project)) pending.push(engine.invoke(op.cmd, op.args));
      for (let step = 0; step < 150; step++) {
        const next = randomChange(project, random);
        for (const op of diffProjectControls(project, next)) pending.push(engine.invoke(op.cmd, op.args)); // todas a la vez, como antes
        project = next;
      }
      await Promise.all(pending);
      if (!matches(engine, project)) fallos++;
    }
    assert(fallos > 0, 'la prueba debe poder detectar el problema: sin cola se esperan secuencias desordenadas');
  }

  // ------------------------------------------------------------------ autocorrección
  {
    const recorder = new FlightRecorder(200);
    const engine = new FakeEngine(0, rng(5));
    let clock = 10_000;
    const sync = new ControlSync({ getInvoke: () => engine.invoke, onError: () => {}, recorder, now: () => clock });
    const project = makeProject();
    sync.syncAll(project);
    await sync.queue.idle();
    clock += SETTLE_MS + 1;

    assert(sync.reconcile({ trackControls: engine.report(), masterGain: 1, cueMasterGain: 0.708, pitchSemitones: 0 }, project).length === 0, 'sin diferencias no se corrige nada');

    // Un solo que quedó puesto en el motor aunque la interfaz no lo tiene (el fallo fantasma)
    engine.tracks.get('t2')!.soloed = true;
    engine.tracks.get('t0')!.gain = 0.3;
    const snapshot = () => ({ trackControls: engine.report(), masterGain: 1, cueMasterGain: 0.708, pitchSemitones: 0 });

    assert(sync.reconcile(snapshot(), project).length === 0, `la primera vez no se corrige (hay que confirmar en ${CONFIRM_POLLS} sondeos)`);
    const corrected = sync.reconcile(snapshot(), project);
    assert(corrected.includes('track:t2') && corrected.includes('track:t0'), `se corrige al confirmar: ${corrected.join()}`);
    await sync.queue.idle();
    assert(matches(engine, project), 'el motor vuelve a coincidir con la interfaz');
    assert(recorder.lastMismatch() === null || typeof recorder.lastMismatch()?.summary === 'string', 'la discrepancia queda anotada');
    assert(recorder.all().some((e) => e.kind === 'discrepancia' && e.detail.includes('t2')), 'la caja negra registra qué pista y qué valores');
  }
  {
    // Con una orden en vuelo (o recién enviada) no se compara: el motor aún está aplicando
    const engine = new FakeEngine(0, rng(6));
    let clock = 50_000;
    const sync = new ControlSync({ getInvoke: () => engine.invoke, onError: () => {}, recorder: new FlightRecorder(50), now: () => clock });
    const project = makeProject();
    sync.syncAll(project);
    await sync.queue.idle();
    engine.tracks.get('t1')!.muted = true;
    const snap = () => ({ trackControls: engine.report() });
    clock += 10; // menos que SETTLE_MS desde el último envío
    sync.reconcile(snap(), project);
    sync.reconcile(snap(), project);
    assert(engine.tracks.get('t1')!.muted === true, 'justo después de enviar no se corrige (podría ser una orden en camino)');
    clock += SETTLE_MS + 1;
    sync.reconcile(snap(), project);
    sync.reconcile(snap(), project);
    await sync.queue.idle();
    assert(engine.tracks.get('t1')!.muted === false, 'pasado el margen sí se corrige');
  }
  {
    // Un motor que no obedece: se insiste unas pocas veces y se deja de insistir (sin bucles)
    const recorder = new FlightRecorder(200);
    const engine = new FakeEngine(0, rng(7));
    let clock = 90_000;
    const sync = new ControlSync({ getInvoke: () => engine.invoke, onError: () => {}, recorder, now: () => clock });
    const project = makeProject();
    sync.syncAll(project);
    await sync.queue.idle();
    engine.deaf = true;
    engine.tracks.get('t3')!.soloed = true;
    const before = engine.calls.length;
    for (let i = 0; i < 40; i++) {
      clock += SETTLE_MS + 1;
      sync.reconcile({ trackControls: engine.report() }, project);
      await sync.queue.idle();
    }
    const resends = engine.calls.length - before;
    assert(resends <= MAX_RESYNC_PER_WINDOW, `no insiste sin límite (${resends} reenvíos en ${40 * (SETTLE_MS + 1)} ms; ventana ${RESYNC_WINDOW_MS} ms)`);
    assert(recorder.all().some((e) => e.detail.includes('NO se pudo corregir')), 'anota que no logró corregirlo');
  }
  {
    // IDs repetidos: no son direccionables, no se intenta corregirlos
    const d = [desiredTrack({ ...makeProject().tracks[0], id: 'x' }), desiredTrack({ ...makeProject().tracks[1], id: 'x', soloed: true })];
    const a: EngineTrackControl[] = [{ trackId: 'x', gain: 1, pan: 0, muted: false, soloed: false, bus: 'main' }];
    assert(findTrackMismatches(d, a).length === 0, 'IDs duplicados se ignoran en la comparación');
  }

  // ------------------------------------------------------------------ guardado con retraso
  {
    const saved: string[] = [];
    const timers: Array<{ fn: () => void; ms: number; id: number; cleared: boolean }> = [];
    const fakeSet = ((fn: () => void, ms: number) => {
      const t = { fn, ms, id: timers.length, cleared: false };
      timers.push(t);
      return t.id as unknown as ReturnType<typeof setTimeout>;
    }) as unknown as typeof setTimeout;
    const fakeClear = ((id: number) => {
      if (timers[id]) timers[id].cleared = true;
    }) as unknown as typeof clearTimeout;
    const s = new SaveScheduler<{ id: string; v: number }>(async (it) => void saved.push(`${it.id}:${it.v}`), () => {}, 400, fakeSet, fakeClear);
    for (let v = 1; v <= 5; v++) s.schedule({ id: 'a', v });
    s.schedule({ id: 'b', v: 1 });
    assert(timers.filter((t) => !t.cleared).length === 2, 'cinco cambios de la misma canción dejan un solo guardado pendiente');
    timers.filter((t) => !t.cleared).forEach((t) => t.fn());
    await sleep(1);
    assert(saved.join() === 'a:5,b:1', `solo se guarda el último valor de cada canción: ${saved.join()}`);

    saved.length = 0;
    s.schedule({ id: 'a', v: 10 });
    await s.saveNow({ id: 'a', v: 11 });
    assert(saved.join() === 'a:11', 'un cambio no continuo guarda al momento y descarta lo pendiente');
    assert(!s.hasPending(), 'no queda nada pendiente');

    saved.length = 0;
    s.schedule({ id: 'a', v: 20 });
    s.schedule({ id: 'b', v: 21 });
    await s.flushAll();
    assert(saved.sort().join() === 'a:20,b:21' && !s.hasPending(), 'flushAll guarda todo lo pendiente');
  }

  // ------------------------------------------------------------------ caja negra
  {
    const store = new Map<string, string>();
    const r = new FlightRecorder(5, () => 0, { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => void store.set(k, v) });
    for (let i = 0; i < 12; i++) r.record('x', `evento ${i}`);
    assert(r.all().length === 5 && r.all()[0].detail === 'evento 7', 'el registro es circular: conserva los últimos');
    r.rememberMismatch('prueba');
    assert(r.lastMismatch()?.summary === 'prueba', 'la última discrepancia se guarda');
    const rep = r.report({ canción: 'p1' });
    assert(rep.includes('canción: p1') && rep.includes('Última discrepancia') && rep.includes('discrepancia: prueba'), 'el informe incluye contexto y discrepancia');
  }

  // ------------------------------------------------------------------ modo sin secuencia (pad)
  {
    const padA = createPadOnlySong({ id: 'pad-1', title: 'Adoración', keySignature: 'G', bpm: 72, clickSubdivision: 2 });
    const initialOps = diffProjectControls(null, padA);
    assert(initialOps.some((o) => o.cmd === 'audio_set_pad' && (o.args.config as any).note === 7), 'carga inicial envía audio_set_pad con nota G');

    const padGain = { ...padA, padGain: 0.45 };
    const gainOps = diffProjectControls(padA, padGain);
    assert(gainOps.length === 1 && gainOps[0].cmd === 'audio_set_pad' && isContinuousOnly(gainOps), 'mover fader del pad es continuo');

    const padNote = { ...padA, keySignature: 'D' };
    const noteOps = diffProjectControls(padA, padNote);
    assert(noteOps.length === 1 && noteOps[0].cmd === 'audio_set_pad' && !isContinuousOnly(noteOps), 'cambiar nota del pad se guarda de inmediato');

    const padStyle = { ...padA, padHarmony: 'minor' as const, padStyle: 'shimmer' as const };
    const styleOps = diffProjectControls(padA, padStyle);
    assert(
      styleOps.length === 1 &&
        styleOps[0].cmd === 'audio_set_pad' &&
        (styleOps[0].args.config as any).harmony === 2 &&
        (styleOps[0].args.config as any).style === 1 &&
        !isContinuousOnly(styleOps),
      'cambiar armonía o timbre del pad envía audio_set_pad de inmediato'
    );

    // Reconciliación sin trackControls
    const sent: Array<{ cmd: string; args?: Record<string, unknown> }> = [];
    let clock = 10_000;
    const sync = new ControlSync({
      getInvoke: () => async (cmd, args) => {
        sent.push({ cmd, args });
      },
      onError: () => {},
      recorder: new FlightRecorder(20),
      now: () => clock,
    });
    sync.syncAll(padA);
    await sync.queue.idle();
    clock += SETTLE_MS + 1;
    const snap = { padActive: true, padEnabled: true, padNote: 0, padGain: padA.padGain, padMonitor: false, padHarmony: 0, padStyle: 0 };
    assert(sync.reconcile(snap, padA).length === 0, 'primera lectura discrepante del pad espera confirmación');
    const fixed = sync.reconcile(snap, padA);
    assert(fixed.includes('pad'), 'segunda lectura discrepante corrige el pad aunque no haya pistas');
  }

  console.log('controlSync: OK');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
