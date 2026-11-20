import { useSyncExternalStore } from 'react';
import { debugMode } from '../utils/debugMode';

/** Se vuelve a renderizar cuando el modo diagnóstico cambia o llega un evento (agrupados por cuadro). */
export function useDebugMode() {
  useSyncExternalStore(debugMode.subscribe, debugMode.getVersion);
  return debugMode;
}
