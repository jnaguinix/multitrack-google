import React, { useEffect, useRef } from 'react';
import { Check, type LucideIcon } from 'lucide-react';
import { menuIndexByInitial, nextMenuIndex } from '../../utils/menuNavigation';

/**
 * Menú desplegable de la aplicación: el `popover` nativo (se cierra con Escape o al pulsar fuera y devuelve el foco al
 * botón que lo abrió) más lo que le faltaba para ser un menú de verdad: al abrirse enfoca la primera opción y se
 * recorre con ↑ ↓, Inicio, Fin y la primera letra. Tab lo cierra.
 *
 * Se abre desde un botón con `popoverTarget={id}`.
 */
const ITEM_SELECTOR = '[role="menuitem"], [role="menuitemradio"]';

function items(menu: HTMLElement): HTMLElement[] {
  return Array.from(menu.querySelectorAll<HTMLElement>(ITEM_SELECTOR));
}

function isDisabled(item: HTMLElement): boolean {
  return item.hasAttribute('disabled') || item.getAttribute('aria-disabled') === 'true';
}

interface PopoverMenuProps {
  id: string;
  label: string;
  className?: string;
  children: React.ReactNode;
  onClick?: React.MouseEventHandler<HTMLDivElement>;
}

export const PopoverMenu: React.FC<PopoverMenuProps> = ({ id, label, className, children, onClick }) => {
  const ref = useRef<HTMLDivElement | null>(null);

  const focusItem = (index: number) => {
    const menu = ref.current;
    if (!menu || index < 0) return;
    items(menu)[index]?.focus();
  };

  // Al abrirse, el foco entra en el menú (el cierre lo devuelve el propio popover). Escuchador nativo: React no engancha
  // `onToggle` en un <div>, solo en <details> y <dialog>.
  useEffect(() => {
    const menu = ref.current;
    if (!menu) return;
    const onToggle = () => {
      if (!menu.matches(':popover-open')) return;
      const list = items(menu);
      const first = nextMenuIndex(list.map(isDisabled), -1, 'ArrowDown');
      if (first >= 0) list[first].focus();
    };
    menu.addEventListener('toggle', onToggle);
    return () => menu.removeEventListener('toggle', onToggle);
  }, []);

  return (
    <div
      ref={ref}
      id={id}
      popover="auto"
      role="menu"
      aria-label={label}
      className={`lt-popover lt-menu${className ? ` ${className}` : ''}`}
      onClick={onClick}
      onKeyDown={(event) => {
        const menu = ref.current;
        if (!menu) return;
        const list = items(menu);
        const disabled = list.map(isDisabled);
        const current = list.findIndex((item) => item === document.activeElement);

        if (event.key === 'Tab') {
          event.preventDefault();
          menu.hidePopover();
          return;
        }
        if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
          event.preventDefault();
          focusItem(nextMenuIndex(disabled, current, event.key));
          return;
        }
        if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
          const index = menuIndexByInitial(list.map((item) => item.textContent ?? ''), disabled, current, event.key);
          if (index >= 0) {
            event.preventDefault();
            focusItem(index);
          }
        }
      }}
    >
      {children}
    </div>
  );
};

interface MenuItemProps {
  label: string;
  /** Icono a la izquierda (16 px). */
  icon?: LucideIcon;
  /** Contenido propio a la izquierda en lugar del icono (por ejemplo la insignia de una sección). */
  leading?: React.ReactNode;
  title?: string;
  /** Acción destructiva: se pinta en rojo. */
  danger?: boolean;
  disabled?: boolean;
  /** Opción de una lista de la que se elige una (por ejemplo «Al terminar»): muestra la marca en la elegida. */
  checked?: boolean;
  /** Se llama al elegir la opción; el menú se cierra antes. */
  onSelect: () => void;
}

export const MenuItem: React.FC<MenuItemProps> = ({ label, icon: Icon, leading, title, danger = false, disabled = false, checked, onSelect }) => (
  <button
    type="button"
    role={checked === undefined ? 'menuitem' : 'menuitemradio'}
    aria-checked={checked}
    // Solo se llega con las flechas (la posición la lleva el menú), como en cualquier menú del sistema.
    tabIndex={-1}
    title={title}
    disabled={disabled}
    data-danger={danger || undefined}
    onClick={(event) => {
      event.currentTarget.closest<HTMLElement>('[popover]')?.hidePopover();
      onSelect();
    }}
    className="lt-menu-item"
  >
    {checked !== undefined ? <span className="lt-menu-check">{checked && <Check size={15} aria-hidden="true" />}</span> : leading ?? (Icon && <Icon size={16} aria-hidden="true" />)}
    <span>{label}</span>
  </button>
);

export const MenuSeparator: React.FC = () => <div role="separator" className="lt-menu-separator" />;

/** Título de un grupo de opciones dentro del menú (no se enfoca). */
export const MenuLabel: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div role="presentation" className="lt-menu-label">{children}</div>
);
