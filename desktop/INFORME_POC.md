
# Informe del PoC LibreTracks Desktop

Banco local en Windows x64, Tauri 2.12.5 y WebView2 157. La prueba de reproducción usó cuatro WAV sintéticos de 45 s y dos clientes Chrome en el mismo equipo. «No medido» indica que no hay evidencia de ejecución para ese caso.

## Preguntas de decisión

| Pregunta | Respuesta | Evidencia |
|---|---|---|
| 1. ¿Igual estabilidad con 20 pistas en Chrome y Tauri? | No medido | Falta la comparación de 15 min en el equipo del baterista. La prueba corta de WebView2 registró ocho underruns. |
| 2. ¿Funcionan OPFS en Worker, IndexedDB, AudioContext y scheduler? | Sí, en la prueba local | WebView2 escribió y leyó OPFS con `createSyncAccessHandle` en un Worker y escribió y leyó IndexedDB. LibreTracks reprodujo cuatro pistas con modo efectivo streaming, handles síncronos activos, 64 lecturas y cero errores de lectura. Se observó el salto cuantizado durante la reproducción. |
| 3. ¿Se puede seleccionar salida y separar música/click? | Parcial | El código usa la salida predeterminada de Windows y ofrece Split-Mono en un único dispositivo estéreo. Verificación física no medida. |
| 4. ¿Qué pasa con la biblioteca de Netlify? | Parcial | Un perfil nuevo de WebView2 abrió la biblioteca vacía. El JSON sintético restauró cuatro pistas descritas, 113 BPM, una sección y ganancia 0,33. El nuevo proyecto quedó con cero registros de audio. Migración desde una biblioteca real de Netlify no medida. |
| 5. ¿Funciona el flujo completo sin Internet y con QR? | Parcial | El ejecutable abrió el contenido local y dos navegadores del mismo equipo se emparejaron mediante las URL de los QR. El transporte siguió al detener el servidor y durante la desconexión emulada en WebView2. Arranque con WAN desconectada y escaneo desde teléfonos físicos no medidos. |
| 6. ¿Funciona File System Access? | Parcial | WebView2 expuso ambos métodos y abrió el selector nativo de archivos. El selector terminó con otro archivo en el perfil aislado y se descartó esa ejecución como evidencia. Selección de carpeta, lectura de handles importados y permisos tras reabrir no medidos. La ruta de importación clásica cargó los WAV de prueba. |
| 7. ¿Cómo actúa el firewall en Público y Privado? | No medido | El acceso desde otro equipo y ambos perfiles de red quedan para el banco físico. |

## Matriz

| Prueba | Resultado |
|---|---|
| Build web, build escritorio x64 y pruebas de protocolo | Pasaron TypeScript, ambos builds y cinco pruebas Rust. El build web excluye el puente. |
| 20 pistas durante 15 min, Chrome vs Tauri, glitches, underruns, RAM, CPU y estadísticas | No medido. La muestra corta de WebView2 tenía ocho underruns antes del salto y seguía en ocho con los dos clientes activos. Glitches audibles, CPU y RAM no medidos. |
| Cambio preparado, tiempo hasta sonido | No medido. |
| Setlist de seis canciones, RAM inicial y final | No medido. |
| Elección de salida y Split-Mono en interfaz física | No medido. |
| Cierre y reapertura, biblioteca y caché | El proyecto de prueba y el indicador PCM reaparecieron en el mismo perfil tras reabrir. |
| Servidor apagado vs 3–5 celulares, CPU y audio | No medido con celulares. Con dos clientes locales se aplicaron mute y ganancia mientras avanzaba el transporte. El acuse tardó 139 ms en cada comando, incluido el IPC. |
| Cortar WAN y Wi-Fi mientras suena | Continuó el transporte al apagar el listener y emular la desconexión de WebView2. Cortes físicos no medidos. |
| Desconectar celular, reiniciar router y enviar mensajes inválidos | Revocación, reconexión, cliente lento, mensajes inválidos y cola llena verificados en tests locales. Celular y router físicos no medidos. |
| Sonidista intenta detener, cambiar canción o configuración | Rechazado en las pruebas WebSocket. |
| Músico intenta enviar comandos | Rechazado en las pruebas WebSocket. |

## Problemas y decisión

Antes del salto, Chrome 156 y WebView2 157 registraron ocho underruns cada uno con los mismos WAV sintéticos. La prueba en Chrome llegó hasta ese punto y el salto comparativo quedó sin medir. En WebView2, el contador se mantuvo en ocho al ejecutar el salto y durante la sesión LAN corta. La comparación física determinará si los underruns corresponden a audio audible y si WebView2 se comporta distinto a Chrome durante el set completo.

Continuar la validación de Tauri en el portátil real. El paso a mezclador completo, instalador y updater firmado depende de aprobar estabilidad, APIs y salida física, y de comprobar que los clientes LAN no añaden glitches ni underruns. Si alguna de esas tres pruebas falla, repetir el protocolo con Electron. El JSON actual ya evidencia que recuperar una biblioteca exige transportar el audio por separado. Priorizar una exportación e importación completa antes de migrar un repertorio real.
