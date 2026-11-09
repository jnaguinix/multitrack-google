/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Side-vs-mid energy below which a stereo file is treated as mono.
 * Measured on real MP3 stems (joint stereo): "mono" CLICK/CUES tracks sit at -58/-66 dB,
 * while real stereo instruments (pads, drums, piano) sit between -15 and 0 dB.
 * -40 dB leaves a wide margin on both sides and does not depend on loudness.
 */
const MONO_SIDE_THRESHOLD_DB = -40;

/**
 * True when L and R carry (practically) the same signal. Uses the energy of the side
 * signal (L-R) relative to the mid signal (L+R) over the whole file, which is robust to the
 * tiny per-sample differences lossy codecs introduce and never mistakes a quiet stereo
 * track for mono (unlike a per-sample absolute threshold).
 */
export function isEffectivelyMono(left: Float32Array, right: Float32Array): boolean {
  if (left.length !== right.length || left.length === 0) return false;
  let mid = 0;
  let side = 0;
  for (let i = 0; i < left.length; i++) {
    const l = left[i];
    const r = right[i];
    const m = l + r;
    const s = l - r;
    mid += m * m;
    side += s * s;
  }
  if (side === 0) return true;
  if (mid === 0) return false; // pure out-of-phase signal: keep stereo
  return 10 * Math.log10(side / mid) < MONO_SIDE_THRESHOLD_DB;
}
