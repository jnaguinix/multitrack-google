import { useSyncExternalStore } from 'react';
import { audioEngine } from './audioEngine';
import { createMeterFeed, EMPTY_METERS } from './meterFeed';
import type { MetersSnapshot } from '../types/project';

const feed = createMeterFeed(() => audioEngine.getTrackMeters(), 50);

const subscribeNone = () => () => {};
const emptySnapshot = () => EMPTY_METERS;

/**
 * Niveles de los medidores a ~20 fps. Con `active = false` (parado) no hay temporizador ni suscripción
 * y devuelve niveles a cero. Úsalo solo en los componentes hoja que pintan el medidor.
 */
export function useLiveMeters(active: boolean): MetersSnapshot {
  return useSyncExternalStore(
    active ? feed.subscribe : subscribeNone,
    active ? feed.getSnapshot : emptySnapshot
  );
}
