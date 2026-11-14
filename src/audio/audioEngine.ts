// =============================================================================
// FACHADA DEL MOTOR DE AUDIO
// =============================================================================
// La aplicación es de escritorio: el audio lo reproduce el motor nativo de Rust y este archivo solo
// expone su adaptador TypeScript con el nombre que usa el resto de la interfaz. El antiguo motor
// Web Audio (≈2600 líneas) se retiró; sigue disponible en la etiqueta `main-web-final`.
// =============================================================================

import { nativeAudioEngine, NativeAudioEngine } from './nativeAudioEngine';

export type AudioEngine = NativeAudioEngine;

export const audioEngine: AudioEngine = nativeAudioEngine;

if (typeof window !== 'undefined') {
  (window as unknown as { __audioEngine: AudioEngine }).__audioEngine = audioEngine;
}
