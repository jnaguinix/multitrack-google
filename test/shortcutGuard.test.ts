import assert from 'node:assert/strict';
import { shouldRunGlobalShortcut, type ShortcutEvent, type ShortcutTarget } from '../src/utils/shortcutGuard';

function el(tag: string, opts: { role?: string; kbFocus?: boolean; inDialog?: boolean; editable?: boolean } = {}): ShortcutTarget {
  return {
    tagName: tag,
    isContentEditable: opts.editable,
    getAttribute: (n) => (n === 'role' ? opts.role ?? null : null),
    closest: (sel) => (sel === 'dialog[open]' && opts.inDialog ? {} : null),
    matches: (sel) => sel === ':focus-visible' && !!opts.kbFocus,
  };
}
function ev(over: Partial<ShortcutEvent> = {}): ShortcutEvent {
  return { code: 'Space', key: ' ', repeat: false, defaultPrevented: false, ctrlKey: false, metaKey: false, altKey: false, target: el('BODY'), ...over };
}

assert.equal(shouldRunGlobalShortcut(ev()), true, 'Espacio sobre el cuerpo reproduce');
assert.equal(shouldRunGlobalShortcut(ev({ target: null })), true);
assert.equal(shouldRunGlobalShortcut(ev({ target: el('INPUT') })), false, 'campo de texto');
assert.equal(shouldRunGlobalShortcut(ev({ target: el('DIV', { editable: true }) })), false);
assert.equal(shouldRunGlobalShortcut(ev({ target: el('BUTTON', { kbFocus: true }) })), false, 'botón con foco de teclado: lo activa el botón');
assert.equal(shouldRunGlobalShortcut(ev({ target: el('DIV', { role: 'tab', kbFocus: true }) })), false, 'rol interactivo');
assert.equal(shouldRunGlobalShortcut(ev({ target: el('BUTTON', { kbFocus: false }) })), true, 'botón tras un clic de ratón: Espacio sigue siendo transporte');
assert.equal(shouldRunGlobalShortcut(ev({ code: 'KeyV', key: 'v', target: el('BUTTON', { kbFocus: true }) })), true, 'V no activa botones');
assert.equal(shouldRunGlobalShortcut(ev({ code: 'Digit3', key: '3', target: el('BUTTON', { kbFocus: true }) })), true);
assert.equal(shouldRunGlobalShortcut(ev({ target: el('DIV', { inDialog: true }) })), false, 'diálogo abierto');
assert.equal(shouldRunGlobalShortcut(ev({ repeat: true })), false, 'sin repetición');
assert.equal(shouldRunGlobalShortcut(ev({ defaultPrevented: true })), false);
assert.equal(shouldRunGlobalShortcut(ev({ code: 'KeyV', key: 'v', ctrlKey: true })), false, 'Ctrl+V no es vamp');
assert.equal(shouldRunGlobalShortcut(ev({ code: 'KeyD', key: 'D', ctrlKey: true })), false, 'Ctrl+Mayús+D es del diagnóstico');
console.log('shortcutGuard.test.ts OK');
