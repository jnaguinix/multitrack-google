/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

export interface FastWavHeaderInfo {
  durationSec: number;
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  dataOffset: number;
  dataSize: number;
}

/**
 * Validates whether a file is a candidate audio stem.
 * Rejects macOS resource forks (._*), hidden files, text/metadata files, and empty 0-byte entries.
 */
export function isAudioFileCandidate(file: File): boolean {
  if (!file || !file.name) return false;

  const name = file.name;
  const lower = name.toLowerCase();

  // Reject hidden files, macOS metadata/resource forks, and directory markers
  if (name.startsWith('.') || name.startsWith('._')) return false;
  if (lower === 'thumbs.db' || lower === 'desktop.ini') return false;

  const relPath = (file as File & { webkitRelativePath?: string }).webkitRelativePath || '';
  if (relPath.includes('/.') || relPath.includes('/._') || relPath.includes('__MACOSX')) {
    return false;
  }

  // Files under 1 KB cannot be valid audio stems
  if (typeof file.size === 'number' && file.size > 0 && file.size < 1024) {
    return false;
  }

  // Reject non-audio document extensions
  if (/\.(txt|pdf|docx?|xlsx?|rtf|zip|rar|7z|tar|gz|json|png|jpe?g|gif|svg|ico)$/i.test(lower)) {
    return false;
  }

  // Check audio MIME type if provided
  if (file.type && file.type.startsWith('audio/')) {
    return true;
  }

  // Check supported multitrack audio extensions (.wav, .mp3, .ogg, .flac, .m4a, .aac, .webm, .opus, .aif, .aiff, .caf, .wma)
  return /\.(wav|mp3|ogg|flac|m4a|aac|webm|opus|aif|aiff|caf|wma)$/i.test(lower);
}

/**
 * Reads only the first 4 KB of a WAV file (< 0.5 ms) to extract exact duration,
 * sampleRate, channels, and bit depth without reading or decoding the entire file.
 */
export async function parseWavHeaderFast(file: File): Promise<FastWavHeaderInfo | null> {
  const lower = file.name.toLowerCase();
  const isWav =
    lower.endsWith('.wav') ||
    file.type === 'audio/wav' ||
    file.type === 'audio/x-wav' ||
    file.type === 'audio/wave';

  if (!isWav || file.size < 44) return null;

  try {
    const headerSlice = await file.slice(0, 4096).arrayBuffer();
    const view = new DataView(headerSlice);

    // Check "RIFF" (0x52494646) and "WAVE" (0x57415645)
    if (view.getUint32(0, false) !== 0x52494646 || view.getUint32(8, false) !== 0x57415645) {
      return null;
    }

    let offset = 12;
    let channels = 2;
    let sampleRate = 48000;
    let byteRate = 0;
    let bitsPerSample = 16;
    let dataOffset = 44;
    let dataSize = Math.max(0, file.size - 44);

    while (offset + 8 <= view.byteLength) {
      const chunkId = view.getUint32(offset, false);
      const chunkSize = view.getUint32(offset + 4, true);

      // "fmt " chunk (0x666d7420)
      if (chunkId === 0x666d7420 && offset + 24 <= view.byteLength) {
        channels = view.getUint16(offset + 10, true) || 2;
        sampleRate = view.getUint32(offset + 12, true) || 48000;
        byteRate = view.getUint32(offset + 16, true);
        bitsPerSample = view.getUint16(offset + 22, true) || 16;
      }
      // "data" chunk (0x64617461)
      else if (chunkId === 0x64617461) {
        dataOffset = offset + 8;
        dataSize = chunkSize > 0 && chunkSize <= file.size ? chunkSize : file.size - dataOffset;
        break;
      }

      offset += 8 + chunkSize + (chunkSize % 2);
    }

    const effectiveByteRate =
      byteRate > 0 ? byteRate : sampleRate * channels * Math.max(1, bitsPerSample >> 3);
    if (effectiveByteRate <= 0) return null;

    const durationSec = Math.max(0.1, dataSize / effectiveByteRate);
    return {
      durationSec,
      sampleRate,
      channels,
      bitsPerSample,
      dataOffset,
      dataSize,
    };
  } catch {
    return null;
  }
}

/**
 * Converts a FileList or File[] into a clean array of valid audio files
 */
export function extractAudioFilesFromFileList(fileList: FileList | File[]): File[] {
  if (!fileList) return [];
  const list = Array.isArray(fileList) ? fileList : Array.from(fileList);
  return list.filter(isAudioFileCandidate);
}

/**
 * Traverses a DataTransfer (drag & drop) recursively to extract all audio files
 * inside dropped folders or direct file drops, preserving folder names in webkitRelativePath.
 */
export async function extractAudioFilesFromDataTransfer(
  dataTransfer: DataTransfer
): Promise<File[]> {
  const extractedFiles: File[] = [];

  const items = dataTransfer.items;
  if (items && items.length > 0 && typeof items[0].webkitGetAsEntry === 'function') {
    const rootEntries: unknown[] = [];
    for (let i = 0; i < items.length; i++) {
      const entry = items[i].webkitGetAsEntry();
      if (entry) {
        rootEntries.push(entry);
      }
    }

    // Recursive helper to traverse FileSystemEntry
    async function traverseEntry(entry: any, pathPrefix = ''): Promise<void> {
      if (!entry) return;

      if (entry.isFile) {
        await new Promise<void>((resolve) => {
          entry.file(
            (file: File) => {
              if (isAudioFileCandidate(file)) {
                const fullRelPath = pathPrefix ? `${pathPrefix}/${file.name}` : file.name;
                try {
                  Object.defineProperty(file, 'webkitRelativePath', {
                    value: fullRelPath,
                    writable: false,
                    configurable: true,
                  });
                } catch {
                  // Ignore if browser restricts defining property on native File
                }
                extractedFiles.push(file);
              }
              resolve();
            },
            () => resolve()
          );
        });
      } else if (entry.isDirectory) {
        const dirReader = entry.createReader();
        const readEntriesBatch = (): Promise<any[]> => {
          return new Promise((resolve) => {
            const allEntries: any[] = [];
            const readNext = () => {
              dirReader.readEntries(
                (entries: any[]) => {
                  if (!entries || entries.length === 0) {
                    resolve(allEntries);
                  } else {
                    allEntries.push(...entries);
                    readNext();
                  }
                },
                () => resolve(allEntries)
              );
            };
            readNext();
          });
        };

        const subEntries = await readEntriesBatch();
        const nextPrefix = pathPrefix ? `${pathPrefix}/${entry.name}` : entry.name;
        for (const sub of subEntries) {
          await traverseEntry(sub, nextPrefix);
        }
      }
    }

    for (const entry of rootEntries) {
      await traverseEntry(entry);
    }
  }

  // Fallback if webkitGetAsEntry didn't find any or isn't supported
  if (extractedFiles.length === 0 && dataTransfer.files && dataTransfer.files.length > 0) {
    const rawFiles = Array.from(dataTransfer.files);
    for (const file of rawFiles) {
      if (isAudioFileCandidate(file)) {
        extractedFiles.push(file);
      }
    }
  }

  return extractedFiles;
}
