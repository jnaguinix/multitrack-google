import { TrackChannel } from '../types/project';

export function inferTrackRoleAndColor(
  fileName: string,
  index: number
): Pick<TrackChannel, 'role' | 'color' | 'bus'> {
  const lower = (fileName || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
  if (lower.includes('click') || lower.includes('metro')) {
    return { role: 'click', color: '#0891B2', bus: 'cue-click' };
  }
  if (lower.includes('guide') || lower.includes('cue') || lower.includes('guia')) {
    return { role: 'guide', color: '#0284C7', bus: 'cue-click' };
  }
  if (lower.includes('drum') || lower.includes('bateria') || lower.includes('kick')) {
    return { role: 'drums', color: '#D97706', bus: 'main' };
  }
  if (lower.includes('bass') || lower.includes('bajo') || lower.includes('sub')) {
    return { role: 'bass', color: '#DC2626', bus: 'main' };
  }
  if (lower.includes('key') || lower.includes('piano') || lower.includes('rhodes')) {
    return { role: 'keys', color: '#0891B2', bus: 'main' };
  }
  if (lower.includes('gtr') || lower.includes('guitar')) {
    return { role: 'guitar', color: '#059669', bus: 'main' };
  }
  if (lower.includes('vox') || lower.includes('choir') || lower.includes('coro')) {
    return { role: 'vox', color: '#DB2777', bus: 'main' };
  }
  const palette = ['#2563EB', '#7C3AED', '#059669', '#D97706', '#DB2777', '#0891B2'];
  return {
    role: 'custom',
    color: palette[index % palette.length],
    bus: 'main',
  };
}
