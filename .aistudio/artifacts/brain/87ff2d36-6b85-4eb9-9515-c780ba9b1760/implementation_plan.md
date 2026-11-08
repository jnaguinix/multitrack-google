# Plan de Optimización Profunda: Carga Instantánea en Setlist, Caché en RAM y Bloqueo de Reproducción

## ¿Cuánta RAM ocupan 6 canciones de 8 minutos (10 stems) y por qué tardaba 30 segundos?
1. **Cálculo real de memoria RAM**:
   - Un stem de 8 minutos decodificado en estéreo a 48 kHz (Float32) ocupa `480s × 48,000 × 2 canales × 4 bytes` ≈ **184 MB**. Diez stems en estéreo ocupan **~1.8 GB por canción**.
   - Sin embargo, la mayoría de los stems (Click, Cues, Bajo, Bombo, Tarola, Voz, Guitarras mono) tienen ambos canales idénticos (mono). Al optimizar automáticamente pistas mono a 1 canal en memoria, cada canción de 10 stems baja a **~650 MB – 900 MB**, permitiendo mantener **hasta 6 canciones completas en RAM (~4 GB)** sin saturar el navegador.
2. **Causas raíz de los 3 problemas detectados**:
   - **Por qué tardaba 30 segundos al cambiar de canción**: Cada vez que cambiabas de canción en el Setlist, el motor borraba los `AudioBuffer` de la RAM (`trackBuffers.clear()`), volvía a leer cientos de megabytes de IndexedDB y decodificaba los 10 stems **uno por uno en serie**. Además, si un stem tardaba en leer de IndexedDB, entraba por error al sintetizador de demos generando 23 millones de muestras en el hilo principal.
   - **Por qué a veces faltaban instrumentos**: Al importar 10 archivos grandes al mismo tiempo, se abrían 10 transacciones separadas en IndexedDB sin esperar a que terminaran y sin guardar los `AudioBuffer` en un caché persistente en memoria.
   - **Por qué empezaba a sonar sola de repente**: Existía una condición de carrera asíncrona cuando una carga pesada tardaba varios segundos; al terminar, disparaba el evento de reproducción o transición automática con retraso.

---

## Solución a Implementar

### 1. Caché Granular Inteligente en RAM por `songId` (Independiente del Orden del Setlist)
- **Caché en Memoria (`SetlistRamCache`) por ID de canción (hasta 6 canciones)**:
  - Guardaremos los `AudioBuffer` ya decodificados en un diccionario en RAM indexado por el `id` de la canción (`Map<songId, Map<trackId, AudioBuffer>>`).
  - **Reordenar el Setlist toma 0 ms**: Como el caché está asociado al `id` de cada canción y no a su posición, puedes cambiar el orden de las canciones libremente sin recargar nada.
  - **Cambio entre canciones en 0.01 segundos**: Cuando seleccionas una canción que ya está en el caché de RAM, el motor conecta los nodos instantáneamente sin volver a decodificar ni leer del disco.
- **Precarga Granular en Segundo Plano (Lookahead Worker)**:
  - Cuando agregas canciones al Setlist o seleccionas la canción `1`, un proceso silencioso en segundo plano irá precargando en RAM la **canción actual y las siguientes del Setlist** una por una sin bloquear la interfaz, mostrando un indicador en cada tarjeta del Setlist:
    - `● En RAM (Lista 0ms)` (verde)
    - `◐ Precargando X/10...` (ámbar)

### 2. Optimización de Decodificación Paralela y Escritura Atómica en IndexedDB
- **Eliminación total del sintetizador de respaldo**: Nunca más se ejecutará el sintetizador en canciones del usuario.
- **Escritura en una sola transacción por lotes (`saveStemsBatchToDb`)**: Al importar una canción de 10 stems, los 10 archivos quedan inmediatamente en el `SetlistRamCache` de memoria RAM y se guardan en IndexedDB en un lote seguro para futuras sesiones.
- **Optimización de RAM en Stems Mono**: Si un stem estéreo tiene información idéntica en L y R, se almacena como `AudioBuffer` de 1 canal para reducir a la mitad el consumo de RAM y permitir alojar cómodamente 6 canciones largas simultáneas.

### 3. Bloqueo Estricto de Play al 100% y Cero Reproducción Espontánea
- **Candado de Carga (`isMountingSong`)**: Mientras una canción esté decodificando sus pistas por primera vez, el botón **Play** estará bloqueado con una barra de progreso exacta (`"Cargando pistas en RAM: 6/10..."`) hasta que **los 10 stems estén 100% verificados y conectados**.
- **Nunca sonar sin clic explícito**:
  - Se elimina cualquier `play()` automático diferido tras terminar de cargar.
  - La transición por defecto del Setlist queda en **Preparar siguiente en pausa (00:00)** o **Parar**, y se añade un identificador de generación (`loadRequestId`) que cancela cualquier carga anterior si cambias rápido de canción.
