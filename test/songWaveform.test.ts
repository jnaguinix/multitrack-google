// Pruebas del dibujo de la onda del mapa de la canción, compartido por el Setlist y En vivo.
import { drawSectionWaveBars } from '../src/utils/songWaveform';

function assert(condition: boolean, msg: string) {
  if (!condition) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
}

interface Bar {
  color: string;
  x: number;
  from: number;
  to: number;
}

/** Contexto falso que anota cada barra dibujada (color, posición y extremos). */
function fakeContext() {
  const bars: Bar[] = [];
  let pending: Partial<Bar> = {};
  const ctx = {
    strokeStyle: '',
    lineWidth: 0,
    lineCap: '',
    globalAlpha: 0,
    save() {},
    restore() {},
    beginPath() {
      pending = {};
    },
    moveTo(x: number, y: number) {
      pending.x = x;
      pending.from = y;
    },
    lineTo(_x: number, y: number) {
      pending.to = y;
    },
    stroke() {
      bars.push({ color: ctx.strokeStyle, x: pending.x as number, from: pending.from as number, to: pending.to as number });
    },
  };
  return { ctx: ctx as unknown as CanvasRenderingContext2D, bars, raw: ctx };
}

const sections = [
  { startTimeSec: 0, endTimeSec: 5, color: '#ff0000' },
  { startTimeSec: 5, endTimeSec: 10, color: '#0000ff' },
];

// ---- Cada barra, del color de su sección
{
  const { ctx, bars } = fakeContext();
  drawSectionWaveBars(ctx, { width: 32, height: 100, peaks: Array(8).fill(0.5), sections, totalDurationSec: 10, top: 10, bottom: 90 });
  assert(bars.length === 8, `una barra por cada 4 px (8): ${bars.length}`);
  assert(bars.slice(0, 4).every((b) => b.color === '#ff0000'), 'la primera mitad, del color de la primera sección');
  assert(bars.slice(4).every((b) => b.color === '#0000ff'), 'la segunda mitad, del color de la segunda');
  assert(bars.every((b) => b.from < 50 && b.to > 50), 'simétricas sobre el eje central (50)');
}

// ---- Normalizada al pico más alto: ocupa toda la franja aunque la mezcla sea baja
{
  const { ctx, bars } = fakeContext();
  drawSectionWaveBars(ctx, { width: 16, height: 100, peaks: [0.05, 0.1, 0.2, 0.025], sections, totalDurationSec: 10, top: 10, bottom: 90 });
  const tallest = bars[2];
  assert(Math.abs(tallest.from - 10) < 1e-9 && Math.abs(tallest.to - 90) < 1e-9, `el pico más alto llena la franja: ${tallest.from}–${tallest.to}`);
  const heights = bars.map((b) => b.to - b.from);
  assert(heights[2] > heights[1] && heights[1] > heights[0] && heights[0] > heights[3], 'y las demás, proporcionales (más bajas)');
}

// ---- Una barra en silencio sigue viéndose (mínimo 1,5 px a cada lado)
{
  const { ctx, bars } = fakeContext();
  drawSectionWaveBars(ctx, { width: 8, height: 100, peaks: [0, 1], sections, totalDurationSec: 10, top: 10, bottom: 90 });
  assert(Math.abs(bars[0].to - bars[0].from - 3) < 1e-9, 'el silencio deja una marca de 3 px');
}

// ---- Fuera de toda sección o sin color: el color de respaldo
{
  const { ctx, bars } = fakeContext();
  drawSectionWaveBars(ctx, { width: 16, height: 100, peaks: [1, 1, 1, 1], sections: [{ startTimeSec: 0, endTimeSec: 5 }], totalDurationSec: 10, top: 0, bottom: 100 });
  assert(bars.every((b) => b.color === '#F5F5F3'), 'sin color de sección ni de respaldo: el claro de siempre');
  const other = fakeContext();
  drawSectionWaveBars(other.ctx, { width: 16, height: 100, peaks: [1, 1, 1, 1], sections: [], totalDurationSec: 10, top: 0, bottom: 100, fallbackColor: '#123456' });
  assert(other.bars.every((b) => b.color === '#123456'), 'el de respaldo que se indique');
}

// ---- Casos límite: no dibuja ni falla
{
  for (const o of [
    { width: 0, height: 100, peaks: [1], totalDurationSec: 10 },
    { width: 100, height: 0, peaks: [1], totalDurationSec: 10 },
    { width: 100, height: 100, peaks: [], totalDurationSec: 10 },
    { width: 100, height: 100, peaks: [1], totalDurationSec: 0 },
  ]) {
    const { ctx, bars } = fakeContext();
    drawSectionWaveBars(ctx, { ...o, sections, top: 0, bottom: 100 });
    assert(bars.length === 0, `sin tamaño, picos o duración no se dibuja nada: ${JSON.stringify(o)}`);
  }
  // Mucho más picos que ancho: se agrupan sin pasar de una barra por cada 4 px.
  const { ctx, bars } = fakeContext();
  drawSectionWaveBars(ctx, { width: 40, height: 100, peaks: Array(320).fill(0.4), sections, totalDurationSec: 10, top: 0, bottom: 100 });
  assert(bars.length === 10, `320 picos en 40 px: 10 barras (${bars.length})`);
}

console.log('songWaveform: OK');
