import { debugMode } from './debugMode';
import { flightRecorder } from './flightRecorder';

/** Todo lo que sirve para diagnosticar: la caja negra (control de mezcla) y el registro detallado del modo diagnóstico. */
export function fullDiagnosticReport(context: Record<string, string | number | boolean | null | undefined>): string {
  return [flightRecorder.report(context), '', debugMode.report()].join('\n');
}

/** Descarga el texto como archivo `.txt` (para adjuntarlo a un mensaje en vez de pegarlo). */
export function downloadTextFile(name: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export function diagnosticFileName(): string {
  return `omnitracks-diagnostico-${new Date().toISOString().replace(/[:.]/g, '-')}.txt`;
}
