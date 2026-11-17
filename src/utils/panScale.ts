/**
 * Escala del paneo. La interfaz y el proyecto guardan el pan de -1 (izquierda) a +1 (derecha); el comando
 * `audio_set_track_controls` del motor espera un entero de -100 a 100. Enviar el valor de la interfaz tal
 * cual hacía que Rust rechazara el comando con un pan decimal (y con -1/+1 lo dejaba casi centrado).
 */
export function panToEngine(pan: number | null | undefined): number {
  if (typeof pan !== 'number' || !Number.isFinite(pan)) return 0;
  return Math.max(-100, Math.min(100, Math.round(pan * 100)));
}
