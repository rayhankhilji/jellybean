/**
 * Filesystem watching.
 *
 * Without this, staying up to date means re-walking the tree on a timer, and
 * every tool call that lands after the timer expires pays for it. On a large
 * repository that walk is measured in seconds — so the tool an agent called
 * appears to take ten seconds when the work it did took four milliseconds.
 *
 * Watching inverts it: the index is fresh until the filesystem says otherwise,
 * so the common case costs nothing. When watching is unavailable we fall back to
 * the timer, which is slower but never wrong.
 */

import { watch, type FSWatcher } from 'node:fs';

/** Events arriving within this window are treated as one change. */
const DEBOUNCE_MS = 120;

/** Path segments whose changes never affect the index. */
const NOISE = /(?:^|[/\\])(?:\.git|node_modules|dist|build|out|target|coverage|\.next|__pycache__|\.venv)(?:[/\\]|$)/;

export class WorkspaceWatcher {
  private watcher: FSWatcher | null = null;
  private timer: NodeJS.Timeout | null = null;
  private dirty = true;
  private supported = false;

  constructor(private readonly root: string) {}

  /**
   * Begin watching. Returns whether the platform supports recursive watching —
   * callers use that to decide whether they still need the timer fallback.
   */
  start(): boolean {
    if (this.watcher) return this.supported;
    try {
      this.watcher = watch(this.root, { recursive: true, persistent: false }, (_event, filename) => {
        // A build writing thousands of files into dist/ must not invalidate the
        // index thousands of times; those paths are not indexed anyway.
        if (filename && NOISE.test(filename.toString())) return;
        this.markDirty();
      });
      // A watcher that dies must not silently freeze the index forever.
      this.watcher.on('error', () => this.stop());
      this.supported = true;
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
    // Anything that happens after we stop watching is unobserved, so from here
    // on the index must be treated as potentially stale.
    this.dirty = true;
  }

  /** Whether watching is active and therefore trustworthy. */
  get watching(): boolean {
    return this.supported;
  }

  /** Whether the tree may have changed since `clear` was last called. */
  get changed(): boolean {
    return this.dirty;
  }

  /** Called after a successful scan to record that the index is current. */
  clear(): void {
    this.dirty = false;
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
