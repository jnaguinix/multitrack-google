import { useEffect } from 'react';
import { audioEngine } from '../audio/audioEngine';
import { SongProject } from '../types/project';

/**
 * Atajos globales de teclado: Espacio = reproducir/pausar, V = vamp, 1-9 = saltar a la sección N.
 * Se ignoran mientras se escribe en un campo de texto o un selector. Con `jumpsLockedRef` activo
 * (En vivo con los saltos bloqueados) las teclas 1-9 no hacen nada.
 */
export function useStudioShortcuts(
  currentProjectRef: React.MutableRefObject<SongProject | null>,
  jumpsLockedRef: React.MutableRefObject<boolean>
): void {
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT' ||
          target.isContentEditable)
      ) {
        return;
      }

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
