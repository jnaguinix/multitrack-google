// Pruebas del sondeo de estado (UI04): una sola petición pendiente, respuestas obsoletas descartadas,
// cadencia según estado, actualización inmediata y errores no silenciados.
import { StatePoller } from '../src/audio/statePoller';

function assert(condition: boolean, msg: string) {
  if (!condition) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function main() {
  // 1. Nunca hay dos peticiones en vuelo, aunque cada una tarde más que el intervalo.
  {
    let enVuelo = 0;
    let maxEnVuelo = 0;
    let llamadas = 0;
    const p = new StatePoller<number>({
      request: async () => {
        llamadas++;
        enVuelo++;
        maxEnVuelo = Math.max(maxEnVuelo, enVuelo);
        await sleep(30);
        enVuelo--;
        return llamadas;
      },
      onSnapshot: () => {},
      onError: () => {},
      delayMs: () => 5,
    });
    p.start();
    await sleep(250);
    p.stop();
    assert(maxEnVuelo === 1, `había ${maxEnVuelo} peticiones en vuelo a la vez`);
    assert(llamadas >= 4, `el sondeo no avanzó (${llamadas} llamadas)`);
  }

  // 2. Una respuesta lenta anterior a invalidate() no sobrescribe el estado nuevo.
  {
    const recibidos: string[] = [];
    let n = 0;
    const p = new StatePoller<string>({
      request: async () => {
        const mi = ++n;
        if (mi === 1) {
          await sleep(60);
          return 'proyecto-viejo';
        }
        return 'proyecto-nuevo';
      },
      onSnapshot: (s) => recibidos.push(s),
      onError: () => {},
      delayMs: () => 1000,
    });
    p.start();
    await sleep(10);
    p.invalidate(); // cambio de proyecto mientras la primera respuesta sigue en vuelo
    await sleep(150);
    p.stop();
    assert(!recibidos.includes('proyecto-viejo'), 'la respuesta obsoleta llegó a la interfaz');
    assert(recibidos[0] === 'proyecto-nuevo', `primer estado recibido: ${recibidos[0]}`);
  }

  // 3. La cadencia depende del último estado (pausado consulta menos que reproduciendo).
  {
    let reproduciendo = true;
    const marcas: number[] = [];
    const p = new StatePoller<boolean>({
      request: async () => {
        marcas.push(Date.now());
        return reproduciendo;
      },
      onSnapshot: () => {},
      onError: () => {},
      delayMs: (last) => (last ? 10 : 80),
    });
    p.start();
    await sleep(200);
    const rapidas = marcas.length;
    reproduciendo = false;
    marcas.length = 0;
    await sleep(400);
    p.stop();
    assert(rapidas >= 8, `reproduciendo debía consultar a menudo (${rapidas} en 200 ms)`);
    assert(marcas.length <= 7, `pausado debía consultar menos (${marcas.length} en 400 ms)`);
  }

  // 4. pollNow() adelanta la consulta; con una en vuelo, encadena otra inmediatamente después.
  {
    let llamadas = 0;
    const p = new StatePoller<number>({
      request: async () => {
        llamadas++;
        await sleep(20);
        return llamadas;
      },
      onSnapshot: () => {},
      onError: () => {},
      delayMs: () => 10_000,
    });
    p.start();
    await sleep(60);
    assert(llamadas === 1, `tras la primera consulta no debía haber más (${llamadas})`);
    p.pollNow();
    await sleep(60);
    assert(llamadas === 2, `pollNow no adelantó la consulta (${llamadas})`);
    p.pollNow();
    p.pollNow(); // con una en vuelo: solo se encadena una más
    await sleep(120);
    p.stop();
    assert(llamadas === 4, `pollNow con petición en vuelo debía encadenar una sola más (${llamadas})`);
  }

  // 5. Los errores llegan a onError y el sondeo continúa.
  {
    let errores = 0;
    let llamadas = 0;
    const p = new StatePoller<number>({
      request: async () => {
        llamadas++;
        if (llamadas % 2 === 1) throw new Error('fallo de IPC');
        return llamadas;
      },
      onSnapshot: () => {},
      onError: () => {
        errores++;
      },
      delayMs: () => 5,
    });
    p.start();
    await sleep(150);
    p.stop();
    assert(errores >= 2, `los errores no llegaron a onError (${errores})`);
    assert(llamadas > errores, 'el sondeo se detuvo tras un error');
  }

  // 6. Tras stop() no llega nada más.
  {
    let llamadas = 0;
    const p = new StatePoller<number>({
      request: async () => ++llamadas,
      onSnapshot: () => {},
      onError: () => {},
      delayMs: () => 5,
    });
    p.start();
    await sleep(40);
    p.stop();
    const congeladas = llamadas;
    await sleep(80);
    assert(llamadas === congeladas, 'el sondeo siguió tras stop()');
  }

  console.log('statePoller: OK');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
