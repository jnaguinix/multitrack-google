# Diseño de Estudio Ultra-Compacto para Laptops (Viewport 720p / 768p)

Este plan rediseña la distribución espacial y densidad visual de LibreTracks para pantallas pequeñas de laptop (`1280×720` y `1366×768`), eliminando barras duplicadas y compactando controles para que **el Transporte, el Setlist, la Forma de Onda Maestra y el Mixer completo entren simultáneamente en pantalla sin recortarse**.

## User Review & Critical Decisions

> [!IMPORTANT]
> **Presupuesto vertical en pantallas de laptop (~640px – 720px de alto útil en navegador):**
> Actualmente la interfaz suma **~970px de altura vertical** debido a barras de control duplicadas entre el Transporte y el Setlist, tarjetas de canción muy altas y encabezados repetidos, dejando el Mixer cortado fuera de la pantalla. Con la nueva arquitectura compacta, la altura total requerida baja a **~520px**, permitiendo ver y operar toda la consola de un vistazo.

- **Decisión Confirmada 1 — Barra Superior y Transporte Unificados (Sin Duplicados)**:
  - Se elimina la segunda barra de controles repetida dentro de la vista Setlist (`MODO VAMP`, `SALTO DE MARCA`, `TRANSICIÓN DE CANCIÓN`, `TRANSPOSICIÓN DE REGIÓN`, `TEMPO`), dejando todos los controles unificados en una única barra de transporte horizontal ultra-compacta de una sola línea (`40px` de alto).
- **Decisión Confirmada 2 — Prioridad Total al Mixer y Pistas en Pantalla**:
  - Se compactan las tarjetas del Setlist (de `108px` a `48px` de alto en formato horizontal), la forma de onda maestra (de `192px` a `80px` de alto) y los canales del Mixer (`74px` de ancho × `265px` de alto total), logrando que **hasta 12 canales + 2 buses maestros se vean completos de arriba a abajo y de izquierda a derecha** en una laptop estándar.

---

## 1. Overview & Core Concept

- **Qué soluciona**: En laptops de escenario (`13"` a `15"` con resoluciones `1366×768` o escalado de Windows al 125%–150%), los menús ocupaban el 75% de la pantalla y ocultaban los faders del Mixer y las pistas del Arranger.
- **Resultado para el músico en vivo**: Visibilidad total en una sola pantalla (Zero-Scroll vertical en vista Setlist) con controles claros, tipografía legible (`tabular-nums`) y cero botones repetidos.

---

## 2. User Experience & Visual Design

### Distribución Vertical Exacta (Presupuesto de ~520px de alto total)

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ 1. TOP BAR COMPACTA (36px)                                                   │
│ LibreTracks │ Setlist(1) · Arranger · Mixer · Remote · Biblio │ Buffer/RAM/+ │
├──────────────────────────────────────────────────────────────────────────────┤
│ 2. TRANSPORTE UNIFICADO EN 1 FILA (40px) — Cero controles duplicados         │
│ Canción · 1/1 [▶ Play][■][Vamp] │ 00:00.0/08:00 ▮▮▮▮ │ Salto·BPM·Tono·Click  │
├───────────────┬──────────────────────────────────────────────────────────────┤
│ 3. REPERTORIO │ 4. CINTA HORIZONTAL DE SETLIST (56px)                        │
│ LATERAL       │ [ 1. Dios el más grande (RAM · Opt) ▶ ••• ] → [ + Canción ]  │
│ COMPACTO      ├──────────────────────────────────────────────────────────────┤
│ (200px ancho  │ 5. FORMA DE ONDA MAESTRA + SECCIONES (80px)                  │
│  o plegado    │ ▂▃▅▇█▇▆▅▃▂▁▂▄▆█▇▅▃ [Intro] [Verso] [Coro]     [+Marcar][Edit]│
│  a 32px)      ├──────────────────────────────────────────────────────────────┤
│               │ 6. BARRA DE PISTAS Y MEZCLA (28px)                           │
│ • Buscador    │ Pistas (10) · Compás 001 Listo  [+ Audio] [Filtrar] [0.0 dB] │
│ • [+Stems][📁]├──────────────────────────────────────────────────────────────┤
│ • Lista de    │ 7. CONSOLA MIXER COMPLETA EN PANTALLA (275px)                │
│   canciones   │ ┌─────┐ ┌─────┐ ┌─────┐ ┌─────┐ ┌─────┐ ┌─────┐ ║ ┌────────┐ │
│   compacta    │ │BASS │ │CLICK│ │CUES │ │DRUMS│ │EG 1 │ │KEYS │ ║ │Main L/R│ │
│               │ │ (○) │ │ (○) │ │ (○) │ │ (○) │ │ (○) │ │ (○) │ ║ │  ║  ║  │ │
│               │ │ ║ ║ │ │ ║ ║ │ │ ║ ║ │ │ ║ ║ │ │ ║ ║ │ │ ║ ║ │ ║ │  ╠══╣  │ │
│               │ │[M|S]│ │[M|S]│ │[M|S]│ │[M|S]│ │[M|S]│ │[M|S]│ ║ │ 0.0 dB │ │
│               │ │Main │ │ Cue │ │ Cue │ │Main │ │Main │ │Main │ ║ └────────┘ │
│               │ └─────┘ └─────┘ └─────┘ └─────┘ └─────┘ └─────┘ ║            │
└───────────────┴──────────────────────────────────────────────────────────────┘
```

### Mejoras Clave por Zona
1. **TopBar (`36px`)**:
   - Etiquetas de navegación concisas en una línea (`Setlist`, `Arranger`, `Mixer`, `Remote`, `Biblioteca`).
   - Selector `Buffer / Stream`, presupuesto `RAM` y botón `+ Importar` compactados con menor padding horizontal.
2. **Transporte Unificado de 1 Sola Fila (`40px`)**:
   - Agrupa en una sola línea horizontal: Título/Tonalidad, navegación de Setlist (`1/1` + selector de transición), botones `Play / Stop / Vamp`, reloj digital `00:00.0 / 08:00` con indicador de pulso y sección activa, cuantización de salto (`Inmed. / 1 Comp. / Fin Sec.`), `BPM`, `Tono (st)`, `Click`, `Cues` y `Stereo / Split`.
3. **Vista Setlist sin Controles Repetidos**:
   - Se elimina la fila redundante de cajas (`MODO VAMP`, `SALTO DE MARCA`, `TRANSICIÓN`, `TRANSPOSICIÓN`, `TEMPO`).
   - Las tarjetas de canciones del Setlist pasan a un diseño horizontal compacto (`48px` de alto) que muestra número, título, BPM, duración, estado en RAM, botón `Opt` y Play directo sin desperdiciar espacio vertical.
   - La forma de onda maestra se ajusta a `80px` de alto con marcadores de sección superpuestos y botones rápidos `+ Marcar` y `Editar` integrados en sus esquinas.
4. **Consola Mixer Compacta (100% visible sin cortar)**:
   - Se fusiona el encabezado del Mixer (`Compás 001 · Listo` y `Restablecer 0 dB`) dentro de la barra de `Pistas (10)` de `28px`, ahorrando `48px` verticales.
   - Cada canal del Mixer acoplado reduce su ancho a `74px` y la altura del fader a `145px` (con perilla de paneo de `28px`, lectura en dB y botones `M / S` y `Bus` de `22px`), permitiendo ver todos los canales completos de arriba a abajo en cualquier laptop.
5. **Vista Arranger (DAW) de Alta Densidad**:
   - Se eliminan los banners de texto explicativo superior e inferior que restaban espacio.
   - Cada pista horizontal reduce su altura a `42px` con controles en una sola línea (`Nombre`, `M`, `S`, fader horizontal de volumen, `dB`, selector `Main/Cue` y borrar), permitiendo ver **10 a 12 pistas completas al mismo tiempo** sin hacer scroll.
6. **Barra Lateral de Repertorio Esbelta (`200px`)**:
   - Se elimina el cuadro de texto instructivo fijo y se compactan el buscador, los botones `+ Stems / Carpeta` y las filas de canciones para dejar más ancho útil al Mixer y al Arranger.

---

## 3. Key Product Decisions & Trade-Offs

- **Decisión 1: Consolidación de Controles en una Única Barra de Transporte**
  - *Enfoque elegido*: Mantener el 100% de las funciones (Vamp, Salto cuantizado, Transición de canción, Pitch, BPM, Click, Cues, Split L/R, Marcar sección) en una única barra superior de `40px` y eliminar su duplicación dentro del cuerpo del Setlist y del Arranger.
  - *Por qué*: Gana más de `120px` de altura vertical inmediata y evita confusión visual al tener el mismo control dos veces en pantalla.
- **Decisión 2: Escala Proporcional de Canales del Mixer y Pistas del Arranger**
  - *Enfoque elegido*: Reducir la altura del recorrido del fader acoplado de `184px` a `142px` y el ancho de cada canal de `86px` a `74px`, conservando la precisión de arrastre en dB y los medidores estéreo L/R a 20 fps.
  - *Por qué*: Permite que en una pantalla de `1366×768` quepan hasta 12 canales más los 2 buses maestros en horizontal y el canal completo de principio a fin en vertical.

---

## 4. Technical Architecture & Data Strategy

- **Cero cambios en el motor de audio**: Toda la lógica de Web Audio API, OPFS, caché RAM, Workers, saltos cuantizados, vamp y BroadcastChannel permanece intacta.
- **Mapeo de Estado y Controles**:
  - La barra de transporte unificada conserva todos los manejadores de eventos (`onPlayPause`, `onStop`, `onToggleVamp`, `onCancelQueuedJump`, `onChangeQuantize`, `onChangeBpm`, `onChangePitch`, `onToggleClick`, `onToggleGuide`, `onToggleSplitRouting`, `onAddMarkerAtPlayhead`, `onOpenSectionEditor`).
  - La barra unificada de pistas en `SetlistPageView` integra el indicador de compás/sección activa, el botón de restablecer mezcla a `0.0 dB`, la adición de stems y el filtro en tiempo real.
