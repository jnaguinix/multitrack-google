# LibreTracks Web — Integración del Nuevo Mixer de Estudio en Modo Oscuro

Integración fiel del rediseño de consola mezcladora (**LibreTracks · Mixer**) adaptado al **Modo Oscuro definitivo** de la aplicación, conectado en tiempo real al motor **Web Audio API** y disponible tanto en la vista **Mixer** de pantalla completa como en un **panel acoplable inferior dentro del Arranger**.

## Decisiones Confirmadas y Revisión del Usuario

> [!IMPORTANT]
> Estas decisiones fueron confirmadas por el usuario y definen el alcance exacto de la integración.

- **Doble Ubicación (Vista Dedicada + Dock en Arranger)**: El nuevo Mixer reemplaza por completo al mezclador anterior en la pestaña **Mixer** y además puede desplegarse/ocultarse como un **panel inferior acoplado dentro de la vista Arranger** para mezclar mientras se visualizan las formas de onda y secciones.
- **Canales Individuales de Click y Cues + 2 Buses Maestros a la Derecha**: En la sección izquierda de canales se incluyen todas las pistas de la canción junto con los canales individuales de **Click** y **Cues** (`#22d3ee`, ruteados a `Click / Cue`), mientras que a la derecha (separados por divisor vertical de `2px`) se sitúan los dos buses maestros de salida: **Main L/R** (*"Salida principal"*, `#f59e0b`) y **Click / Cue** (*"Auriculares banda"*, `#22d3ee`).
- **Modo Oscuro Nativo Unificado**: Se aplica la paleta oscura exacta del diseño de referencia (`--bg: #0e1118`, `--panel: #151a24`, `--strip: #171d29`, `--line: #252d3c`, `--track: #0a0d13`, `--accent: #2fd0c8`, `--solo: #ffc233`, `--mute: #ff5a50`) acoplada con la barra superior y el árbol lateral de repertorio.

---

## 1. Anatomía Visual e Interactiva del Nuevo Mixer

Siguiendo al milímetro la referencia HTML/CSS proporcionada (`/public/assets/aistudio/LibreTracks___Mixer_redise_ado_d57940d0.html`):

1. **Tiras de Canal Compactas (`84px` de ancho) y Buses (`104px` de ancho)**:
   - Borde superior de color de `4px` (`cap`) identificado con el color semántico de cada pista (`--c`).
   - Estado de atenuación visual automática (`.dim` con `opacity: 0.38`) cuando un canal está en `Mute` o cuando otro canal tiene `Solo` activo.
2. **Perilla Giratoria de Paneo (`Knob` de `38x38px`)**:
   - Indicador radial giratorio (`--r` de `-135°` a `+135°`) con lectura inferior (`C`, `L30`, `R35`).
   - Soporte completo de `setPointerCapture` para arrastrar verticalmente con suavidad, **doble clic para centrar en `C` (0)** y ajuste fino con flechas del teclado (`ArrowUp`/`ArrowDown`).
3. **Fader Vertical Personalizado + Escala dB + Doble Medidor Estéreo L/R**:
   - Escala logarítmica/lineal de `-60 dB` a `+6 dB` (`+6`, `0`, `-10`, `-20`, `-40`, `-∞`) con imán suave (*snap*) en `0.0 dB` al arrastrar cerca del centro y **doble clic en el fader para volver a `0.0 dB`**.
   - Pista de fader de `6px` en `#0a0d13` con relleno dinámico (`.fill`) del color del canal y manija táctil (`.handle` de `26px` en canales y `32px` en buses) con línea central del color de la pista.
   - **Par de Medidores VU Estéreo (L/R de `8px` cada uno)** con gradiente continuo (`linear-gradient(to top, #2fd07a 0%, #2fd07a 62%, #ffc233 82%, #ff5a50 100%)`) y máscara superior animada a 60fps alimentada directamente por los `AnalyserNode` reales del motor Web Audio API.
4. **Lectura en Decibelios, Botones `M / S` y Conmutador de Bus**:
   - Casilla `.db` con tipografía tabular mostrando el valor exacto (`-0.9 dB`, `+1.2 dB`, `-∞ dB`).
   - Cuadrícula `.ms` de dos botones (`M` en rojo `#ff5a50` al activarse, `S` en ámbar `#ffc233` al activarse).
   - Botón inferior `.route` que alterna con un clic entre **`Main L/R`** y **`Click / Cue`** (resaltado con tinte cian `color-mix(in srgb, #2fd0c8 18%, #151a24)` y borde `#2fd0c8` cuando está asignado a `Click / Cue`).

---

## 2. Arquitectura Técnica y Acoplamiento con el Motor de Audio

```
┌───────────────────────────────────────────────────────────────────────────────────┐
│                        Vista Arranger (con Dock) / Vista Mixer                    │
│  ┌───────────────────────────────────────────────────────┬─────────────────────┐  │
│  │ Sección Canales (#channels · Scroll Horizontal)       │ Buses (#buses · 2px)│  │
│  │ ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐   │ ┌────────┐ ┌──────┐ │  │
│  │ │  Drums   │ │   Bass   │ │  Click   │ │   Cues   │   │ │Main L/R│ │Click/│ │  │
│  │ │ [Knob C] │ │ [Knob L] │ │ [Knob C] │ │ [Knob C] │   │ │ Salida │ │ Cue  │ │  │
│  │ │  ┃ ▐▌▐▌  │ │  ┃ ▐▌▐▌  │ │  ┃ ▐▌▐▌  │ │  ┃ ▐▌▐▌  │   │ │ ┃ ▐▌▐▌ │ │┃ ▐▌▐▌│ │  │
│  │ │ -0.9 dB  │ │ -1.1 dB  │ │ -1.4 dB  │ │ -1.4 dB  │   │ │ 0.0 dB │ │-3 dB │ │  │
│  │ │ [M]  [S] │ │ [M]  [S] │ │ [M]  [S] │ │ [M]  [S] │   │ └────────┘ └──────┘ │  │
│  │ │[Main L/R]│ │[Main L/R]│ │[Click/Cue│ │[Click/Cue│   │                     │  │
│  │ └──────────┘ └──────────┘ └──────────┘ └──────────┘   │                     │  │
│  └───────────────────────────────────────────────────────┴─────────────────────┘  │
└─────────────────────────────────────────┬─────────────────────────────────────────┘
                                          ▼
┌───────────────────────────────────────────────────────────────────────────────────┐
│                     Conversión Exacta dB ↔ Ganancia Lineal                        │
│   • Fader (-60 dB a +6 dB) ──▶ gain = 10^(dB / 20) (con snap en 0.0 dB = 1.0)     │
│   • Medidores L/R 60fps ──▶ Niveles reales por pista + buses Main L/R y Click/Cue │
└───────────────────────────────────────────────────────────────────────────────────┘
```

### Mapeo de Estado y Conversión de Señal

- **Conversión Bidireccional Decibelios (`-60 dB` a `+6 dB`) ↔ Ganancia Web Audio (`0.0` a `2.0`)**:
  - `dbToGain(db)`: Si `db === -Infinity` o `db <= -60`, retorna `0`; en caso contrario retorna `Math.pow(10, db / 20)`. Ainsi `0.0 dB` corresponde exactamente a ganancia unitaria `1.0`, y `+6.0 dB` a `~1.995`.
  - `gainToDb(gain)`: Si `gain <= 0.001`, retorna `-Infinity`; en caso contrario `20 * Math.log10(gain)` acotado entre `-60` y `+6`.
- **Sincronización con Canales de Click y Cues**:
  - Los canales virtuales **Click** y **Cues** en la sección de canales controlan directamente `project.clickGain` / `project.clickEnabled` y `project.guideGain` / `project.guideCuesEnabled`, mientras que el bus derecho **Click / Cue** actúa como fader maestro del bus de auriculares/monitoreo de la banda (`cueBusMasterGain`) y **Main L/R** controla `project.masterGain`.
- **Panel Acoplable en Arranger**:
  - En la barra inferior del **Arranger** (y junto a los controles de vista) se incluye un botón **"Mostrar Consola Mixer"** que despliega el nuevo Mixer en la mitad inferior de la pantalla sin salir de la línea de tiempo multipista.
