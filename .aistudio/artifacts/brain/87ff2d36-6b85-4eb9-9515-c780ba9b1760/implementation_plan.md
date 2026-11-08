# LibreTracks Web 2.0 — Optimización de Importación Instantánea, Árbol de Repertorio y Auto-Detección Musical

Evolución de **LibreTracks Web** enfocada en superar la agilidad de LibreTracks de escritorio en escenarios reales: importación instantánea de canciones y stems sin bloqueos, auto-detección inteligente de compases y secciones a partir del audio, un **Panel Lateral en Árbol de Repertorio** siempre accesible con búsqueda instantánea, y una estética de **Estudio Diurno (Modo Claro por defecto)** con **Modo Oscuro como opción secundaria**.

## Decisiones Confirmadas y Revisión del Usuario

> [!IMPORTANT]
> Estas decisiones fueron confirmadas por el usuario y guían todas las mejoras arquitectónicas y visuales de esta iteración.

- **Importación Instantánea + Creación Automática de Canción**: Al arrastrar o seleccionar una carpeta o grupo de archivos de audio (`.wav`, `.mp3`, `.ogg`, `.flac`, `.m4a`), la aplicación **crea automáticamente una nueva canción** (deduciendo el nombre de la canción a partir de la carpeta o prefijo común de los archivos), inserta las pistas de inmediato en la interfaz sin quedarse congelada en "decodificando" y procesa el audio en paralelo con barra de progreso en tiempo real y guardado asíncrono en segundo plano.
- **Auto-Detección de Compases, Duración y Secciones Musicales**: Al importar stems, un analizador de envolvente energética y transitorios calcula automáticamente el número exacto de compases (`totalBars`) según la duración real del audio y genera marcadores estructurales inteligentes (*Intro*, *Verso*, *Coro*, *Puente*, *Outro*) detectando los cambios de densidad dinámica entre regiones.
- **Panel Lateral Acoplable con Árbol de Repertorio**: La biblioteca deja de estar oculta en otra vista y pasa a ser un **panel lateral izquierdo acoplable (`280px`)** con buscador instantáneo y estructura en árbol (*Setlists / Carpetas de Artista → Canciones → Stems y Secciones*), permitiendo cambiar de canción con un solo clic.
- **Modo Claro Principal y Modo Oscuro Secundario**: La interfaz arranca por defecto en **Modo Claro de Estudio** (alta legibilidad diurna, superficies limpias en blanco y pizarra clara `#F8FAFC` / `#FFFFFF`) e incluye un conmutador hacia el **Modo Oscuro de Escenario** como tema secundario.

---

## 1. Visión General y Mejoras frente a LibreTracks Original

- **Qué Resuelve**:
  1. **Cero Bloqueos en Importación**: En lugar de esperar a que `IndexedDB` y `decodeAudioData` terminen secuencialmente dentro de un modal cerrado antes de mostrar las pistas, el nuevo pipeline clona los buffers de forma segura, renderiza las pistas al instante, decodifica en paralelo con retroalimentación visual pista por pista y persiste en IndexedDB en segundo plano sin bloquear la reproducción.
  2. **Ajuste Automático de Línea de Tiempo y Estructura**: LibreTracks original requiere configurar manualmente la duración en compases y crear cada marcador de sección desde cero al importar pistas nuevas. LibreTracks Web 2.0 ajusta automáticamente la longitud de compases a la duración real de los stems importados y segmenta automáticamente la canción en secciones según los cambios de energía RMS.
  3. **Navegación de Repertorio en Árbol**: Acceso directo a todo el repertorio organizado por carpetas/categorías (*Show en Vivo*, *Repertorio General*, *Sesiones Importadas*, *Demos*) con expansión de nodos para ver qué pistas y secciones contiene cada canción antes de cargarla.

---

## 2. Experiencia de Usuario y Diseño Visual

### Flujos de Usuario Clave

1. **Soltar Archivos o Carpeta en Cualquier Parte (Dropzone Global + Botón Rápido)**:
   - El usuario puede arrastrar varios archivos de audio o una carpeta completa directamente sobre la ventana (o usar el botón **+ Importar Canción / Stems**).
   - Se detecta el nombre común (por ejemplo, `Mi_Cancion - Drums.wav`, `Mi_Cancion - Bass.wav` → Canción: **Mi Cancion**), se crea y selecciona automáticamente la nueva canción en el árbol de repertorio, se ajusta el total de compases a la duración real de los audios y se autogeneran las secciones sugeridas.
   - Si el usuario desea añadir un stem suelto a la canción actual en lugar de crear una canción nueva, dispone de un botón directo **"+ Añadir Stem a esta Canción"** en la cabecera de pistas.
2. **Navegación en Árbol de Repertorio (Sidebar Izquierdo)**:
   - Un buscador en la parte superior del árbol filtra en tiempo real por título de canción, artista, tonalidad, BPM o nombre de sección/stem.
   - Los nodos del árbol muestran carpetas desplegables; al hacer clic en una canción se carga instantáneamente en la consola, y al desplegar su flecha se listan sus secciones y pistas activas.
3. **Conmutación Fluida Modo Claro (Principal) / Modo Oscuro (Secundario)**:
   - En **Modo Claro (Predeterminado)**: Lienzo en `#F8FAFC` (`bg-slate-50`), paneles de consola y árbol lateral en `#FFFFFF` (`bg-white`) con bordes sutiles de `1px` (`border-slate-200`), tipografía principal en `#0F172A` (`text-slate-900`) y formas de onda de alto contraste sobre fondo claro.
   - En **Modo Oscuro (Secundario)**: Se activa bajo demanda para escenarios con poca luz, manteniendo exactamente la misma jerarquía espacial sobre pizarra `#0B0F17` y `#111827`.

### Identidad Visual y Tema Dual (Disciplina 60-30-10)

- **Modo Claro (Primario / Default)**:
  - **60% Lienzo Dominante**: Gris alabastro técnico `#F8FAFC` (`bg-slate-50`).
  - **30% Superficies Estructurales**: Blanco puro `#FFFFFF` (`bg-white`) para el árbol de repertorio, barra de transporte y canales de mezcla, con divisores finos `#E2E8F0` (`border-slate-200`).
  - **10% Acentos Funcionales**:
    - Azul Cobalto / Cian Técnico (`#0284C7` / `#0891B2`): Selección activa en el árbol, cursor de reproducción (*Playhead*) y bus de Click/Guía.
    - Esmeralda Estudio (`#059669`): Reproducción activa y sección en curso.
    - Ámbar Escenario (`#D97706`): Salto de sección en cola (*Queued Jump*) y bucle *Vamp* activo.
    - Carmesí (`#DC2626`): Estado *Mute*, recorte de señal (*Clip*) y parada.
- **Tipografía y Disciplina Tabular**:
  - `Outfit` para encabezados y nombres de sección; `Plus Jakarta Sans` para el árbol de repertorio y controles compactos de una sola línea; `JetBrains Mono` (`tabular-nums`) para relojes de compás (`BAR : BEAT`), código de tiempo, BPM y decibelios.

---

## 3. Decisiones Técnicas y Optimizaciones Clave

- **Corrección Definitiva del Pipeline de Decodificación e IndexedDB**
  - *Causa del Problema Anterior*: Pasar el mismo `ArrayBuffer` a `IndexedDB` y simultáneamente a `audioContext.decodeAudioData()` o esperar a que todas las transacciones de base de datos terminen antes de cerrar el modal provocaba bloqueos en archivos grandes o fallos silenciosos cuando el buffer se transfería/desacoplaba (*detached ArrayBuffer*).
  - *Solución Optimizada*:
    1. Leer cada `File` y generar dos copias independientes o decodificar primero con `audioContext.decodeAudioData(buffer.slice(0))` usando concurrencia controlada (`Promise.allSettled`) para que si un archivo tiene un formato no válido no detenga el resto.
    2. Calcular la duración máxima en segundos de los stems importados y actualizar automáticamente `totalBars = Math.max(4, Math.ceil(maxDurationSec / secondsPerBar))` para que la canción completa se reproduzca de principio a fin y las formas de onda representen toda la canción.
    3. Guardar los binarios en `IndexedDB` de forma asíncrona en segundo plano (*fire-and-forget* con notificación no bloqueante) después de que el usuario ya tiene sus pistas listas y sonando en pantalla.
- **Algoritmo de Auto-Detección de Secciones por Energía RMS**
  - *Enfoque*: Una vez decodificados los stems de una nueva canción, el motor promedia la envolvente de energía por cada compás (`1..totalBars`) y detecta saltos significativos de amplitud en múltiplos de 4 u 8 compases para etiquetar automáticamente *Intro*, *Verso*, *Coro*, *Puente* y *Outro*, con un botón **"Auto-Detectar Secciones"** disponible también en cualquier momento para re-analizar según el BPM elegido.

---

## 4. Arquitectura Técnica y Estrategia de Datos

### Diagrama de Arquitectura y Componentes

```
┌───────────────────────────────────────────────────────────────────────────────────┐
│                           Barra Superior (3 Zonas)                                │
│  [LibreTracks]        [Arranger · Mixer · Stage Remote · Theme]     [+ Importar]  │
└─────────────────────────────────────────┬─────────────────────────────────────────┘
                                          │
      ┌───────────────────────────────────┴───────────────────────────────────┐
      ▼                                                                       ▼
┌───────────────────────────────┐   ┌───────────────────────────────────────────────┐
│ Árbol de Repertorio (Sidebar) │   │        Espacio de Trabajo Principal           │
│ ┌───────────────────────────┐ │   │ ┌───────────────────────────────────────────┐ │
│ │ [🔍 Buscar canción/stem]  │ │   │ │ Barra de Transporte + Reloj BAR:BEAT      │ │
│ └─────────────┬─────────────┘ │   │ │ [Play][Stop][Vamp] [001:1] [Sync][BPM/Key]│ │
│               ▼               │   │ └─────────────────────┬─────────────────────┘ │
│ ┌───────────────────────────┐ │   │                       ▼                       │
│ │ 📁 Repertorio en Vivo     │ │   │ ┌───────────────────────────────────────────┐ │
│ │  ├─ 🎵 Mi Canción Import. │ │   │ │ Arranger / Mixer / Stage Remote           │ │
│ │  │   ├─ Secciones (Auto)  │ │   │ │ • Regiones de Sección Auto-Detectadas     │ │
│ │  │   └─ 6 Stems Activos   │ │   │ │ • Formas de Onda Adaptativas (Light/Dark) │ │
│ │ 📁 Sesiones Demo          │ │   │ │ • Dropzone Global para Carpetas/Stems     │ │
│ │  ├─ 🎵 Horizonte Boreal   │ │   │ └───────────────────────────────────────────┘ │
│ │  └─ 🎵 Catedral de Luz    │ │   └───────────────────────┬───────────────────────┘
│ └───────────────────────────┘ │                           │
└───────────────┬───────────────┘                           │
                └─────────────────────┬─────────────────────┘
                                      ▼
┌───────────────────────────────────────────────────────────────────────────────────┐
│          Pipeline de Importación Instantánea y Análisis Musical (Web Audio)       │
│  ┌─────────────────────────┐  ┌────────────────────────┐  ┌────────────────────┐  │
│  │ Decodificador Paralelo  │  │ Analizador RMS por     │  │ Guardado Asíncrono │  │
│  │ No Bloqueante + Cálculo │─▶│ Compás (Auto-Secciones │─▶│ en IndexedDB en    │  │
│  │ Automático de Compases  │  │ Intro/Verso/Coro/Outro)│  │ Segundo Plano      │  │
│  └─────────────────────────┘  └────────────────────────┘  └────────────────────┘  │
└───────────────────────────────────────────────────────────────────────────────────┘
```

### Mapeo de Componentes Interactivos y Manejadores de Estado

- **Árbol Lateral de Repertorio (`RepertoireTreeSidebar`)**:
  - Permite filtrar canciones en vivo por texto, agrupar por carpetas/categorías (*Mis Canciones Importadas*, *Repertorio en Vivo*, *Demos Incluidos*), expandir/colapsar carpetas y canciones para inspeccionar sus stems y secciones, renombrar o duplicar canciones, exportar/importar `.libretracks.json` y plegar el panel lateral cuando se desee maximizar el área de formas de onda.
- **Importador Instantáneo y Auto-Analizador (`instantImportPipeline`)**:
  - Acepta tanto selección múltiple de archivos como arrastrar y soltar archivos/carpetas en cualquier parte de la aplicación.
  - Si se sueltan 2 o más archivos (o si el modo predeterminado "Nueva Canción al Importar" está activo), extrae automáticamente el título de la canción a partir del nombre de la carpeta o prefijo común de los archivos, crea la nueva canción, decodifica todos los stems mostrando el avance en tiempo real, ajusta `totalBars` a la duración exacta del audio más largo y ejecuta `detectSmartSectionsFromBuffers()` para poblar la línea de tiempo con secciones listas para usar.
- **Sistema de Tema Claro Primario / Oscuro Secundario**:
  - Persiste la preferencia en `localStorage` con `'light'` como valor inicial predeterminado. Todos los lienzos `<canvas>` de formas de onda y medidores VU leen el estado del tema para renderizar grillas, cursores y envolventes con contraste óptimo tanto en blanco diurno como en modo oscuro de escenario.
