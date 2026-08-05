/**
 * Filesystem watching.
 *
 * Without this, staying up to date means re-walking the tree on a timer, and
 * every tool call that lands after the timer expires pays for it. On a large
 * repository that walk is measured in seconds — so the tool an agent called
 * appears to take ten seconds when the work it did took four milliseconds.
 *
 * Watching inverts it twice over. The index is fresh until the filesystem says
 * otherwise, so the common case costs nothing; and when something *does* change
 * the watcher knows which paths, so the rescan can stat five files instead of
 * walking five thousand.
 *
 * When watching is unavailable we fall back to the timer, which is slower but
 * never wrong.
 */

import { watch, type FSWatcher } from 'node:fs';

/** Events arriving within this window are treated as one change. */
const DEBOUNCE_MS = 120;

/**
 * Beyond this many distinct paths, listing them is not worth it — a branch
 * switch or an `npm install` touches thousands, and a full walk is both simpler
 * and faster than statting them one by one.
 */
const MAX_TRACKED_PATHS = 400;

/**
 * How long before a full walk is forced regardless of what the watcher saw.
 *
 * Recursive watching drops events under load, and on some network filesystems
 * it silently reports nothing at all. Re-walking occasionally means a missed
 * event costs a minute of staleness rather than lasting until restart.
 */
const FULL_SWEEP_INTERVAL_MS = 60_000;

/** Path segments whose changes never affect the index. */
const NOISE = /(?:^|[/\\])(?:\.git|node_modules|dist|build|out|target|coverage|\.next|__pycache__|\.venv)(?:[/\\]|$)/;

/** What changed since the last scan. */
export interface PendingChanges {
  /**
   * Specific paths, relative to the root — or null when the watcher cannot
   * account for everything and the caller must walk the tree.
   */
  paths: string[] | null;
}

export class WorkspaceWatcher {
  private watcher: FSWatcher | null = null;
  private timer: NodeJS.Timeout | null = null;
  private supported = false;

  private dirty = true;
  /** Paths seen since the last scan; abandoned once it exceeds the cap. */
  private changed = new Set<string>();
  private overflowed = true;
  private lastFullSweep = 0;

  constructor(private readonly root: string) {}

  /**
   * Begin watching. Returns whether the platform supports recursive watching —
   * callers use that to decide whether they still need the timer fallback.
   */
  start(): boolean {
    if (this.watcher) return this.supported;
    try {
      this.watcher = watch(this.root, { recursive: true, persistent: false }, (_event, filename) => {
        if (!filename) {
          // An event we cannot attribute to a path; the tree must be re-walked.
          this.overflowed = true;
          this.markDirty();
          return;
        }
        const path = filename.toString().split('\\').join('/');
        // A build writing thousands of files into dist/ must not invalidate the
        // index thousands of times; those paths are not indexed anyway.
        if (NOISE.test(path)) return;

        if (this.changed.size >= MAX_TRACKED_PATHS) this.overflowed = true;
        else this.changed.add(path);
        this.markDirty();
      });
      this.watcher.on('error', () => this.stop());
      this.supported = true;

      // Watching begins immediately after the initial scan, so the tree has
      // just been walked. Without this the very first change would force a
      // redundant full sweep — the one moment we can be certain none is needed.
      this.lastFullSweep = Date.now();
      this.changed.clear();
      this.overflowed = false;
    } catch {
      // Recursive watching is unsupported here (some Linux kernels, some network
      // filesystems). The caller falls back to periodic rescanning.
      this.supported = false;
    }
    return this.supported;
  }

  stop(): void {
    this.watcher?.close();
    this.watcher = null;
    this.supported = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    // Anything after we stop watching is unobserved, so from here on the index
    // must be treated as potentially stale and unattributable.
    this.dirty = true;
    this.overflowed = true;
  }

  /** Whether watching is active and therefore trustworthy. */
  get watching(): boolean {
    return this.supported;
  }

  /** Whether the tree may have changed since `take` was last called. */
  get hasChanges(): boolean {
    return this.dirty;
  }

  /**
   * Consume the pending changes.
   *
   * Called *before* a scan rather than after, so a change arriving while the
   * scan runs is recorded for the next one instead of being swallowed by our
   * own completion.
   */
  take(): PendingChanges {
    const dueForSweep = Date.now() - this.lastFullSweep >= FULL_SWEEP_INTERVAL_MS;
    const paths = this.overflowed || dueForSweep ? null : [...this.changed];

    if (paths === null) this.lastFullSweep = Date.now();
    this.changed.clear();
    this.overflowed = false;
    this.dirty = false;
    return { paths };
  }

  private markDirty(): void {
    // Debounce: a single editor save often emits several events, and a git
    // checkout emits thousands. One rescan covers them all.
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
    }, DEBOUNCE_MS);
    this.timer.unref?.();
    this.dirty = true;
  }
}
