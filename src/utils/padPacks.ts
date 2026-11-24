import { noteIndexToLabel } from './padSong';

export interface PadPackInfo {
  id: string;
  name: string;
  sourceFolder: string;
  sampleRate: number;
  availableNotes: number[];
  durationSec: number;
}

type Invoke = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;

function getInvoke(): Invoke | null {
  return (window as unknown as { __TAURI__?: { core?: { invoke?: Invoke } } }).__TAURI__?.core?.invoke ?? null;
}

export async function listPadPacks(): Promise<PadPackInfo[]> {
  const invoke = getInvoke();
  if (!invoke) return [];
  const res = await invoke<PadPackInfo[]>('audio_list_pad_packs');
  return Array.isArray(res) ? res : [];
}

export async function importPadPack(name: string, folderPath: string): Promise<PadPackInfo> {
  const invoke = getInvoke();
  if (!invoke) throw new Error('Esta función requiere la aplicación de escritorio.');
  return invoke<PadPackInfo>('audio_import_pad_pack', { name, folderPath });
}

export async function deletePadPack(packId: string): Promise<void> {
  const invoke = getInvoke();
  if (!invoke) return;
  await invoke('audio_delete_pad_pack', { packId });
}

export function formatPackNotesSummary(notes: readonly number[]): string {
  if (!Array.isArray(notes) || notes.length === 0) return '0/12 notas';
  if (notes.length >= 12) return '12/12 notas (completo)';
  const labels = notes.slice(0, 6).map((n) => noteIndexToLabel(n));
  const extra = notes.length > 6 ? '…' : '';
  return `${notes.length}/12 notas (${labels.join(', ')}${extra})`;
}
