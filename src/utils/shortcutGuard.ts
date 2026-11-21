/**
 * Decide si un atajo global de teclado (Espacio, V, 1-9) debe actuar o dejar la tecla al control que tiene el foco.
 * Función pura sobre el evento y el elemento: se prueba sin navegador (`test/shortcutGuard.test.ts`).
 */

export interface ShortcutTarget {
  tagName: string;
  isContentEditable?: boolean;
  getAttribute(name: string): string | null;
  /** `closest` del DOM; solo se usa para detectar un diálogo abierto. */
  closest?(selector: string): unknown;
  /** `matches` del DOM; solo se usa para `:focus-visible` (foco llegado por teclado). */
  matches?(selector: string): boolean;
}

export interface ShortcutEvent {
  code: string;
  key: string;
  repeat: boolean;
  defaultPrevented: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  target: ShortcutTarget | null;
}

const TEXT_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT']);
const NATIVE_SPACE_TAGS = new Set(['BUTTON', 'A', 'SUMMARY']);
const NATIVE_SPACE_ROLES = new Set(['button', 'checkbox', 'switch', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'tab', 'radio', 'slider', 'option']);

function hasKeyboardFocus(t: ShortcutTarget): boolean {
  try {
    return t.matches?.(':focus-visible') ?? false;
  } catch {
    // catch-ok: un navegador sin :focus-visible (selector no soportado) simplemente no lo cumple
    return false;
  }
}

/** `true` si el atajo global debe ejecutarse. */
export function shouldRunGlobalShortcut(e: ShortcutEvent): boolean {
  // Otro manejador ya usó la tecla, o es una combinación del navegador o de la app (Ctrl+V pegar, Ctrl+Mayús+D…).
  if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return false;
  // Mantener pulsada la tecla no debe repetir órdenes de transporte.
  if (e.repeat) return false;
  const t = e.target;
  if (!t) return true;
  if (TEXT_TAGS.has(t.tagName) || t.isContentEditable) return false;
  // Con un diálogo abierto, las teclas son del diálogo.
  if (t.closest?.('dialog[open]')) return false;
  // Espacio sobre un botón u otro control al que se llegó con el teclado: activa ese control, no el transporte.
  // Tras un clic con el ratón el botón no tiene «foco visible», así que Espacio sigue siendo reproducir/pausar.
  if (e.code === 'Space') {
    const role = t.getAttribute('role');
    const interactive = NATIVE_SPACE_TAGS.has(t.tagName) || (role != null && NATIVE_SPACE_ROLES.has(role));
    if (interactive && hasKeyboardFocus(t)) return false;
  }
  return true;
}
