import { useEffect } from 'react';
import { audioEngine } from '../audio/audioEngine';
import { SongProject } from '../types/project';
import { shouldRunGlobalShortcut } from '../utils/shortcutGuard';

/**
 * Atajos globales de teclado: Espacio = reproducir/pausar, V = vamp, 1-9 = saltar a la sección N.
 * Se ignoran al escribir en un campo, con un diálogo abierto, con Ctrl/Alt/Meta, al mantener la tecla pulsada y,
 * para Espacio, cuando el foco llegó por teclado a un botón (ese botón lo activa; ver `shortcutGuard.ts`). Con `jumpsLockedRef` activo
 * (En vivo con los saltos bloqueados) las teclas 1-9 no hacen nada.
 */
export function useStudioShortcuts(
  currentProjectRef: React.MutableRefObject<SongProject | null>,
  jumpsLockedRef: React.MutableRefObject<boolean>
): void {
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!shouldRunGlobalShortcut({ code: e.code, key: e.key, repeat: e.repeat, defaultPrevented: e.defaultPrevented, ctrlKey: e.ctrlKey, metaKey: e.metaKey, altKey: e.altKey, target: e.target as HTMLElement | null })) return;

      if (!currentProjectRef.current) return;

      if (e.code === 'Space') {
        e.preventDefault();
        audioEngine.togglePlayPause();
      } else if (e.key.toLowerCase() === 'v') {
        e.preventDefault();
        audioEngine.toggleVamp();
      } else if (e.key >= '1' && e.key <= '9') {
        if (jumpsLockedRef.current) return;
        const idx = Number(e.key) - 1;
        const sec = currentProjectRef.current.sections[idx];
        if (sec) {
          e.preventDefault();
          audioEngine.queueSectionJump(sec.id);
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [currentProjectRef, jumpsLockedRef]);
}
