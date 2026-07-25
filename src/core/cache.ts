/**
 * Persistent parse cache.
 *
 * Parsing dominates indexing: on a 2,000-file repository it is several seconds,
 * and without a cache every server restart pays it again before the first tool
 * call can be answered. Since parse output is a pure function of file contents,
 * it can be kept and reused as long as size and mtime are unchanged.
 *
 * The cache lives outside the workspace — under `XDG_CACHE_HOME` or
 * `~/.cache/jellybean` — because it is machine-local derived data. Notes go in
 * the repository on purpose; a multi-megabyte binary-ish blob does not.
 */

import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { CodeSymbol, ImportRef, LanguageId } from '../lang/types.js';

/** Bump when the shape of a cached record changes in a way that alters meaning. */
const CACHE_VERSION = 3;

/**
 * One file's parse output. Keys are single characters because this structure is
 * repeated once per file — on a large repository the long-form key names would
 * be a substantial fraction of the file.
 */
export interface CachedFile {
  /** size */
  s: number;
  /** mtimeMs */
  m: number;
  /** language */
  l: LanguageId;
  /** lineCount */
  n: number;
  /** symbols */
  y: CodeSymbol[];
  /** imports */
  i: ImportRef[];
  /** exports */
  e: string[];
  /** term frequencies, packed as `term:count` pairs separated by spaces */
  t: string;
  /** skipped */
  k: boolean;
}

interface CacheFile {
  version: number;
  root: string;
  files: Record<string, CachedFile>;
}

export class ParseCache {
  private entries = new Map<string, CachedFile>();
  private dirty = false;
  private loaded = false;

  private constructor(private readonly file: string) {}

  /** Locate the cache for a workspace. The root path is hashed, not embedded. */
  static forWorkspace(root: string): ParseCache {
    const base = process.env['XDG_CACHE_HOME'] ?? join(homedir(), '.cache');
    const key = createHash('sha1').update(root).digest('hex').slice(0, 16);
    return new ParseCache(join(base, 'jellybean', `${key}.json`));
  }

  /** Where the cache is stored, for diagnostics. */
  get path(): string {
    return this.file;
  }

  get size(): number {
    return this.entries.size;
  }

  /**
   * Read the cache from disk. Any problem — missing, corrupt, wrong version,
   * wrong root — yields an empty cache rather than an error: a stale cache must
   * never be able to break indexing, only fail to accelerate it.
   */
  async load(root: string): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const raw = await readFile(this.file, 'utf8');
      const parsed = JSON.parse(raw) as Partial<CacheFile>;
      if (parsed.version !== CACHE_VERSION || parsed.root !== root || !parsed.files) return;
      this.entries = new Map(Object.entries(parsed.files));
    } catch {
      this.entries = new Map();
    }
  }

  /** A cached parse for this exact file revision, or undefined. */
  get(path: string, size: number, mtimeMs: number): CachedFile | undefined {
    const entry = this.entries.get(path);
    if (!entry || entry.s !== size || entry.m !== mtimeMs) return undefined;
    return entry;
  }

  set(path: string, entry: CachedFile): void {
    this.entries.set(path, entry);
    this.dirty = true;
  }

  delete(path: string): void {
    if (this.entries.delete(path)) this.dirty = true;
  }

  /** Drop everything not in `keep`, so deleted files do not accumulate forever. */
  retain(keep: ReadonlySet<string>): void {
    for (const path of this.entries.keys()) {
      if (!keep.has(path)) {
        this.entries.delete(path);
        this.dirty = true;
      }
    }
  }

  /** Write atomically, and only when something changed. */
  async save(root: string): Promise<void> {
    if (!this.dirty) return;
    this.dirty = false;

    const payload: CacheFile = { version: CACHE_VERSION, root, files: Object.fromEntries(this.entries) };
    try {
      await mkdir(dirname(this.file), { recursive: true });
      const temporary = `${this.file}.${process.pid}.tmp`;
      await writeFile(temporary, JSON.stringify(payload), 'utf8');
      await rename(temporary, this.file);
    } catch {
      // A cache that cannot be written is a missed optimisation, not a failure.
    }
  }
}

/** Pack term frequencies into one string. */
export function packTerms(frequencies: ReadonlyMap<string, number>): string {
  const parts: string[] = [];
  for (const [term, count] of frequencies) parts.push(count === 1 ? term : `${term}:${count}`);
  return parts.join(' ');
}

/** Unpack what `packTerms` produced. */
export function unpackTerms(packed: string): Map<string, number> {
  const frequencies = new Map<string, number>();
  if (packed === '') return frequencies;

  for (const part of packed.split(' ')) {
    const colon = part.lastIndexOf(':');
    if (colon === -1) {
      frequencies.set(part, 1);
      continue;
    }
    const count = Number(part.slice(colon + 1));
    frequencies.set(part.slice(0, colon), Number.isFinite(count) ? count : 1);
  }
  return frequencies;
}
