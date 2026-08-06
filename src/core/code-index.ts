/**
 * The workspace index.
 *
 * Holds one `FileRecord` per file: its language, symbol outline, imports, and
 * a term-frequency contribution to a global inverted index. Everything the
 * tools do — mapping, search, tracing, reading by symbol — is a query against
 * this structure.
 *
 * Two design choices are worth calling out:
 *
 *  1. **Incremental by mtime.** A rescan re-parses only files whose size or
 *     mtime changed. Editing one file in a 5,000-file repo costs one reparse,
 *     not five thousand.
 *
 *  2. **Two-stage search.** BM25 ranks *files* from the inverted index, then we
 *     read only the top files to find matching lines. Storing line-level
 *     postings would be far larger for no ranking benefit.
 */

import { extractExportList, extractImports } from '../lang/imports.js';
import { extractSymbols } from '../lang/outline.js';
import { detectLanguage, isStructured, syntaxFor } from '../lang/registry.js';
import { maskSource } from '../lang/scanner.js';
import type { CodeSymbol, ImportRef, LanguageId } from '../lang/types.js';
import { countCodeTerms, tokenizeCode } from '../util/text.js';
import { ParseCache, packTerms, unpackTerms } from './cache.js';
import { WorkspaceWatcher } from './watcher.js';
import { PackageMap } from './packages.js';
import { resolveSpecifier, type ResolutionContext } from './resolver.js';
import { Workspace, type WorkspaceFile } from './workspace.js';
import type { JellyBeanConfig } from '../config.js';

export interface FileRecord {
  index: number;
  path: string;
  language: LanguageId;
  size: number;
  mtimeMs: number;
  lineCount: number;
  symbols: CodeSymbol[];
  imports: ImportRef[];
  exports: string[];
  /** Workspace-internal files this one imports. */
  dependencies: Set<number>;
  /** Workspace-internal files that import this one. */
  dependents: Set<number>;
  /** External package specifiers this file pulls in. */
  externals: string[];
  /** Distinct indexed terms, used as the BM25 document length. */
  termCount: number;
  /** True when the file was too large or too binary to parse. */
  skipped: boolean;
}

/** Postings pack a file index and a capped term frequency into one number. */
const TF_BITS = 6;
const TF_MAX = (1 << TF_BITS) - 1;
/** Cap on distinct terms indexed per file, so one generated blob cannot dominate. */
const MAX_TERMS_PER_FILE = 4096;
/** How long a scan is considered fresh, in milliseconds. */
const FRESHNESS_MS = 1500;
/** Files read and parsed concurrently. Overlaps I/O without buffering the repo. */
const INDEX_CONCURRENCY = 32;

const BM25_K1 = 1.2;
const BM25_B = 0.75;

export interface FileScore {
  file: FileRecord;
  score: number;
}

export class CodeIndex {
  private readonly files = new Map<string, FileRecord>();
  private byIndex: (FileRecord | undefined)[] = [];
  private postings = new Map<string, number[]>();
  private documentFrequency = new Map<string, number>();
  /**
   * Lowercased symbol name → the files declaring it. Symbol search previously
   * walked every symbol of every file, which on a 16,000-file repository took
   * seconds; this makes an exact-name lookup constant time.
   */
  private symbolNames = new Map<string, Set<number>>();
  /** Final path segment → paths, retained so imports can be resolved on demand. */
  private byBasename = new Map<string, string[]>();
  private averageTermCount = 1;
  private nextIndex = 0;

  private lastScan = 0;
  private hasScanned = false;
  /** Files the in-flight walk found, so progress can be reported against it. */
  private scanTotal: number | null = null;
  private scanning: Promise<void> | null = null;
  private readonly cache: ParseCache;
  private readonly watcher: WorkspaceWatcher;
  /** Package boundaries, so cross-package coupling can be distinguished. */
  readonly packages = new PackageMap();

  constructor(
    private readonly workspace: Workspace,
    private readonly config: JellyBeanConfig,
    watcher?: WorkspaceWatcher,
  ) {
    this.cache = ParseCache.forWorkspace(workspace.root);
    this.watcher = watcher ?? new WorkspaceWatcher(workspace.root);
  }

  /** How many files the last scan restored from cache rather than parsing. */
  cacheHits = 0;

  /** Number of indexed files. */
  get fileCount(): number {
    return this.files.size;
  }

  /**
   * Whether the first scan has finished.
   *
   * Tools are *correct* before it does — they answer from whatever is indexed —
   * but the answers are incomplete, and on a large repository they are
   * incomplete for long enough that saying so is better than appearing to hang.
   */
  get ready(): boolean {
    return this.lastScan !== 0;
  }

  /** How far the current scan has got. `total` is unknown until the walk finishes. */
  progress(): { done: number; total: number | null } {
    return { done: this.files.size, total: this.scanTotal };
  }

  /** All records, in stable path order. */
  all(): FileRecord[] {
    return [...this.files.values()].sort((a, b) => (a.path < b.path ? -1 : 1));
  }

  get(path: string): FileRecord | undefined {
    return this.files.get(path);
  }

  at(index: number): FileRecord | undefined {
    return this.byIndex[index];
  }

  /**
   * Bring the index up to date. Called at the start of every tool invocation,
   * so its cost when nothing has changed is what determines whether tools feel
   * instant on a large repository.
   *
   * When the filesystem watcher is running, "nothing has changed" is free. When
   * it is not, we fall back to a timer, which re-walks the tree at most that
   * often. Concurrent callers always share a single in-flight scan.
   */
  async ensureFresh(force = false): Promise<void> {
    if (!force) {
      if (this.watcher.watching) {
        // Authoritative: the watcher has seen every change since the last scan.
        if (!this.watcher.hasChanges) return;
      } else if (Date.now() - this.lastScan < FRESHNESS_MS) {
        return;
      }
    }
    if (this.scanning) return this.scanning;

    // Taken before the scan, not after: a change arriving mid-scan must be
    // recorded for the next one rather than swallowed by our own completion.
    // A forced scan ignores the hint and re-walks, because "force" is what a
    // caller reaches for precisely when it does not trust the watcher.
    const pending = this.watcher.watching && !force ? this.watcher.take().paths : null;

    this.scanning = this.scan(pending).finally(() => {
      this.scanning = null;
      this.lastScan = Date.now();
    });
    return this.scanning;
  }

  /** Begin watching for changes. Safe to call more than once. */
  startWatching(): boolean {
    return this.watcher.start();
  }

  /** Stop watching. The index falls back to periodic rescans. */
  stopWatching(): void {
    this.watcher.stop();
  }

  /**
   * Shut down cleanly: stop watching and make the cache durable.
   *
   * Cache writes are debounced, so one is very often still pending when the
   * server is asked to exit. Skipping this loses it, and the next start
   * re-parses the whole repository to learn what it already knew.
   */
  async close(): Promise<void> {
    this.watcher.stop();
    await this.cache.flush();
  }

  /**
   * Bring the index up to date.
   *
   * `hint` is the set of paths the watcher saw change. When present, only those
   * are examined — an editor save costs a handful of `stat` calls rather than a
   * walk of the entire tree, which is the difference between a live session
   * feeling instant and feeling broken. When absent, the tree is walked.
   */
  private async scan(hint: readonly string[] | null): Promise<void> {
    await this.cache.load();

    let stale: WorkspaceFile[] = [];
    let gone: string[] = [];
    /** True when the file *set* changed, not merely file contents. */
    let membershipChanged = false;
    let seen: Set<string> | null = null;

    // Some files decide what the *rest* of the scan means, and a targeted scan
    // cannot evaluate them: a .gitignore edit changes which files exist as far
    // as we are concerned (and the targeted path inherits the last walk's rules,
    // so it cannot judge itself), and a manifest appearing or vanishing moves a
    // package boundary, which only `discover` over the full file list can see.
    const needsFullWalk = hint?.some(decidesScanShape) ?? false;
    const targeted = hint !== null && hint.length > 0 && !needsFullWalk
      ? await this.workspace.statPaths(hint)
      : null;

    if (hint !== null && hint.length === 0) return; // watcher fired, nothing indexable

    if (targeted) {
      for (const entry of targeted.present) {
        const existing = this.files.get(entry.path);
        if (existing && existing.size === entry.size && existing.mtimeMs === entry.mtimeMs) continue;
        if (!existing) membershipChanged = true;
        stale.push(entry);
      }
      for (const path of targeted.absent) {
        if (!this.files.has(path)) continue;
        gone.push(path);
        membershipChanged = true;
      }
    } else {
      const found = await this.workspace.walk(this.config.maxFiles);
      this.scanTotal = found.length;
      seen = new Set<string>();
      for (const entry of found) {
        seen.add(entry.path);
        const existing = this.files.get(entry.path);
        if (existing && existing.size === entry.size && existing.mtimeMs === entry.mtimeMs) continue;
        if (!existing) membershipChanged = true;
        stale.push(entry);
      }
      for (const path of this.files.keys()) {
        if (!seen.has(path)) {
          gone.push(path);
          membershipChanged = true;
        }
      }
    }

    if (stale.length === 0 && gone.length === 0) return;

    // Retire every affected file's postings in a single sweep. Doing it per file
    // would re-walk the whole term table once per file, which turns a 50-file
    // change in a large repository into tens of millions of comparisons.
    const retiring = new Set<number>();
    for (const entry of stale) {
      const existing = this.files.get(entry.path);
      if (existing) retiring.add(existing.index);
    }
    for (const path of gone) {
      const existing = this.files.get(path);
      if (existing) retiring.add(existing.index);
    }
    this.unindexTerms(retiring);

    for (const path of gone) this.dropRecord(path);

    // Index in bounded-concurrency batches. Reading is I/O-bound and benefits
    // from overlap; parsing is CPU-bound and does not, so an unbounded
    // Promise.all would just buffer every file's contents in memory at once.
    for (let i = 0; i < stale.length; i += INDEX_CONCURRENCY) {
      const batch = stale.slice(i, i + INDEX_CONCURRENCY);
      await Promise.all(batch.map((entry) => this.indexFile(entry, this.files.get(entry.path))));
    }

    // Package boundaries and cache pruning both need the full file list, which
    // only a walk produces. A targeted scan cannot have moved a package boundary,
    // because a manifest in the hint sends us down the walk path instead.
    if (seen) {
      await this.packages.discover(this.workspace, [...seen]);
      this.cache.retain(seen);
    } else if (membershipChanged) {
      for (const path of gone) this.cache.delete(path);
    }

    this.recomputeStatistics();

    if (membershipChanged) {
      // A new or deleted file can change edges anywhere: an import that
      // previously resolved to nothing may now resolve, and vice versa. Only a
      // full pass can find those.
      this.rebuildGraph();
    } else {
      // Contents changed but the file set did not, so only the edited files'
      // own outgoing edges can differ. This is the common case in a live
      // session and rebuilding the whole graph for it is pure waste.
      this.updateGraphFor(stale.map((entry) => entry.path));
    }

    // The first scan is the one worth writing straight away: it parsed the whole
    // repository, and if the process dies before a debounced write lands, the
    // next start does all of it again. Later scans reparse a handful of files,
    // so coalescing their writes costs nothing worth having.
    if (this.hasScanned) this.cache.scheduleSave();
    else await this.cache.flush();
    this.hasScanned = true;
  }

  private async indexFile(entry: WorkspaceFile, existing: FileRecord | undefined): Promise<void> {
    // The previous revision's names must go before the new ones arrive, or a
    // renamed symbol stays findable under both names indefinitely. Its outgoing
    // edges must go for the same reason, and while it is still in hand: once the
    // new record is installed, the old dependency list is gone and the importers
    // it pointed at would keep listing this file forever.
    if (existing) {
      this.removeSymbolNames(existing);
      this.detachOutgoing(existing);
    }

    const language = detectLanguage(entry.path);
    const record: FileRecord = {
      index: existing?.index ?? this.nextIndex++,
      path: entry.path,
      language,
      size: entry.size,
      mtimeMs: entry.mtimeMs,
      lineCount: 0,
      symbols: [],
      imports: [],
      exports: [],
      dependencies: new Set(),
      // Incoming edges are other files' imports, which editing this file cannot
      // have changed. Carrying them across is what makes a one-file rescan cost
      // one file: recomputing them would mean revisiting every importer.
      dependents: existing?.dependents ?? new Set(),
      externals: [],
      termCount: 0,
      skipped: false,
    };

    // A cached parse for this exact revision means no read and no parse at all,
    // which is the difference between a server that starts instantly and one
    // that makes you wait through the whole repository first.
    const cached = this.cache.get(entry.path, entry.size, entry.mtimeMs);
    if (cached) {
      record.language = cached.l;
      record.lineCount = cached.n;
      record.symbols = cached.y;
      record.imports = cached.i;
      record.exports = cached.e;
      record.skipped = cached.k;
      this.applyTerms(record, unpackTerms(cached.t));

      this.commit(record);
      this.cacheHits++;
      return;
    }

    const text = await this.workspace.readText(entry.path, this.config.maxFileBytes);
    let frequencies = new Map<string, number>();

    if (text === null) {
      record.skipped = true;
    } else {
      record.lineCount = countLines(text);
      if (isStructured(language)) {
        try {
          // Mask once and share. Masking is the most expensive step in indexing,
          // and symbols and imports each used to do it independently.
          const masked = maskSource(text, syntaxFor(language));
          record.symbols = extractSymbols(text, language, masked);
          record.imports = extractImports(text, language, masked);
        } catch {
          // A malformed file must never take down a scan. It simply gets no outline.
          record.symbols = [];
          record.imports = [];
        }
      }
      record.exports = collectExports(record.symbols, text, language);
      frequencies = this.countTerms(record, text);
      this.applyTerms(record, frequencies);
    }

    this.cache.set(entry.path, {
      s: entry.size,
      m: entry.mtimeMs,
      l: record.language,
      n: record.lineCount,
      y: record.symbols,
      i: record.imports,
      e: record.exports,
      t: packTerms(frequencies),
      k: record.skipped,
    });

    this.commit(record);
  }

  /**
   * Install a finished record into every structure that must know about it.
   *
   * One function rather than open-coding it at each call site, because there are
   * two paths into the index — cached and freshly parsed — and they *did* drift:
   * the cached path once omitted the symbol-name registration, which silently
   * emptied the name index on any warm start and made symbol lookups return
   * nothing at all.
   */
  private commit(record: FileRecord): void {
    this.files.set(record.path, record);
    this.byIndex[record.index] = record;
    this.addSymbolNames(record);
  }

  /** Forget a record. Its postings must already have been retired. */
  private dropRecord(path: string): void {
    const record = this.files.get(path);
    if (!record) return;
    this.removeSymbolNames(record);
    // A deletion always triggers a full graph rebuild, which would clear these
    // anyway — but leaving edges pointing at a record that no longer exists
    // means every structure is briefly lying, and something will eventually read
    // it in that window.
    this.detachOutgoing(record);
    for (const index of record.dependents) {
      this.byIndex[index]?.dependencies.delete(record.index);
    }
    this.files.delete(path);
    this.byIndex[record.index] = undefined;
  }

  /** Remove this record from the `dependents` of everything it imports. */
  private detachOutgoing(record: FileRecord): void {
    for (const index of record.dependencies) {
      this.byIndex[index]?.dependents.delete(record.index);
    }
  }

  private addSymbolNames(record: FileRecord): void {
    for (const symbol of record.symbols) {
      const key = symbol.name.toLowerCase();
      const bucket = this.symbolNames.get(key);
      if (bucket) bucket.add(record.index);
      else this.symbolNames.set(key, new Set([record.index]));
    }
  }

  private removeSymbolNames(record: FileRecord): void {
    for (const symbol of record.symbols) {
      const key = symbol.name.toLowerCase();
      const bucket = this.symbolNames.get(key);
      if (!bucket) continue;
      bucket.delete(record.index);
      if (bucket.size === 0) this.symbolNames.delete(key);
    }
  }

  /**
   * Files declaring a symbol with exactly this name. Undefined when none do,
   * which lets callers skip a repository-wide scan entirely.
   */
  private resolutionContext(): ResolutionContext {
    return {
      has: (path) => this.files.has(path),
      byBasename: (name) => this.byBasename.get(name) ?? [],
    };
  }

  /**
   * Resolve one import specifier as written in `fromPath`. Returns null for an
   * external package or an unresolvable path — the same judgement the graph makes.
   */
  resolveImport(fromPath: string, specifier: string): string | null {
    const from = this.files.get(fromPath);
    if (!from) return null;
    return resolveSpecifier(specifier, fromPath, from.language, this.resolutionContext());
  }

  /** Every distinct symbol name in the workspace, with the files declaring it. */
  allSymbolNames(): IterableIterator<[string, ReadonlySet<number>]> {
    return this.symbolNames.entries();
  }

  filesDeclaring(name: string): FileRecord[] {
    const bucket = this.symbolNames.get(name.toLowerCase());
    if (!bucket) return [];
    const out: FileRecord[] = [];
    for (const index of bucket) {
      const record = this.byIndex[index];
      if (record) out.push(record);
    }
    return out;
  }

  // -- inverted index ------------------------------------------------------

  /**
   * Count the search terms in a file. Pure — it writes no postings — so the
   * result can be cached and replayed without re-reading the source.
   */
  private countTerms(record: FileRecord, text: string): Map<string, number> {
    const frequencies = new Map<string, number>();
    // Streamed rather than collected: a repository-wide index otherwise
    // allocates tens of millions of short-lived strings, which dominated
    // indexing time.
    countCodeTerms(text, (term) => {
      const current = frequencies.get(term);
      if (current === undefined) {
        if (frequencies.size >= MAX_TERMS_PER_FILE) return;
        frequencies.set(term, 1);
      } else {
        frequencies.set(term, current + 1);
      }
    });

    // Symbol names carry more signal than their surrounding text; counting them
    // again is a cheap, principled way to bias ranking toward definitions.
    for (const symbol of record.symbols) {
      for (const term of tokenizeCode(symbol.name)) {
        const current = frequencies.get(term);
        if (current !== undefined) frequencies.set(term, current + 3);
      }
    }

    return frequencies;
  }

  /** Write a file's term frequencies into the inverted index. */
  private applyTerms(record: FileRecord, frequencies: ReadonlyMap<string, number>): void {
    for (const [term, tf] of frequencies) {
      const packed = (record.index << TF_BITS) | Math.min(tf, TF_MAX);
      const list = this.postings.get(term);
      if (list) list.push(packed);
      else this.postings.set(term, [packed]);
      this.documentFrequency.set(term, (this.documentFrequency.get(term) ?? 0) + 1);
    }
    record.termCount = frequencies.size;
  }

  /**
   * Remove every posting belonging to the given file indices, in one pass over
   * the term table. Called once per scan, never once per file.
   */
  private unindexTerms(fileIndices: ReadonlySet<number>): void {
    if (fileIndices.size === 0) return;

    for (const [term, list] of this.postings) {
      const kept = list.filter((packed) => !fileIndices.has(packed >>> TF_BITS));
      if (kept.length === list.length) continue;
      if (kept.length === 0) {
        this.postings.delete(term);
        this.documentFrequency.delete(term);
      } else {
        this.postings.set(term, kept);
        this.documentFrequency.set(term, kept.length);
      }
    }

    for (const index of fileIndices) {
      const record = this.byIndex[index];
      if (record) record.termCount = 0;
    }
  }

  private recomputeStatistics(): void {
    let total = 0;
    let counted = 0;
    for (const record of this.files.values()) {
      if (record.termCount === 0) continue;
      total += record.termCount;
      counted++;
    }
    this.averageTermCount = counted > 0 ? total / counted : 1;
  }

  /** Rank files against a free-text query using BM25. */
  searchFiles(query: string, limit: number): FileScore[] {
    const terms = [...new Set(tokenizeCode(query))];
    if (terms.length === 0) return [];

    const total = Math.max(1, this.files.size);
    const scores = new Map<number, number>();

    for (const term of terms) {
      const list = this.postings.get(term);
      if (!list) continue;
      const df = this.documentFrequency.get(term) ?? list.length;
      const idf = Math.log(1 + (total - df + 0.5) / (df + 0.5));

      for (const packed of list) {
        const fileIndex = packed >>> TF_BITS;
        const tf = packed & TF_MAX;
        const record = this.byIndex[fileIndex];
        if (!record) continue;

        const norm = 1 - BM25_B + (BM25_B * record.termCount) / this.averageTermCount;
        const contribution = (idf * (tf * (BM25_K1 + 1))) / (tf + BM25_K1 * norm);
        scores.set(fileIndex, (scores.get(fileIndex) ?? 0) + contribution);
      }
    }

    const ranked: FileScore[] = [];
    for (const [fileIndex, score] of scores) {
      const file = this.byIndex[fileIndex];
      if (file) ranked.push({ file, score });
    }
    ranked.sort((a, b) => b.score - a.score);
    return ranked.slice(0, limit);
  }

  // -- import graph --------------------------------------------------------

  private rebuildGraph(): void {
    for (const record of this.files.values()) {
      record.dependencies.clear();
      record.dependents.clear();
      record.externals = [];
    }

    // Basename index, so the resolver can match `pkg/util` against `src/pkg/util.go`
    // without scanning every path for every import. Kept afterwards so a single
    // specifier can be resolved later without rebuilding it.
    this.byBasename = new Map<string, string[]>();
    for (const path of this.files.keys()) {
      const name = path.slice(path.lastIndexOf('/') + 1);
      const bucket = this.byBasename.get(name);
      if (bucket) bucket.push(path);
      else this.byBasename.set(name, [path]);
    }

    const ctx = this.resolutionContext();

    for (const record of this.files.values()) {
      for (const ref of record.imports) {
        const targetPath = resolveSpecifier(ref.specifier, record.path, record.language, ctx);
        if (targetPath === null) {
          if (!record.externals.includes(ref.specifier)) record.externals.push(ref.specifier);
          continue;
        }
        const target = this.files.get(targetPath);
        if (!target || target.index === record.index) continue;
        record.dependencies.add(target.index);
        target.dependents.add(record.index);
      }
    }
  }

  /**
   * Recompute edges for specific files only.
   *
   * Valid when the file *set* is unchanged: an edited file's own imports may
   * differ, but no other file's specifier can have started or stopped
   * resolving, because nothing appeared or disappeared for it to resolve to.
   */
  private updateGraphFor(paths: readonly string[]): void {
    const ctx = this.resolutionContext();

    for (const path of paths) {
      const record = this.files.get(path);
      if (!record) continue;

      // The old outgoing edges were already detached by `indexFile`, which held
      // the previous revision. This record's dependency set is freshly empty.
      for (const ref of record.imports) {
        const targetPath = resolveSpecifier(ref.specifier, record.path, record.language, ctx);
        if (targetPath === null) {
          if (!record.externals.includes(ref.specifier)) record.externals.push(ref.specifier);
          continue;
        }
        const target = this.files.get(targetPath);
        if (!target || target.index === record.index) continue;
        record.dependencies.add(target.index);
        target.dependents.add(record.index);
      }
    }
  }

  /**
   * Structural importance of a file, used to order the repository map.
   *
   * Weighted toward being depended upon: in practice the files an agent most
   * needs to see first are the ones everything else imports.
   */
  importance(record: FileRecord): number {
    const inbound = record.dependents.size;
    const outbound = record.dependencies.size;
    const surface = record.exports.length;
    const entrypoint = isEntrypoint(record.path) ? 4 : 0;
    return 3 * Math.log1p(inbound) + 0.5 * Math.log1p(outbound) + 0.3 * Math.log1p(surface) + entrypoint;
  }
}

/**
 * Files whose appearance or disappearance changes the meaning of the scan
 * itself, rather than merely the contents of one record.
 */
const SCAN_SHAPING_NAMES = new Set(['.gitignore', 'package.json', 'Cargo.toml', 'go.mod', 'pyproject.toml']);

function decidesScanShape(path: string): boolean {
  return SCAN_SHAPING_NAMES.has(path.slice(path.lastIndexOf('/') + 1));
}

function countLines(text: string): number {
  if (text === '') return 0;
  let lines = 1;
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') lines++;
  if (text.endsWith('\n')) lines--;
  return lines;
}

function collectExports(symbols: readonly CodeSymbol[], text: string, language: LanguageId): string[] {
  const names = new Set<string>();
  for (const symbol of symbols) {
    if (symbol.exported && symbol.depth === 0) names.add(symbol.name);
  }
  for (const name of extractExportList(text, language)) names.add(name);
  return [...names];
}

const ENTRYPOINT_NAMES = new Set([
  'index', 'main', 'app', 'server', 'cli', 'mod', '__init__', '__main__', 'lib', 'setup',
]);

function isEntrypoint(path: string): boolean {
  const base = path.slice(path.lastIndexOf('/') + 1);
  const stem = base.slice(0, base.lastIndexOf('.') === -1 ? base.length : base.lastIndexOf('.'));
  return ENTRYPOINT_NAMES.has(stem.toLowerCase());
}
