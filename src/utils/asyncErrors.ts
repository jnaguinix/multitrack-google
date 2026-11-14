/**
 * Manejador para promesas lanzadas «sin esperar» (guardar, sincronizar, enviar controles al motor…).
 *
 * Sustituye a `.catch(() => {})`: el fallo deja de ser silencioso y queda en la consola con su contexto.
 * Para no inundar la consola cuando el mismo fallo se repite (p. ej. mover un fader), cada contexto
 * registra como mucho un aviso cada 5 s e indica cuántos se omitieron.
 */
const LOG_INTERVAL_MS = 5000;
const state = new Map<string, { lastLog: number; skipped: number }>();

export function logAsyncError(context: string): (error: unknown) => void {
  return (error: unknown) => {
    const now = Date.now();
    const entry = state.get(context) ?? { lastLog: 0, skipped: 0 };
    if (now - entry.lastLog < LOG_INTERVAL_MS) {
      entry.skipped++;
      state.set(context, entry);
      return;
    }
    const extra = entry.skipped > 0 ? ` (${entry.skipped} fallos más desde el último aviso)` : '';
    console.warn(`[OmniTracks] Falló una operación en segundo plano: ${context}${extra}`, error);
    state.set(context, { lastLog: now, skipped: 0 });
  };
}
