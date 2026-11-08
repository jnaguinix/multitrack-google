# Plan de Implementación: Página Dedicada de Setlist e Inicio Limpio sin Auto-Carga

## 1. Página Dedicada `Setlist` (Inspirada en LibreTracks + Mixer Rediseñado)
- **Nueva Vista Principal `Setlist` en la Navegación Superior**:
  - Se añadirá la vista dedicada **`Setlist`** en la barra superior (`Setlist` · `Arranger (DAW)` · `Mixer` · `Remote` · `Biblioteca`).
- **Barra de Control Superior de Setlist**:
  - Controles modulares idénticos a la referencia: **Modo Vamp** (`VAMP`), **Salto de Marca** (`Siguiente sección` / `Inmediato` / `1 Compás`), **Transición de Canción** (`Inmediato / Corte limpio`, `Preparar siguiente`, `Parar al final`), **Transposición (`st`)**, **Tempo (`BPM`)**, botón **`✕ Cancelar Salto`** e indicadores **`N TRACKS · N MARCAS`**.
- **Fila Horizontal de Tarjetas de Canciones (`[1] → [2] → [+ Nueva canción]`)**:
  - Cada canción del Setlist se muestra como una tarjeta cuadrada/horizontal numerada (`1`, `2`, `3`...) con indicador de arrastre, botón **`▶`** en la esquina superior para dispararla al instante, menú para quitar/reordenar, título, BPM y duración (`mm:ss`), conectadas por flechas **`→`**.
  - Al final de la fila se incluye la tarjeta punteada **`+ Nueva canción`** que permite elegir cualquier canción ya guardada en tu **Repertorio** o importar una carpeta/stems nuevos directamente al Setlist.
- **Visor Central de Forma de Onda Maestra Unificada**:
  - Muestra la forma de onda general combinada de toda la canción seleccionada en gran formato, con el título y duración arriba a la izquierda, los marcadores de sección por tiempo (`mm:ss`) superpuestos, o el mensaje *"Esta canción no tiene secciones. Añádelas en Editar."* en la esquina inferior derecha junto al botón **`Editar`**.
- **Sección Inferior con Nuestro Mixer Rediseñado**:
  - Debajo de la onda maestra se ubica la barra de herramientas de pistas (`Pistas`, `Añadir audio...`, `Filtrar pistas de la canción`) y **nuestro Mixer rediseñado en Modo Oscuro** con todas las pistas de la canción activa, canales `Click` y `Cues`, y los 2 buses maestros (`Main L/R` y `Click / Cue`).

## 2. Inicio Limpio sin Auto-Cargar Canciones ni Canciones Demo
- **Eliminación Total de las Canciones Demo**:
  - Se eliminarán las canciones demo (`Horizonte Boreal` y `Catedral de Luz`) del código y se limpiarán automáticamente de IndexedDB si habían quedado guardadas de sesiones previas.
- **Estado Inicial Vacío (`Sin canción cargada`)**:
  - Al abrir la aplicación, **no se cargará ninguna canción automáticamente**.
  - Tanto el DAW como el Setlist mostrarán un estado limpio invitándote a **arrastrar o seleccionar con confirmación una canción de tu Repertorio** o pulsar **`+ Nueva canción` / `Importar Stems`**.
