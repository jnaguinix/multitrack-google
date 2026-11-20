/**
 * Efecto de importación: instala el registro de comandos del modo diagnóstico. Va importado en `main.tsx` justo
 * después de `installPreview` y antes de `App`, porque algunos módulos guardan una referencia a `invoke` al cargarse
 * y, si el envoltorio llegara tarde, sus comandos no se anotarían.
 */
import { installInvokeTrace } from './invokeTrace';

installInvokeTrace();
