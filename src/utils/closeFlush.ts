/**
 * Cierre de la ventana con los guardados al día. Rust detiene el primer cierre y envía `app://close-requested`
 * (`desktop/src-tauri/src/close_gate.rs`); aquí se guarda todo lo pendiente y se confirma con `app_confirm_close`, que
 * deja cerrar. Si guardar falla, igualmente se confirma: el error queda registrado, pero la ventana no puede quedar
 * imposible de cerrar (y Rust cierra por su cuenta si esto no contesta a tiempo).
 */
export const CLOSE_REQUESTED_EVENT = 'app://close-requested';

export interface CloseFlushDeps {
  listen: (event: string, handler: (event: unknown) => void) => Promise<() => void>;
  invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown>;
  /** Guarda todo lo pendiente y espera a que termine. */
  flush: () => Promise<void>;
  onError: (context: string) => (error: unknown) => void;
}

/** Se suscribe al aviso de cierre. Devuelve la función que cancela la suscripción. */
export async function installCloseFlush({ listen, invoke, flush, onError }: CloseFlushDeps): Promise<() => void> {
  let confirming = false;
  return listen(CLOSE_REQUESTED_EVENT, () => {
    if (confirming) return;
    confirming = true;
    void (async () => {
      try {
        await flush();
      } catch (error) {
        onError('guardar antes de cerrar')(error);
      }
      try {
        await invoke('app_confirm_close');
      } catch (error) {
        onError('confirmar el cierre de la ventana')(error);
        confirming = false;
      }
    })();
  });
}
