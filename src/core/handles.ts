/**
 * Handles: stable, short references to a region of the workspace.
 *
 * The core token-saving idea. Instead of returning a file's contents so the
 * agent can decide whether it wanted them, tools return a one-line summary
 * plus a handle like `jb_3f9a21c4`. The agent spends tokens on the body only
 * for the handles it actually follows.
 *
 * Handle IDs are derived from the region they point at, so the same region
 * always yields the same handle — an agent can recognise that a search hit and
 * an outline entry refer to the same function without expanding either.
 */

import { createHash } from 'node:crypto';

export interface HandleTarget {
  /** Workspace-relative path. */
  path: string;
  /** 1-based, inclusive. */
  startLine: number;
  /** 1-based, inclusive. */
  endLine: number;
  /** What the region is, for rendering: `function`, `file`, `match`, … */
  kind: string;
  /** Short human label, e.g. a symbol name. */
  label: string;
}

const ID_PREFIX = 'jb_';
const ID_PATTERN = /^jb_[0-9a-f]{8}$/;

/**
 * A bounded store of handles.
 *
 * Bounded because a long session can mint thousands; unbounded growth would be
 * a slow leak in a process that is meant to run for hours. Eviction is
 * least-recently-used, and because IDs are content-derived, an evicted handle
 * is simply re-minted the next time the same region is surfaced.
 */
export class HandleStore {
  private readonly entries = new Map<string, HandleTarget>();

  constructor(private readonly capacity = 4096) {}

  /** Mint (or refresh) a handle for a region. */
  mint(target: HandleTarget): string {
    const id = handleId(target);
    // Re-inserting moves the key to the end of the Map's iteration order, which
    // is what makes plain Map deletion order equal to LRU order.
    this.entries.delete(id);
    this.entries.set(id, target);

    if (this.entries.size > this.capacity) {
      const oldest = this.entries.keys().next();
      if (!oldest.done) this.entries.delete(oldest.value);
    }
    return id;
  }

  /** Look up a handle, marking it as recently used. */
  get(id: string): HandleTarget | undefined {
    const target = this.entries.get(id);
    if (!target) return undefined;
    this.entries.delete(id);
    this.entries.set(id, target);
    return target;
  }

  get size(): number {
    return this.entries.size;
  }
}

/** Deterministic ID for a region. */
export function handleId(target: HandleTarget): string {
  const key = `${target.path}:${target.startLine}:${target.endLine}:${target.kind}`;
  return ID_PREFIX + createHash('sha1').update(key).digest('hex').slice(0, 8);
}

/** Whether a string is shaped like a handle. */
export function isHandle(value: string): boolean {
  return ID_PATTERN.test(value);
}
