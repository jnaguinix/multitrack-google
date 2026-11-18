import React, { useEffect, useRef } from 'react';
import { X, type LucideIcon } from 'lucide-react';

/**
 * Diálogo modal de la aplicación, sobre el elemento nativo `<dialog>` (`showModal()`).
 *
 * El navegador aporta lo que antes había que reescribir en cada ventana: el fondo queda inerte, el foco no sale del
 * diálogo, Escape lo cierra y se dibuja en la capa superior, por encima de cualquier `z-index`. Aquí solo se añade lo
 * propio de OmniTracks: aspecto, tamaños, cierre al pulsar fuera y devolver el foco a quien lo abrió.
 *
 * Se monta cuando hay que mostrarlo y se desmonta al cerrarlo (como los modales anteriores); `onClose` es quien
 * decide qué significa «cerrar» (Escape, el fondo o la X). El foco inicial es el primer elemento enfocable, o el que
 * lleve `data-autofocus`.
 */
export type DialogSize = 'sm' | 'md' | 'lg' | 'xl' | 'fill';

interface DialogProps {
  /** Nombre accesible del diálogo (lo lee el lector de pantalla). */
  label: string;
  onClose: () => void;
  /** Ancho máximo: sm 420 px, md 520 px, lg 720 px, xl 880 px, fill 1440 px. */
  size?: DialogSize;
  /** `bottom` pega el panel al borde inferior (consola flotante). */
  placement?: 'center' | 'bottom';
  /** Cerrar al hacer clic fuera del panel. */
  dismissOnBackdrop?: boolean;
  /** Cerrar con Escape (por defecto sí). Un diálogo con un proceso en curso puede pedir confirmación en su `onClose`. */
  dismissOnEscape?: boolean;
  className?: string;
  children: React.ReactNode;
}

export const Dialog: React.FC<DialogProps> = ({
  label,
  onClose,
  size = 'md',
  placement = 'center',
  dismissOnBackdrop = false,
  dismissOnEscape = true,
  className,
  children,
}) => {
  const ref = useRef<HTMLDialogElement | null>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (!dialog.open) dialog.showModal();
    dialog.querySelector<HTMLElement>('[data-autofocus]')?.focus();
    return () => {
      if (dialog.open) dialog.close();
      // Quien abrió el diálogo recupera el foco (si sigue en pantalla): el teclado no se pierde en el cuerpo de la página.
      if (opener && opener.isConnected) opener.focus({ preventScroll: true });
    };
  }, []);

  return (
    <dialog
      ref={ref}
      aria-label={label}
      className="lt-dialog"
      data-placement={placement}
      onCancel={(event) => {
        // El navegador cerraría el diálogo por su cuenta: lo decide `onClose`, que es quien lo desmonta.
        event.preventDefault();
        if (dismissOnEscape) onClose();
      }}
      onClick={(event) => {
        // El área vacía alrededor del panel es el propio <dialog>: un clic ahí es un clic en el fondo.
        if (dismissOnBackdrop && event.target === event.currentTarget) onClose();
      }}
    >
      <div className={`lt-dialog-panel${className ? ` ${className}` : ''}`} data-size={size}>
        {children}
      </div>
    </dialog>
  );
};

interface DialogHeaderProps {
  title: React.ReactNode;
  description?: React.ReactNode;
  icon?: LucideIcon;
  /** Color del icono: `danger` para lo destructivo, `warning` para un aviso. */
  tone?: 'danger' | 'warning';
  /** Si se indica, se muestra la X de cierre. */
  onClose?: () => void;
  /** Acciones extra a la derecha de la X (por ejemplo «Restablecer»). */
  actions?: React.ReactNode;
}

export const DialogHeader: React.FC<DialogHeaderProps> = ({ title, description, icon: Icon, tone, onClose, actions }) => (
  <header className="lt-dialog-header">
    {Icon && <Icon size={18} aria-hidden="true" className="lt-dialog-icon" data-tone={tone} />}
    <div className="lt-dialog-heading">
      <h2>{title}</h2>
      {description && <p>{description}</p>}
    </div>
    {actions}
    {onClose && (
      <button type="button" className="lt-control lt-icon-control lt-dialog-close" aria-label="Cerrar" onClick={onClose}>
        <X size={17} aria-hidden="true" />
      </button>
    )}
  </header>
);

/** Cuerpo con desplazamiento propio: el encabezado y los botones se quedan fijos. */
export const DialogBody: React.FC<{ className?: string; children: React.ReactNode }> = ({ className, children }) => (
  <div className={`lt-dialog-body${className ? ` ${className}` : ''}`}>{children}</div>
);

/** Botones de acción, alineados a la derecha (la acción principal va la última). */
export const DialogFooter: React.FC<{ className?: string; children: React.ReactNode }> = ({ className, children }) => (
  <footer className={`lt-dialog-footer${className ? ` ${className}` : ''}`}>{children}</footer>
);
