import type { TransportState } from '../types/project';

/**
 * ¿Son iguales dos estados de transporte? Compara todos los campos por valor. Sirve para no avisar a la
 * interfaz (y no volver a renderizarla) cuando el sondeo devuelve lo mismo que la vez anterior, por ejemplo
 * en pausa.
 */
export function sameTransport(a: TransportState, b: TransportState): boolean {
  const keys = new Set<keyof TransportState>([
    ...(Object.keys(a) as (keyof TransportState)[]),
    ...(Object.keys(b) as (keyof TransportState)[]),
  ]);
  for (const k of keys) {
    if (a[k] !== b[k]) return false;
  }
  return true;
}
