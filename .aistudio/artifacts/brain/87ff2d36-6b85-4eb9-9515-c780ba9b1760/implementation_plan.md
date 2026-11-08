# Importación Instantánea en Milisegundos (Estilo Escritorio / REAPER)

Este plan elimina el cuello de botella que hacía tardar 1 minuto por stem (10 minutos por carpeta) al importar, logrando que las carpetas y stems individuales (tanto WAV como MP3/M4A) se monten en la consola en **milisegundos** sin duplicar ni recodificar archivos en disco.

## User Review & Critical Decisions

> [!IMPORTANT]
> **Diagnóstico de la lentitud actual (por qué tardaba 10 minutos):**
> Actualmente, al importar cada archivo, la aplicación decodifica toda la pista y ejecuta `writeTrackPcmFromAudioBuffer()`, que convierte millones de muestras en el hilo principal y realiza **más de 260 escrituras IPC secuenciales en disco (`await writable.write()`) por pista** para crear una copia `.pcm` de ~70 MB por stem (~700 MB por canción) antes de mostrar la canción.

- **Decisión Confirmada 1 — Lectura directa sin copia a OPFS al importar**: Se elimina por completo la escritura/conversión a archivos `.pcm` en OPFS durante la importación. Los archivos seleccionados (`File` / `Blob`) ya son punteros directos al disco local del usuario.
- **Decisión Confirmada 2 — Soporte híbrido instantáneo para WAV y MP3/M4A**:
  - **Montaje en consola en < 50 ms**: Al seleccionar o soltar una carpeta o stem, la canción y todas sus pistas aparecen en el Setlist, Mixer y Arranger de forma inmediata (< 50 ms).
  - **Inspección rápida de cabeceras WAV (< 1 ms)**: Para archivos WAV, se leen únicamente los primeros 4 KB (`file.slice(0, 4096)`) para obtener duración exacta, frecuencia de muestreo y canales en menos de 1 milisegundo.
  - **Decodificación nativa C++ paralela en segundo plano (sin bloqueo)**: El motor de Web Audio prepara los buffers de reproducción en hilos nativos del navegador en paralelo (~0.5 a 1.5 segundos para una carpeta de 183 MB) mientras la interfaz ya está activa y lista para reproducir.

---

## 1. Overview & Core Concept

- **Qué hace**: Permite abrir carpetas completas de multitracks (10–20 stems en WAV, MP3 o M4A) o stems sueltos en milisegundos, igual que un DAW de escritorio instalado (REAPER / Ableton Live).
- **Flujo de trabajo en vivo**: El director musical arrastra una carpeta o la elige desde el selector; la canción aparece montada al instante con su título, BPM detectado, ruteo automático (Click/Guide a Cue, instrumentos a Main) y faders listos.
- **Valor clave**: Cero esperas de conversión en disco, cero congelamientos de interfaz y uso directo de los archivos originales sin duplicar gigabytes en almacenamiento interno.

---

## 2. User Experience & Visual Design

- **Flujo de Importación Instantánea**:
  1. El usuario selecciona o suelta una carpeta de stems o un archivo individual.
  2. En **menos de 50 ms**, el modal se cierra y la canción queda activa en el Setlist y en el Mixer con todas sus pistas visibles y nombradas.
  3. Un indicador ligero no bloqueante en la barra de transporte muestra el montaje rápido de formas de onda en paralelo (que finaliza en ~1 segundo sin detener ni bloquear la app).
- **Identidad Visual y Estética**:
  - Mantiene intacta la interfaz oscura de estudio (`#0B0F17` / `#111827`) con acentos cian (`#06B6D4`) y esmeralda (`#10B981`), medidores a 20 fps y controles táctiles de alta precisión.

---

## 3. Key Product Decisions & Trade-Offs

- **Decisión 1: Eliminar la generación de archivos `.pcm` en OPFS durante la importación**
  - *Enfoque elegido*: Guardar únicamente la referencia nativa del `File` (`Blob`) en IndexedDB (operación de puntero que toma milisegundos) y decodificar en memoria con los hilos nativos C++ del navegador (`Promise.all` controlado por lotes en paralelo).
  - *Por qué*:Escribir 700 MB de PCM crudo mediante `FileSystemWritableFileStream` en el hilo principal bloquea el navegador durante minutos. Sin esa copia a OPFS, importar y activar una carpeta de 183 MB pasa de 10 minutos a ~1 segundo total (con aparición en UI en < 50 ms).
- **Decisión 2: Lectura instantánea de cabecera WAV + Streaming directo**
  - *Enfoque elegido*: Analizar los primeros 44–4096 bytes de cualquier archivo `.wav` mediante `file.slice(0, 4096)` para conocer su duración exacta en < 1 ms y calcular picos rápidos sin esperar a decodificar todo el archivo. Para MP3/M4A, usar la decodificación nativa multihilo de Web Audio.
  - *Por qué*: Garantiza respuesta inmediata estilo aplicación de escritorio tanto para stems WAV sin comprimir como para stems comprimidos (MP3/M4A).

---

## 4. Technical Architecture & Data Strategy

```
┌─────────────────────────────────────────────────────────────────────────┐
│             SELECCIÓN DE CARPETA O DRAG & DROP (WAV / MP3 / M4A)        │
└────────────────────────────────────┬────────────────────────────────────┘
                                     │ (< 10 ms)
                                     ▼
┌─────────────────────────────────────────────────────────────────────────┐
│ 1. REGISTRO INSTANTÁNEO (ZERO-COPY)                                     │
│  • Inferencia de Título, BPM, Tonalidad y Roles (Click, Guide, Drums…)  │
│  • Lectura rápida de cabecera WAV (file.slice 4 KB -> < 1 ms)           │
│  • Montaje inmediato de la canción y canales en UI (Setlist + Mixer)    │
│  • Guardado de punteros Blob nativos en IndexedDB sin copiar bytes      │
└────────────────────────────────────┬────────────────────────────────────┘
                                     │ (En paralelo, sin bloquear UI)
                                     ▼
┌─────────────────────────────────────────────────────────────────────────┐
│ 2. MOTOR DE AUDIO MULTIHILO (WEB AUDIO NATIVE C++ THREADS)              │
│  • Decodificación paralela por lotes (4 pistas simultáneas en C++)      │
│  • Inyección directa de cada pista al grafo activo conforme termina     │
│  • Actualización progresiva de formas de onda (peaks) en tiempo real    │
└─────────────────────────────────────────────────────────────────────────┘
```

### Mapeo de Interacción y Estado
1. **Creación inmediata del proyecto**: Al recibir los archivos validados, se construye el objeto `SongProject` con todas sus pistas y se activa en el estado de la aplicación antes de iniciar la decodificación pesada.
2. **Montaje progresivo en vivo**: A medida que cada stem se decodifica en paralelo (en cuestión de milisegundos por pista al no escribir en OPFS), se monta directamente en el motor de audio (`mountDecodedTrack`) y actualiza su forma de onda y duración real en la consola.
3. **Añadir stem individual a canción activa**: Monta el canal al instante en el Mixer/Arranger y vincula su buffer de audio en cuanto finaliza su decodificación nativa (< 150 ms para un stem).
