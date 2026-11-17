/**
 * IDs de pista repetidos dentro de una misma canción. El motor direcciona cada pista por su ID: con dos iguales, las
 * órdenes (volumen, mute, solo…) solo llegan a la primera. No se renombran solos porque el ID también nombra el
 * archivo de la caché PCM: la solución es reimportar la carpeta (el importador asigna IDs únicos).
 */
export function findDuplicateTrackIds(tracks: ReadonlyArray<{ id: string }>): string[] {
  const seen = new Set<string>();
  const dup = new Set<string>();
  for (const t of tracks) {
    if (seen.has(t.id)) dup.add(t.id);
    seen.add(t.id);
  }
  return [...dup];
}
