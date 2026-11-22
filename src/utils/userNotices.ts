/**
 * Canal para avisar al usuario desde capas que no tienen acceso a la interfaz (almacenamiento, motor): quien tiene el
 * aviso breve de la app («toast») se suscribe con `onUserNotice` y quien detecta el problema llama a `notifyUser`.
 * Sin nadie suscrito (p. ej. antes de montar la app) el mensaje queda al menos en la consola.
 */
type Listener = (message: string) => void;

const listeners = new Set<Listener>();

/** Se suscribe a los avisos. Devuelve la función que cancela la suscripción. */
export function onUserNotice(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Muestra un aviso al usuario. */
export function notifyUser(message: string): void {
  if (listeners.size === 0) console.warn(`[OmniTracks] Aviso sin pantalla donde mostrarlo: ${message}`);
  for (const listener of listeners) listener(message);
}
