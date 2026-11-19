import type { QueuedFileItem } from '../types/versend';

function makeFileId(file: File, relativePath: string): string {
  return `${relativePath}::${file.size}::${file.lastModified}::${Math.random().toString(36).slice(2, 7)}`;
}

export function extractFilesFromFileList(fileList: FileList | File[]): QueuedFileItem[] {
  const items: QueuedFileItem[] = [];
  const arr = Array.from(fileList);
  for (const file of arr) {
    const rel =
      (file as File & { webkitRelativePath?: string }).webkitRelativePath &&
      (file as File & { webkitRelativePath?: string }).webkitRelativePath!.length > 0
        ? (file as File & { webkitRelativePath?: string }).webkitRelativePath!
        : file.name;
    items.push({
      id: makeFileId(file, rel),
      file,
      name: file.name,
      relativePath: rel,
      size: file.size,
      mimeType: file.type || 'application/octet-stream',
    });
  }
  return items;
}

async function readAllDirectoryEntries(reader: FileSystemDirectoryReader): Promise<FileSystemEntry[]> {
  const entries: FileSystemEntry[] = [];
  while (true) {
    const batch = await new Promise<FileSystemEntry[]>((resolve, reject) => {
      reader.readEntries(resolve, reject);
    });
    if (batch.length === 0) break;
    entries.push(...batch);
  }
  return entries;
}

async function traverseEntry(entry: FileSystemEntry, parentPath: string, out: QueuedFileItem[]): Promise<void> {
  if (entry.isFile) {
    const fileEntry = entry as FileSystemFileEntry;
    const file = await new Promise<File>((resolve, reject) => {
      fileEntry.file(resolve, reject);
    });
    const rel = parentPath ? `${parentPath}/${file.name}` : file.name;
    out.push({
      id: makeFileId(file, rel),
      file,
      name: file.name,
      relativePath: rel,
      size: file.size,
      mimeType: file.type || 'application/octet-stream',
    });
  } else if (entry.isDirectory) {
    const dirEntry = entry as FileSystemDirectoryEntry;
    const nextParent = parentPath ? `${parentPath}/${dirEntry.name}` : dirEntry.name;
    const reader = dirEntry.createReader();
    const children = await readAllDirectoryEntries(reader);
    for (const child of children) {
      await traverseEntry(child, nextParent, out);
    }
  }
}

export async function extractFilesFromDataTransfer(dataTransfer: DataTransfer): Promise<QueuedFileItem[]> {
  const items = dataTransfer.items ? Array.from(dataTransfer.items) : [];
  const entries: FileSystemEntry[] = [];

  for (const item of items) {
    if (item.kind === 'file' && typeof item.webkitGetAsEntry === 'function') {
      const entry = item.webkitGetAsEntry();
      if (entry) entries.push(entry);
    }
  }

  if (entries.length > 0) {
    const out: QueuedFileItem[] = [];
    for (const entry of entries) {
      await traverseEntry(entry, '', out);
    }
    return out;
  }

  if (dataTransfer.files && dataTransfer.files.length > 0) {
    return extractFilesFromFileList(dataTransfer.files);
  }

  return [];
}

export interface FileSink {
  writeChunk(offset: number, data: Uint8Array): Promise<void>;
  close(): Promise<{ blobUrl?: string; savedDirectly: boolean }>;
  abort(): Promise<void>;
  getBytesWritten(): number;
}

export interface DestinationSession {
  mode: 'directory' | 'single-file' | 'browser-download';
  openFile(relativePath: string, mimeType: string, resumeOffset?: number): Promise<FileSink>;
  cleanup?(): Promise<void>;
}

function sanitizePathSegments(relativePath: string): string[] {
  return relativePath
    .replace(/\\/g, '/')
    .split('/')
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && s !== '.' && s !== '..');
}

export function supportsDirectoryPicker(): boolean {
  return typeof window !== 'undefined' && typeof (window as unknown as { showDirectoryPicker?: unknown }).showDirectoryPicker === 'function';
}

export function supportsSaveFilePicker(): boolean {
  return typeof window !== 'undefined' && typeof (window as unknown as { showSaveFilePicker?: unknown }).showSaveFilePicker === 'function';
}

/**
 * Must be invoked directly inside the user's Save click handler so browser
 * permission gestures succeed cleanly.
 */
export async function createDestinationSession(
  fileCount: number,
  singleFileName?: string
): Promise<DestinationSession> {
  const win = window as unknown as {
    showDirectoryPicker?: (opts?: { mode?: 'read' | 'readwrite' }) => Promise<FileSystemDirectoryHandle>;
    showSaveFilePicker?: (opts?: { suggestedName?: string }) => Promise<FileSystemFileHandle>;
  };

  if (win.showDirectoryPicker) {
    const rootDir = await win.showDirectoryPicker({ mode: 'readwrite' });
    return createDirectorySession(rootDir);
  }

  if (fileCount === 1 && singleFileName && win.showSaveFilePicker) {
    const fileHandle = await win.showSaveFilePicker({ suggestedName: singleFileName });
    return createSingleFileHandleSession(fileHandle);
  }

  return createBrowserFallbackSession();
}

function createDirectorySession(rootDir: FileSystemDirectoryHandle): DestinationSession {
  return {
    mode: 'directory',
    async openFile(relativePath: string, _mimeType: string, resumeOffset = 0): Promise<FileSink> {
      const segments = sanitizePathSegments(relativePath);
      const fileName = segments.pop() || 'received_file';
      let currentDir = rootDir;
      for (const folder of segments) {
        currentDir = await currentDir.getDirectoryHandle(folder, { create: true });
      }
      const fileHandle = await currentDir.getFileHandle(fileName, { create: true });
      const writable = await fileHandle.createWritable({ keepExistingData: resumeOffset > 0 });
      if (resumeOffset > 0) {
        await writable.seek(resumeOffset);
      }
      let written = resumeOffset;

      return {
        async writeChunk(offset: number, data: Uint8Array) {
          if (offset !== written) {
            await writable.seek(offset);
          }
          await writable.write(data as unknown as BufferSource);
          written = offset + data.byteLength;
        },
        async close() {
          await writable.close();
          return { savedDirectly: true };
        },
        async abort() {
          try {
            await writable.abort();
          } catch {
            // ignore
          }
        },
        getBytesWritten() {
          return written;
        },
      };
    },
  };
}

function createSingleFileHandleSession(fileHandle: FileSystemFileHandle): DestinationSession {
  return {
    mode: 'single-file',
    async openFile(_relativePath: string, _mimeType: string, resumeOffset = 0): Promise<FileSink> {
      const writable = await fileHandle.createWritable({ keepExistingData: resumeOffset > 0 });
      if (resumeOffset > 0) {
        await writable.seek(resumeOffset);
      }
      let written = resumeOffset;

      return {
        async writeChunk(offset: number, data: Uint8Array) {
          if (offset !== written) {
            await writable.seek(offset);
          }
          await writable.write(data as unknown as BufferSource);
          written = offset + data.byteLength;
        },
        async close() {
          await writable.close();
          return { savedDirectly: true };
        },
        async abort() {
          try {
            await writable.abort();
          } catch {
            // ignore
          }
        },
        getBytesWritten() {
          return written;
        },
      };
    },
  };
}

function createBrowserFallbackSession(): DestinationSession {
  const tempFilesToClean: Array<{ dir: FileSystemDirectoryHandle; name: string }> = [];

  return {
    mode: 'browser-download',
    async openFile(relativePath: string, mimeType: string, _resumeOffset = 0): Promise<FileSink> {
      const fileName = sanitizePathSegments(relativePath).pop() || 'received_file';

      // Prefer OPFS so Android / non-FS-Access browsers don't hold huge files in RAM
      if (typeof navigator !== 'undefined' && navigator.storage && typeof navigator.storage.getDirectory === 'function') {
        try {
          const opfsRoot = await navigator.storage.getDirectory();
          const tempName = `versend_${Date.now()}_${Math.random().toString(36).slice(2, 8)}_${fileName}`;
          const handle = await opfsRoot.getFileHandle(tempName, { create: true });
          if (typeof handle.createWritable === 'function') {
            tempFilesToClean.push({ dir: opfsRoot, name: tempName });
            const writable = await handle.createWritable();
            let written = 0;

            return {
              async writeChunk(offset: number, data: Uint8Array) {
                if (offset !== written) {
                  await writable.seek(offset);
                }
                await writable.write(data as unknown as BufferSource);
                written = offset + data.byteLength;
              },
              async close() {
                await writable.close();
                const file = await handle.getFile();
                const typedBlob = new Blob([file], { type: mimeType || 'application/octet-stream' });
                const blobUrl = URL.createObjectURL(typedBlob);
                triggerBrowserDownload(blobUrl, fileName);
                return { blobUrl, savedDirectly: false };
              },
              async abort() {
                try {
                  await writable.abort();
                  await opfsRoot.removeEntry(tempName);
                } catch {
                  // ignore
                }
              },
              getBytesWritten() {
                return written;
              },
            };
          }
        } catch {
          // Fall back to in-memory chunk blobs below
        }
      }

      const chunks: BlobPart[] = [];
      let written = 0;

      return {
        async writeChunk(_offset: number, data: Uint8Array) {
          const copy = new Uint8Array(data.byteLength);
          copy.set(data);
          chunks.push(copy.buffer);
          written += data.byteLength;
        },
        async close() {
          const blob = new Blob(chunks, { type: mimeType || 'application/octet-stream' });
          chunks.length = 0;
          const blobUrl = URL.createObjectURL(blob);
          triggerBrowserDownload(blobUrl, fileName);
          return { blobUrl, savedDirectly: false };
        },
        async abort() {
          chunks.length = 0;
        },
        getBytesWritten() {
          return written;
        },
      };
    },
    async cleanup() {
      for (const entry of tempFilesToClean) {
        try {
          await entry.dir.removeEntry(entry.name);
        } catch {
          // ignore
        }
      }
    },
  };
}

export function triggerBrowserDownload(blobUrl: string, fileName: string): void {
  const a = document.createElement('a');
  a.href = blobUrl;
  a.download = fileName;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    a.remove();
  }, 500);
}
