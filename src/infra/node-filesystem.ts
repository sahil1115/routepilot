/**
 * Node implementation of {@link FileSystemPort}.
 *
 * Every operation swallows I/O errors and returns an empty or null result. That
 * is deliberate: analysis runs over workspaces containing broken symlinks,
 * permission-denied directories and files that vanish mid-scan. None of those
 * is a reason to fail a routing decision.
 */

import { readdir, readFile, stat } from 'node:fs/promises';

import type { DirectoryEntry, FileStat, FileSystemPort } from '../core/ports.js';

/** Reads the real filesystem. */
export class NodeFileSystem implements FileSystemPort {
  async readDirectory(path: string): Promise<readonly DirectoryEntry[]> {
    try {
      const entries = await readdir(path, { withFileTypes: true });
      return entries.map((entry) => ({
        name: entry.name,
        isDirectory: entry.isDirectory(),
        isFile: entry.isFile(),
      }));
    } catch {
      return [];
    }
  }

  async stat(path: string): Promise<FileStat | null> {
    try {
      const result = await stat(path);
      return { size: result.size, mtimeMs: result.mtimeMs };
    } catch {
      return null;
    }
  }

  async readFile(path: string): Promise<string | null> {
    try {
      return await readFile(path, 'utf8');
    } catch {
      return null;
    }
  }
}
