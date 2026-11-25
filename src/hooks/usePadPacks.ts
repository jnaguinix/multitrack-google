import { useCallback, useEffect, useState } from 'react';
import { deletePadPack, importPadPack, listPadPacks, type PadPackInfo } from '../utils/padPacks';
import { logAsyncError } from '../utils/asyncErrors';

export function usePadPacks() {
  const [padPacks, setPadPacks] = useState<PadPackInfo[]>([]);
  const [isLoadingPacks, setIsLoadingPacks] = useState(false);
  const [isImportingPack, setIsImportingPack] = useState(false);

  const refreshPadPacks = useCallback(async () => {
    setIsLoadingPacks(true);
    try {
      const list = await listPadPacks();
      setPadPacks(list);
    } catch (err) {
      logAsyncError('listar los packs de pads')(err);
    } finally {
      setIsLoadingPacks(false);
    }
  }, []);

  useEffect(() => {
    void refreshPadPacks();
  }, [refreshPadPacks]);

  const importPackFromFolder = useCallback(async (name: string, folderPath: string) => {
    setIsImportingPack(true);
    try {
      const created = await importPadPack(name, folderPath);
      setPadPacks((prev) => [...prev.filter((p) => p.id !== created.id), created]);
      return created;
    } finally {
      setIsImportingPack(false);
    }
  }, []);

  const removePack = useCallback(async (packId: string) => {
    await deletePadPack(packId);
    setPadPacks((prev) => prev.filter((p) => p.id !== packId));
  }, []);

  return {
    padPacks,
    isLoadingPacks,
    isImportingPack,
    refreshPadPacks,
    importPackFromFolder,
    removePack,
  };
}
