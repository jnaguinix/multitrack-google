// Pruebas de los medidores (UI03): ciclo compartido con un solo temporizador y cálculo de niveles de bus.
import { createMeterFeed, EMPTY_METERS } from '../src/audio/meterFeed';
import { computeMixerLevels, trackPeak, peakPosition } from '../src/utils/mixerLevels';

function assert(condition: boolean, msg: string) {
  if (!condition) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
}
const close = (a: number, b: number, tol = 1e-6) => Math.abs(a - b) <= tol;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function main() {
  // 1. Un solo temporizador y una sola lectura por tick, sea cual sea el número de suscriptores.
  {
    let lecturas = 0;
    const feed = createMeterFeed(() => {
      lecturas++;
      return { tracks: { a: { rms: 0.5, peak: 0.6, clipping: false } }, master: { rms: 0, peak: 0, clipping: false } };
    }, 10);
    assert(!feed.running && feed.getSnapshot() === EMPTY_METERS, 'sin suscriptores no debe haber temporizador');
    let avisos = 0;
    const bajas = [0, 1, 2, 3, 4].map(() => feed.subscribe(() => avisos++));
    const tras = lecturas;
    await sleep(100);
    const porTick = lecturas - tras;
    assert(porTick <= 14, `la lectura debe ser una por tick, no una por suscriptor (${porTick} en 100 ms)`);
    assert(avisos >= 5 * 5, `los suscriptores deben recibir los ticks (${avisos})`);
    const a = feed.getSnapshot();
    assert(a === feed.getSnapshot(), 'el snapshot debe ser estable entre llamadas');
    bajas.forEach((b) => b());
    assert(!feed.running, 'sin suscriptores el temporizador debe pararse');
    assert(feed.getSnapshot() === EMPTY_METERS, 'sin suscriptores los niveles vuelven a cero');
    const congeladas = lecturas;
    await sleep(60);
    assert(lecturas === congeladas, 'el motor se siguió leyendo sin suscriptores');
  }

  // 2. Niveles de bus.
  {
    const project: any = {
      tracks: [
        { id: 't1', muted: false, soloed: false, bus: 'main' },
        { id: 't2', muted: true, soloed: false, bus: 'cue-click' },
      ],
      clickEnabled: true,
      clickGain: 1,
      masterGain: 1,
      cueMasterGain: 0.708,
    };
    const transport: any = { isPlaying: true, beatProgress: 0, currentBeat: 1, queuedSectionId: null };
    const meters: any = {
      tracks: { t1: { rms: 0.5, peak: 0.8, clipping: false }, t2: { rms: 0.9, peak: 0.9, clipping: false } },
      master: { rms: 0, peak: 0, clipping: false },
    };
    const lv = computeMixerLevels(project, transport, meters);
    assert(lv.main.l > 0.4 && lv.main.l <= 1, `bus principal con audio: ${lv.main.l}`);
    assert(!lv.nativeScale, 'sin niveles nativos la escala es la estimada');
    assert(trackPeak(project, transport, meters, 't1') === 0.8, 'pico de pista audible');
    assert(trackPeak(project, transport, meters, 't2') === 0, 'una pista silenciada no marca pico');

    const parado = computeMixerLevels(project, { ...transport, isPlaying: false }, meters);
    assert(parado.main.l === 0 && parado.cue.l === 0 && parado.click.l === 0, 'parado todos los niveles son cero');

    const nativos = computeMixerLevels(project, transport, {
      ...meters,
      nativeBuses: { main: { l: 0.1, r: 0.05 }, cue: { l: 0, r: 0 }, click: { l: 0, r: 0 } },
    });
    assert(nativos.nativeScale, 'con niveles nativos la escala es dBFS');
    assert(close(nativos.main.l, peakPosition(20 * Math.log10(0.1))), 'nivel nativo en dBFS');
    assert(nativos.cue.l === 0, 'bus nativo sin señal');
  }

  console.log('liveMeters: OK');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
