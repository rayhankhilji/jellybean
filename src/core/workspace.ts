/**
 * Workspace access.
 *
 * Every path that enters the server from a tool call passes through
 * `resolve()`, which is the single place that enforces containment: a caller
 * cannot read `../../.ssh/id_rsa` by asking nicely. Walking honours .gitignore
 * (including nested ones) plus a built-in list of directories that are never
 * worth indexing.
 */

import { readFile, readdir, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve as resolvePath, sep } from 'node:path';
import { DEFAULT_IGNORES, IgnoreMatcher } from './ignore.js';
import { looksBinary } from '../util/text.js';

export interface WorkspaceFile {
  /** POSIX-style path relative to the workspace root. */
  path: string;
  size: number;
  /** Modification time in epoch milliseconds; drives cache invalidation. */
  mtimeMs: number;
}

export class PathEscapeError extends Error {
  constructor(requested: string) {
    super(`Path is outside the workspace: ${requested}`);
    this.name = 'PathEscapeError';
  }
}

export class Workspace {
  constructor(
    readonly root: string,
    private readonly extraIgnores: readonly string[] = [],
  ) {}

  /**
   * Turn a caller-supplied path into an absolute path inside the workspace.
   * Throws rather than clamping, so a mistake is visible instead of silently
   * reading the wrong file.
   */
  resolve(relPath: string): string {
    const normalized = relPath.replace(/^\/+/, '');
    const absolute = isAbsolute(relPath) ? resolvePath(relPath) : resolvePath(this.root, normalized);
    const rel = relative(this.root, absolute);
    if (rel.startsWith('..' + sep) || rel === '..' || isAbsolute(rel)) {
      throw new PathEscapeError(relPath);
    }
    return absolute;
  }

  /** Convert an absolute path back to a POSIX-style workspace-relative one. */
  relativize(absolute: string): string {
    return relative(this.root, absolute).split(sep).join('/');
  }

  /** Read a UTF-8 file. Returns null for binary content or unreadable paths. */
  async readText(relPath: string, maxBytes: number): Promise<string | null> {
    const absolute = this.resolve(relPath);
    try {
      const info = await stat(absolute);
      if (!info.isFile() || info.size > maxBytes) return null;
      const buf = await readFile(absolute);
      if (looksBinary(buf)) return null;
      return buf.toString('utf8');
    } catch {
      return null;
    }
  }

  /** Whether a path exists and what it is. */
  async kindOf(relPath: string): Promise<'file' | 'directory' | 'missing'> {
    try {
      const info = await stat(this.resolve(relPath));
      return info.isDirectory() ? 'directory' : 'file';
    } catch {
      return 'missing';
    }
  }

  /**
   * Walk the workspace, yielding every non-ignored file.
   *
   * Directories are read breadth-first per level and sorted, so results are
   * deterministic — which matters because tool output feeds a cache.
   */
  async walk(maxFiles: number): Promise<WorkspaceFile[]> {
    const matcher = new IgnoreMatcher();
    matcher.addPatterns(DEFAULT_IGNORES);
    matcher.addPatterns(this.extraIgnores);
    await this.loadGitignore(matcher, '');

    const files: WorkspaceFile[] = [];
    await this.walkDir('', matcher, files, maxFiles, 0);
    files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    return files;
  }

  private async loadGitignore(matcher: IgnoreMatcher, base: string): Promise<void> {
    const path = base === '' ? '.gitignore' : `${base}/.gitignore`;
    try {
      const contents = await readFile(resolvePath(this.root, path), 'utf8');
      matcher.addGitignore(contents, base);
    } catch {
      // No .gitignore here — perfectly normal.
    }
  }

  private async walkDir(
    relDir: string,
    matcher: IgnoreMatcher,
    out: WorkspaceFile[],
    maxFiles: number,
    depth: number,
  ): Promise<void> {
    if (out.length >= maxFiles || depth > 24) return;

    let entries;
    try {
      entries = await readdir(resolvePath(this.root, relDir), { withFileTypes: true });
    } catch {
      return; // permission denied, or the directory vanished mid-walk
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

    const subdirs: string[] = [];
    for (const entry of entries) {
      if (out.length >= maxFiles) return;
      const rel = relDir === '' ? entry.name : `${relDir}/${entry.name}`;

      if (entry.isDirectory()) {
        if (matcher.ignores(rel, true)) continue;
        subdirs.push(rel);
        continue;
      }
      // Symlinks are skipped: they can point outside the workspace and create cycles.
      if (!entry.isFile()) continue;
      if (matcher.ignores(rel, false)) continue;

      try {
        const info = await stat(resolvePath(this.root, rel));
        out.push({ path: rel, size: info.size, mtimeMs: info.mtimeMs });
      } catch {
        // Raced with a delete; skip.
      }
    }

    for (const subdir of subdirs) {
      await this.loadGitignore(matcher, subdir);
      await this.walkDir(subdir, matcher, out, maxFiles, depth + 1);
    }
  }
}
