import { useCallback, useEffect, useState } from 'react';

/**
 * Muestra una lista larga por tandas: pinta `pageSize` elementos y, al acercarse al final del
 * contenedor (o al pulsar «Mostrar más»), pinta otras tantas. Evita montar cientos de filas a la vez.
 * `resetKey` devuelve la lista a la primera tanda (por ejemplo, cuando cambia la búsqueda).
 */
export function useProgressiveList<T>(items: readonly T[], resetKey: string, pageSize = 40) {
  const [count, setCount] = useState(pageSize);
  const [sentinel, setSentinel] = useState<HTMLElement | null>(null);

  useEffect(() => {
    setCount(pageSize);
  }, [resetKey, pageSize]);

  const hasMore = count < items.length;
  const showMore = useCallback(() => setCount((current) => current + pageSize), [pageSize]);

  useEffect(() => {
    if (!sentinel || !hasMore || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) setCount((current) => current + pageSize);
      },
      { rootMargin: '300px' }
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [sentinel, hasMore, count, pageSize]);

  return {
    shown: items.slice(0, count),
    hasMore,
    remaining: Math.max(0, items.length - count),
    showMore,
    sentinelRef: setSentinel,
  };
}
