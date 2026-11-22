/**
 * Un fallo persistente (carpeta de la canción sin conexión, disco de solo lectura, archivo bloqueado) se vuelve a
 * producir en cada guardado, y mover un fader guarda varias veces por segundo. Esto deja avisar una sola vez por fallo:
 * cuando aparece o cuando cambia el motivo; si el guardado vuelve a salir bien, el siguiente fallo avisa de nuevo.
 */
export class FailureTracker {
  private active = new Map<string, string>();

  /**
   * Anota el resultado de un guardado. `error` vacío = salió bien. Devuelve `true` si hay que avisar ahora (primer
   * fallo de esa clave o motivo distinto del último avisado).
   */
  report(key: string, error: string | null | undefined): boolean {
    if (!error) {
      this.active.delete(key);
      return false;
    }
    if (this.active.get(key) === error) return false;
    this.active.set(key, error);
    return true;
  }
}
