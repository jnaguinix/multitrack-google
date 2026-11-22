//! Cierre de la ventana con confirmación de la interfaz.
//!
//! Los cambios continuos de la mezcla (un fader) se guardan con 400 ms de retraso y, al cerrar la ventana, la
//! interfaz los vaciaba con un envío «lanzar y olvidar» que el proceso podía no llegar a atender antes de salir.
//! Ahora el primer cierre se detiene (`prevent_close`), se avisa a la interfaz con el evento `app://close-requested`,
//! esta guarda todo lo pendiente y confirma con `app_confirm_close`, que deja cerrar. Si la interfaz no contesta
//! (colgada, sin cargar) se cierra igualmente tras `CLOSE_GRACE_MS`: nunca queda una ventana imposible de cerrar.

use std::sync::atomic::{AtomicBool, Ordering};
use tauri::State;

/// Evento que se envía a la interfaz cuando se pide cerrar la ventana.
pub const CLOSE_EVENT: &str = "app://close-requested";

/// Tiempo máximo que se espera a que la interfaz termine de guardar antes de cerrar igualmente.
pub const CLOSE_GRACE_MS: u64 = 2500;

/// Qué hacer ante una petición de cierre.
#[derive(Debug, PartialEq, Eq)]
pub enum CloseDecision {
    /// Dejar cerrar (la interfaz ya confirmó o venció la espera).
    Allow,
    /// Detener el cierre, avisar a la interfaz y armar la espera máxima.
    Ask,
    /// Ya se está esperando a la interfaz: detener este cierre sin avisar ni armar otra espera.
    Wait,
}

#[derive(Default)]
pub struct CloseGate {
    confirmed: AtomicBool,
    asking: AtomicBool,
}

impl CloseGate {
    pub fn on_close_requested(&self) -> CloseDecision {
        if self.confirmed.load(Ordering::SeqCst) {
            CloseDecision::Allow
        } else if self.asking.swap(true, Ordering::SeqCst) {
            CloseDecision::Wait
        } else {
            CloseDecision::Ask
        }
    }

    /// La interfaz terminó de guardar (o venció la espera): el siguiente cierre pasa.
    pub fn confirm(&self) {
        self.confirmed.store(true, Ordering::SeqCst);
    }
}

/// La interfaz avisa de que ya guardó todo lo pendiente: se confirma y se cierra la ventana.
#[tauri::command]
pub async fn app_confirm_close(window: tauri::WebviewWindow, gate: State<'_, CloseGate>) -> Result<(), String> {
    gate.confirm();
    window.close().map_err(|e| format!("No se pudo cerrar la ventana: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn el_primer_cierre_pregunta_a_la_interfaz_y_los_siguientes_esperan_sin_repetir() {
        let gate = CloseGate::default();
        assert_eq!(gate.on_close_requested(), CloseDecision::Ask, "el primer cierre se detiene y avisa a la interfaz");
        assert_eq!(gate.on_close_requested(), CloseDecision::Wait, "un segundo clic en la X no arma otra espera");
        assert_eq!(gate.on_close_requested(), CloseDecision::Wait);
    }

    #[test]
    fn confirmado_el_cierre_pasa_y_sigue_pasando() {
        let gate = CloseGate::default();
        assert_eq!(gate.on_close_requested(), CloseDecision::Ask);
        gate.confirm();
        assert_eq!(gate.on_close_requested(), CloseDecision::Allow, "tras confirmar, el cierre sigue adelante");
        assert_eq!(gate.on_close_requested(), CloseDecision::Allow);
    }

    #[test]
    fn la_confirmacion_vale_aunque_nadie_hubiera_preguntado() {
        // Lo que hace el plazo máximo si la interfaz no contesta: confirma por su cuenta.
        let gate = CloseGate::default();
        gate.confirm();
        assert_eq!(gate.on_close_requested(), CloseDecision::Allow);
    }

    #[test]
    fn la_espera_maxima_es_acotada() {
        // Una ventana que no se puede cerrar sería peor que perder un guardado: el plazo no puede ser largo.
        assert!(CLOSE_GRACE_MS >= 1000 && CLOSE_GRACE_MS <= 5000);
    }
}
