import { describeError } from './debugMode';

/**
 * Texto de un fallo de pantalla listo para pegar o guardar: qué error fue, dónde ocurrió (pila de componentes de
 * React) y, debajo, el diagnóstico completo (caja negra y registro del modo diagnóstico). Es una función pura para
 * poder probarla sin interfaz; quien la llama le pasa el diagnóstico ya armado.
 */
export function crashReportText(error: unknown, componentStack: string | null | undefined, diagnostic: string): string {
  const stack = error instanceof Error && error.stack ? error.stack : '(sin pila)';
  return [
    `OmniTracks · fallo de pantalla · ${new Date().toISOString()}`,
    `error: ${describeError(error)}`,
    '--- pila del error ---',
    stack,
    '--- componentes (de dentro hacia fuera) ---',
    componentStack?.trim() || '(no disponible)',
    '',
    diagnostic,
  ].join('\n');
}
