import { useCallback, useState } from 'react';

const STORAGE_KEY = 'omnitracks.setlist.meta';

export interface SetlistMeta {
  /** Nombre del servicio, por ejemplo «Servicio del domingo». */
  name: string;
  /** Fecha en formato AAAA-MM-DD (la del input de tipo fecha). */
  date: string;
}

function readStoredMeta(): SetlistMeta {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return { name: '', date: '' };
    const parsed = JSON.parse(raw) as Partial<SetlistMeta>;
    return {
      name: typeof parsed.name === 'string' ? parsed.name : '',
      date: typeof parsed.date === 'string' ? parsed.date : '',
    };
  } catch (err) {
    console.warn('[Setlist] No se pudo leer el nombre y la fecha guardados:', err);
    return { name: '', date: '' };
  }
}

/**
 * Nombre y fecha del setlist. Es un dato ligero de la sesión, así que vive en el almacenamiento
 * local de la app y no en library.json. Si no se puede guardar, se avisa en la consola y la app
 * sigue funcionando con el valor en memoria.
 */
export function useSetlistMeta() {
  const [meta, setMeta] = useState<SetlistMeta>(readStoredMeta);

  const update = useCallback((patch: Partial<SetlistMeta>) => {
    setMeta((prev) => {
      const next = { ...prev, ...patch };
      try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      } catch (err) {
        console.warn('[Setlist] No se pudo guardar el nombre y la fecha del setlist:', err);
      }
      return next;
    });
  }, []);

  return { meta, setName: (name: string) => update({ name }), setDate: (date: string) => update({ date }) };
}
