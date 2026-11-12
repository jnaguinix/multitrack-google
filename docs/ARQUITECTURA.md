# Arquitectura del Sistema OmniTracks

Este documento detalla la estructura modular de la aplicación tras la división de archivos monolíticos (`desktop/src-tauri/src/audio/playback/` y `src/hooks/`), las reglas obligatorias de codificación para el repositorio y el registro de deuda técnica identificada.

---

## 1. Regla Obligatoria de Codificación (UTF-8 sin BOM)

> [!IMPORTANT]
> **Todos los archivos del repositorio se leen y escriben estrictamente en UTF-8 sin BOM (Byte Order Mark).**
> - No se permite el uso de secuencias iniciales de bytes `EF BB BF`.
> - En PowerShell, nunca utilizar `Set-Content` o `Out-File` sin especificar codificación sin BOM. Utilizar siempre:
>   ```powershell
>   [System.IO.File]::WriteAllText($ruta, $texto, [System.Text.UTF8Encoding]::new($false))
>   ```
> - En entornos Node.js / Python, asegurar siempre codificación `utf-8` estándar.

---

## 2. Motor Nativo de Audio (Rust / Tauri)

El archivo original monolítico `desktop/src-tauri/src/audio/playback.rs` fue dividido en el módulo `playback/` preservando el historial (`git mv`) y la visibilidad de APIs públicas y crates:

```
desktop/src-tauri/src/audio/playback/
├── mod.rs          # PlaybackEngine: estructura central, ciclo de vida, buffers y callback CPAL
├── bus.rs          # TrackBus: tipos y conversión de buses de salida (main, cue, both)
├── fade.rs         # FadeEnvelope, FadeType y constantes (FADE_MS): micro-fundidos
├── feeder_io.rs    # Lectura de frames PCM desde disco, staging y drenaje con remuestreo
├── guide.rs        # GuideCueEngine: síntesis y reproducción de cues / metrónomo
├── jumps.rs        # queue_section_jump, cancel_queued_jump, toggle_vamp (impl PlaybackEngine)
├── transport.rs    # play, pause, stop, seek, get_playback_state, reopen_stream (impl PlaybackEngine)
├── types.rs        # NativeSongSection, QueuedJumpInfo, ActiveTrack, PlaybackStateSnapshot, etc.
└── tests.rs        # Suite completa de pruebas unitarias y benchmarks de audio
```

### Principios de diseño en Rust:
- **`PlaybackEngine` en `mod.rs`**: Mantiene los campos privados y coordina el stream CPAL y los buffers ring (`rtrb`).
- **Submódulos hijos**: Implementan bloques `impl PlaybackEngine` con visibilidad sobre los campos del padre (`super::`).
- **Reexportaciones (`pub use`)**: `mod.rs` reexporta los tipos de `types`, `bus`, `fade` y `guide` para mantener compatibilidad total con llamadas externas e imports de tests.

---

## 3. Frontend Web & Desktop (React / TypeScript)

La lógica de estado y controladores de `src/App.tsx` se desacopló en custom hooks ubicados en `src/hooks/`:

```
src/hooks/
├── useOptimization.ts     # Poda y optimización PCM en navegador / OPFS
├── useProjectActions.ts   # Carga inmediata, creación, edición de metadatos, borrado y JSON export/import
├── useSetlist.ts          # Gestión de lista de canciones (setlist), reorden, precarga y expulsión de RAM
├── useImportFlow.ts       # Importación instantánea (Drop / Selector), escaneo y decodificación nativa
├── useMixerActions.ts     # Control de transporte, volumen, mute, solo, paneo, bus y secciones
└── useDawDragDrop.ts      # Manejo de eventos Drag & Drop de archivos y canciones sobre la DAW
```

### Principios de diseño en React:
- **`App.tsx` como orquestador**: Conserva la propiedad de los estados `useState`, efectos `useEffect`, referencias globales y el árbol JSX.
- **Hooks desacoplados**: Cada hook recibe sus dependencias por parámetro y expone los manejadores memoizados, garantizando cero alteración en el comportamiento de la interfaz.

---

## 4. Deuda Técnica Registrada

1. **`MARKER_PALETTE` duplicada**:
   - Definida actualmente de manera idéntica en `src/App.tsx` y en `src/hooks/useImportFlow.ts`.
   - *Acción recomendada*: Centralizar en un módulo compartido de constantes (e.g. `src/constants/ui.ts` o `src/types/project.ts`).
2. **`handleRelinkProject` en `src/App.tsx`**:
   - Se mantuvo directamente en `App.tsx` para respetar el orden de declaración y evitar errores de hoisting temporal (`TS2448`) con `activateProject` y `handleSelectView`.
   - *Acción recomendada*: Pasar las dependencias como callbacks a un submódulo específico durante una próxima fase de refactorización de vistas.
