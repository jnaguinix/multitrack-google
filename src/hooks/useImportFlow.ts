import type { SongProject } from '../types/project';
import type { FingerprintCandidate } from '../audio/fingerprint';
import type { ImportWizardMode, WizardFile, WizardMeta, WizardResult } from '../components/modals/ImportWizardModal';
import { useHtmlImport } from './useHtmlImport';
import { useNativeImport } from './useNativeImport';

export interface ImportFlowDeps {
  projects: SongProject[];
  projectsRef: React.MutableRefObject<SongProject[]>;
  currentProjectRef: React.MutableRefObject<SongProject | null>;
  setProjects: React.Dispatch<React.SetStateAction<SongProject[]>>;
  setCurrentProject: React.Dispatch<React.SetStateAction<SongProject | null>>;
  showToast: (msg: string) => void;
  setImportStatusText: React.Dispatch<React.SetStateAction<string | null>>;
  setFingerprintPrompt: React.Dispatch<
    React.SetStateAction<{
      candidates: FingerprintCandidate[];
      incomingTrackCount: number;
      sourceLabel: string;
      resolve: (choice: SongProject | null | 'cancel') => void;
    } | null>
  >;
  setMissingNativeCache: React.Dispatch<React.SetStateAction<boolean>>;
  /** Abre el asistente de importación y devuelve lo que el usuario eligió (`null` si cancela). */
  requestImportWizard: (request: {
    mode: ImportWizardMode;
    initialMeta: WizardMeta;
    files: WizardFile[];
  }) => Promise<WizardResult | null>;
}

/**
 * Importación de canciones y pistas: `handleImportNative` (diálogos del sistema, escritorio; ver `useNativeImport`)
 * y `handleInstantImportFiles` (selector HTML o arrastre; ver `useHtmlImport`).
 */
export function useImportFlow(deps: ImportFlowDeps) {
  const handleInstantImportFiles = useHtmlImport(deps);
  const handleImportNative = useNativeImport(deps);
  return {
    handleInstantImportFiles,
    handleImportNative,
  };
}
