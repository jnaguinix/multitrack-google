import type { SongSection } from '../types/project';

export interface SectionTemplate {
  key: string;
  name: string;
  /** Código corto que se ve en el círculo de la onda (I, V1, C, P…). */
  code: string;
  color: string;
}

/** Secciones habituales de una canción de alabanza, con un color fijo por tipo. */
export const SECTION_TEMPLATES: SectionTemplate[] = [
  { key: 'count-in', name: 'Cuenta inicial', code: 'Ci', color: '#FACC15' },
  { key: 'intro', name: 'Intro', code: 'I', color: '#22D3EE' },
  { key: 'verse-1', name: 'Verso 1', code: 'V1', color: '#A855F7' },
  { key: 'verse-2', name: 'Verso 2', code: 'V2', color: '#A855F7' },
  { key: 'verse-3', name: 'Verso 3', code: 'V3', color: '#A855F7' },
  { key: 'verse-4', name: 'Verso 4', code: 'V4', color: '#A855F7' },
  { key: 'chorus', name: 'Coro', code: 'C', color: '#FB923C' },
  { key: 'bridge', name: 'Puente', code: 'P', color: '#F43F5E' },
  { key: 'instrumental', name: 'Instrumental', code: 'In', color: '#3B82F6' },
  { key: 'outro', name: 'Final', code: 'F', color: '#22C55E' },
];

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Inserta una sección de plantilla en `startSec` y recalcula los finales: cada sección termina
 * donde empieza la siguiente y la última, al final de la canción. Si ya hay una sección que
 * empieza en ese mismo punto (a menos de 50 ms), la sustituye en vez de duplicarla.
 */
export function insertTemplateSection(
  sections: SongSection[],
  template: SectionTemplate,
  startSec: number,
  totalSec: number,
  id: string
): SongSection[] {
  const total = Math.max(1, totalSec);
  const start = Math.max(0, Math.min(total - 0.5, startSec));
  const kept = sections.filter((s) => Math.abs(s.startTimeSec - start) >= 0.05);
  const created: SongSection = {
    id,
    name: template.name,
    code: template.code,
    color: template.color,
    startTimeSec: start,
    endTimeSec: total,
    vampByDefault: false,
    cueName: template.name,
  };
  const sorted = [...kept, created].sort((a, b) => a.startTimeSec - b.startTimeSec);
  return sorted.map((s, i) => {
    const next = sorted[i + 1];
    const end = next ? next.startTimeSec : total;
    return {
      ...s,
      startTimeSec: round2(s.startTimeSec),
      endTimeSec: round2(Math.max(s.startTimeSec + 0.05, end)),
    };
  });
}
