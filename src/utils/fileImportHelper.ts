/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

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
