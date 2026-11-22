pub mod audio;
pub mod close_gate;
pub mod lan;
pub mod library;
pub mod protocol;

/// Asignador de pruebas que cuenta las asignaciones del hilo que lo activa. Sirve para exigir «cero
/// asignaciones» en el código que se ejecuta dentro del callback de audio.
#[cfg(test)]
pub mod alloc_probe {
    use std::alloc::{GlobalAlloc, Layout, System};
    use std::cell::Cell;

    thread_local! {
        static ACTIVE: Cell<bool> = const { Cell::new(false) };
        static COUNT: Cell<u64> = const { Cell::new(0) };
    }

    pub struct CountingAlloc;

    fn note() {
        let _ = ACTIVE.try_with(|a| {
            if a.get() {
                let _ = COUNT.try_with(|c| c.set(c.get() + 1));
            }
        });
    }

    unsafe impl GlobalAlloc for CountingAlloc {
        unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
            note();
            System.alloc(layout)
        }
        unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
            System.dealloc(ptr, layout)
        }
        unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
            note();
            System.realloc(ptr, layout, new_size)
        }
        unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
            note();
            System.alloc_zeroed(layout)
        }
    }

    /// Ejecuta `f` y devuelve cuántas asignaciones hizo este hilo.
    pub fn count_allocs<F: FnOnce()>(f: F) -> u64 {
        COUNT.with(|c| c.set(0));
        ACTIVE.with(|a| a.set(true));
        f();
        ACTIVE.with(|a| a.set(false));
        COUNT.with(|c| c.get())
    }
}

#[cfg(test)]
#[global_allocator]
static ALLOC: alloc_probe::CountingAlloc = alloc_probe::CountingAlloc;

#[cfg(test)]
mod capability_tests {
    /// El frontend escucha `audio://import-progress` con `event.listen`. En Tauri v2 eso exige permisos
    /// explícitos de eventos; sin ellos `listen` falla y la interfaz no ve el avance de la caché.
    #[test]
    fn test_capabilities_permiten_escuchar_eventos() {
        let caps: serde_json::Value =
            serde_json::from_str(include_str!("../capabilities/desktop-remote.json")).expect("JSON de capacidades inválido");
        let perms: Vec<&str> = caps["permissions"]
            .as_array()
            .expect("falta la lista de permisos")
            .iter()
            .filter_map(|p| p.as_str())
            .collect();
        for needed in ["core:event:allow-listen", "core:event:allow-unlisten"] {
            assert!(perms.contains(&needed), "falta el permiso {needed} en capabilities/desktop-remote.json");
        }
    }
}
