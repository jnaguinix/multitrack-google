/**
 * Pide al navegador que no borre el almacenamiento de la app (IndexedDB) cuando falte espacio.
 */
export async function ensureStoragePersist(): Promise<boolean> {
  try {
    if (typeof navigator !== 'undefined' && navigator.storage && navigator.storage.persist) {
      const isPersisted = await Promise.race([
        navigator.storage.persisted(),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 200)),
      ]);
      if (!isPersisted) {
        return await Promise.race([
          navigator.storage.persist(),
          new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 200)),
        ]);
      }
      return true;
    }
  } catch (err) {
    console.warn('[OPFS] Error checking storage persistence:', err);
  }
  return false;
}
