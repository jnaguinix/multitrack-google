/**
 * Navegación con teclado de un menú (flechas, Inicio/Fin y primera letra). Son funciones puras sobre una lista de
 * opciones, para probarlas sin la interfaz; `components/ui/Menu.tsx` las aplica al DOM.
 */

/** Índice de la siguiente opción habilitada al pulsar `key`. `current` es -1 si ninguna tiene el foco. */
export function nextMenuIndex(disabled: readonly boolean[], current: number, key: string): number {
  const count = disabled.length;
  if (count === 0 || disabled.every(Boolean)) return -1;

  const firstEnabled = () => disabled.findIndex((d) => !d);
  const lastEnabled = () => disabled.length - 1 - [...disabled].reverse().findIndex((d) => !d);
  if (key === 'Home') return firstEnabled();
  if (key === 'End') return lastEnabled();

  const step = key === 'ArrowUp' ? -1 : key === 'ArrowDown' ? 1 : 0;
  if (step === 0) return current;
  // Sin foco previo: ↓ va a la primera y ↑ a la última. Después se da la vuelta por los extremos.
  if (current < 0) return step === 1 ? firstEnabled() : lastEnabled();
  for (let i = 1; i <= count; i++) {
    const candidate = (((current + step * i) % count) + count) % count;
    if (!disabled[candidate]) return candidate;
  }
  return current;
}

/**
 * Opción cuyo texto empieza por `char` (sin distinguir mayúsculas ni acentos), buscando a partir de la siguiente a
 * `current` para poder recorrer varias que empiecen igual. -1 si ninguna coincide.
 */
export function menuIndexByInitial(labels: readonly string[], disabled: readonly boolean[], current: number, char: string): number {
  const norm = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  const wanted = norm(char);
  if (wanted.length !== 1 || wanted === ' ') return -1;
  for (let i = 1; i <= labels.length; i++) {
    const candidate = (((current + i) % labels.length) + labels.length) % labels.length;
    if (!disabled[candidate] && norm(labels[candidate].trim()).startsWith(wanted)) return candidate;
  }
  return -1;
}
