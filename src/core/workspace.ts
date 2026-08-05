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

/** Sibling directories descended into concurrently during a walk. */
const WALK_CONCURRENCY = 16;

export class PathEscapeError extends Error {
  constructor(requested: string) {
    super(`Path is outside the workspace: ${requested}`);
    this.name = 'PathEscapeError';
  }
}

export class Workspace {
  /**
   * The matcher built by the last full walk, reused for targeted rescans.
   *
   * Rebuilding it means reading every nested .gitignore, which means walking —
   * defeating the point. A change to a .gitignore itself invalidates this, and
   * the caller forces a full walk in that case.
   */
  private lastMatcher: IgnoreMatcher | null = null;

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
    this.lastMatcher = matcher;
    return files;
  }

  /**
   * Stat a specific set of paths rather than walking the tree.
   *
   * This is what makes a live session cheap: an editor save touches one file,
   * and the watcher knows which, so there is no reason to stat five thousand
   * others to discover that.
   *
   * Returns `null` when it cannot be done safely — no previous walk to inherit
   * ignore rules from, or one of the paths is a directory, whose contents we
   * would have to enumerate anyway.
   */
  async statPaths(paths: readonly string[]): Promise<{ present: WorkspaceFile[]; absent: string[] } | null> {
    const matcher = this.lastMatcher;
    if (!matcher) return null;

    const present: WorkspaceFile[] = [];
    const absent: string[] = [];

    const results = await Promise.all(
      paths.map(async (rel) => {
        try {
          const info = await stat(resolvePath(this.root, rel));
          return { rel, info };
        } catch {
          return { rel, info: null };
        }
      }),
    );

    for (const { rel, info } of results) {
      if (info === null) {
        // Gone, or never existed. Either way the index should not hold it.
        absent.push(rel);
        continue;
      }
      // A directory needs enumerating, which is a walk by another name.
      if (info.isDirectory()) return null;
      if (!info.isFile()) continue;
      if (matcher.ignores(rel, false)) {
        absent.push(rel);
        continue;
      }
      present.push({ path: rel, size: info.size, mtimeMs: info.mtimeMs });
    }

    return { present, absent };
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
    const candidates: string[] = [];
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
      candidates.push(rel);
    }

    // One `stat` per file, issued together rather than in sequence. On a
    // 2,000-file repository this is the difference between ~750ms and ~140ms,
    // and it runs on every rescan.
    const stats = await Promise.all(
      candidates.map(async (rel) => {
        try {
          const info = await stat(resolvePath(this.root, rel));
          return { path: rel, size: info.size, mtimeMs: info.mtimeMs };
        } catch {
          return null; // raced with a delete
        }
      }),
    );
    for (const file of stats) {
      if (file) out.push(file);
    }

    // Nested .gitignore files must all be loaded before any of their directories
    // are walked, because a rule in one can exclude a sibling's contents and the
    // matcher is order-sensitive.
    await Promise.all(subdirs.map((subdir) => this.loadGitignore(matcher, subdir)));

    // Recurse into sibling directories concurrently, in bounded batches. Serial
    // recursion spends most of its time waiting on `readdir` one directory at a
    // time, which on a large tree is the bulk of a rescan.
    for (let i = 0; i < subdirs.length; i += WALK_CONCURRENCY) {
      if (out.length >= maxFiles) return;
      const batch = subdirs.slice(i, i + WALK_CONCURRENCY);
      await Promise.all(batch.map((subdir) => this.walkDir(subdir, matcher, out, maxFiles, depth + 1)));
    }
  }
}
