# Plan de Mejora de Legibilidad, Mixer Flotante en Setlist y Arranger Claro

## Objetivo
Conservar la distribución limpia sin controles duplicados, pero **aumentar el tamaño de letra y legibilidad en toda la interfaz**, **convertir el Mixer del Setlist en una tarjeta flotante intuitiva** (cerrable con un clic o tecla `Esc`), y **ampliar los canales del Arranger (DAW) a 2 líneas (`64px` de alto)** para que los nombres de cada instrumento se lean grandes y completos.

---

## 1. Tipografía Más Grande y Legible en Barras y Repertorio
- **TopBar (`42px` de alto) y TransportDeck (`46px` de alto)**:
  - Subir los textos de navegación, botones (`Play`, `Stop`, `Vamp`, `+ Marcar`, `Secciones`, `Salto`, `Click`, `Cues`) y selectores de `10px–11px` a **`12px–13px` (`text-xs` / `text-sm`)** con mayor contraste.
  - Ampliar el reloj digital a `18px` (`text-lg`) y el título de la canción activa a `14px` (`text-sm font-bold`).
- **Sidebar de Repertorio (`240px` / `w-60`)**:
  - Ampliar el ancho de `208px` a `240px` para que los títulos de las canciones se lean en **`13px` (`text-xs`/`text-[13px]` font-semibold)** y los metadatos (`08:00 · 120 BPM · 10p`) en `11px` claros.

---

## 2. Vista Setlist: Onda Maestra Grande + Pads de Secciones y Mute Rápido + Mixer en Card Flotante
- **Tarjetas de Canciones del Setlist Más Legibles (`64px` de alto, `w-56`)**:
  - Título de canción en `13px` negrita, número de orden claro, BPM y duración en `11px`, e indicadores `RAM` / `Opt` legibles.
- **Espacio Principal del Setlist (cuando el Mixer flotante está cerrado)**:
  1. **Onda Maestra Grande (`180px–210px` de alto)**: Visualización amplia y clara de la estructura de la canción, con título en `16px` y cursor de tiempo real.
  2. **Panel de Secciones en Vivo (Botones Grandes de Salto)**: Botones grandes y táctiles (`min-h-[42px]`, letra `13px–14px`) para saltar a cada sección (`Intro`, `Verso`, `Coro`, `Puente`) o crear una marca rápida con `+ Marcar aquí`.
  3. **Grid de Pistas en Vivo (Mute / Solo Rápido)**: Tarjetas horizontales grandes y legibles por cada instrumento (`BASS`, `DRUMS`, `CLICK`, `CUES`, `PIANO`, `TAMBOURINE`, etc.) mostrando el nombre completo en `13px` negrita, medidor de nivel en vivo y botones `M` (Mute) y `S` (Solo) directos, además de `+ Añadir audio...` y filtro.
- **Consola Mixer como Card Flotante Intuitiva**:
  - Un botón destacado **`Sliders · Abrir Consola Mixer`** en la barra de pistas abre el **Mixer Completo en una Card Flotante (Modal/Drawer elevado con sombra y borde cian/esmeralda)** sobre la parte inferior/central de la pantalla.
  - Incluye faders cómodos, nombres de canal en `12px–13px`, botón **`Restablecer 0 dB`** y un botón claro **`✕ Cerrar Mixer`** (o clic fuera / tecla `Esc`) para ocultarlo al instante.

---

## 3. Vista Arranger (DAW): Encabezados de Pista en 2 Líneas (`64px` de alto)
- **Columna Izquierda de Pistas más Ancha (`264px` / `w-66`) y Filas de `64px` (`h-16`)**:
  - **Línea 1 (Superior)**: Punto de color del canal + **Nombre completo del instrumento en `13px` (`font-bold text-slate-100`)** sin recortes agresivos + Botones grandes `M` (`Mute`), `S` (`Solo`) y `Eliminar`.
  - **Línea 2 (Inferior)**: Slider de volumen cómodo + Lectura numérica clara (`0.0 dB` en `11px` monoespaciado) + Selector de bus (`Main` / `Cue` / `Both` en `11px`).
  - **Barra de Nivel VU**: Medidor horizontal integrado en la base del canal.
- **Regla de Tiempo y Carril de Secciones**:
  - Carril de secciones de `28px` y regla `MM:SS` de `24px` con números en `11px` claros.
