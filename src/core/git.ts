/**
 * Git inspection.
 *
 * The question "what have I changed, and what might it break?" is the one an
 * engineer asks before every pull request, and answering it from a raw `git
 * diff` is expensive: a thousand-line diff to discover that three functions
 * were touched. This module extracts the structure — which files, which line
 * ranges — so the tool layer can turn line ranges into symbol names.
 *
 * Commands run through the same shell-free path as `jb_diagnose`, and `git`
 * itself is a real executable rather than a batch wrapper, so no interpreter is
 * ever involved.
 */

import { run } from '../diagnostics/runner.js';

export type ChangeStatus = 'added' | 'modified' | 'deleted' | 'renamed' | 'untracked';

export interface ChangedFile {
  path: string;
  status: ChangeStatus;
  /** Where the file was before a rename. */
  previousPath?: string;
  /** 1-based line ranges touched in the *new* file, inclusive. */
  ranges: Array<[number, number]>;
  added: number;
  removed: number;
}

/** How long any single git invocation may take. */
const GIT_TIMEOUT_MS = 20_000;

/** Whether `root` is inside a git working tree. */
export async function isRepository(root: string): Promise<boolean> {
  const result = await run(['git', 'rev-parse', '--is-inside-work-tree'], root, GIT_TIMEOUT_MS);
  return result.exitCode === 0 && result.output.trim() === 'true';
}

/** The current branch name, or null when detached. */
export async function currentBranch(root: string): Promise<string | null> {
  const result = await run(['git', 'rev-parse', '--abbrev-ref', 'HEAD'], root, GIT_TIMEOUT_MS);
  const name = result.output.trim();
  return result.exitCode === 0 && name !== '' && name !== 'HEAD' ? name : null;
}

/**
 * Guess the branch this work forked from.
 *
 * There is no such thing as "the base branch" in git — it is a convention. We
 * try the usual names and pick the first that exists, rather than assuming.
 */
export async function defaultBase(root: string): Promise<string | null> {
  // One invocation listing every branch, rather than one `rev-parse` per
  // candidate. Six process spawns to discover that a shallow clone has none of
  // them was most of what jb_changes cost on a large repository.
  const result = await run(
    ['git', 'for-each-ref', '--format=%(refname:short)', 'refs/heads', 'refs/remotes'],
    root,
    GIT_TIMEOUT_MS,
  );
  if (result.exitCode !== 0) return null;

  const present = new Set(result.output.split('\n').map((line) => line.trim()));
  return BASE_CANDIDATES.find((candidate) => present.has(candidate)) ?? null;
}

/** Conventional base branch names, most specific first. */
const BASE_CANDIDATES = ['origin/main', 'origin/master', 'main', 'master', 'origin/develop', 'develop'];

/**
 * Files changed in the working tree, or between a base and HEAD.
 *
 * `base` of null means uncommitted work — everything not yet in HEAD, staged or
 * not, plus untracked files. A base compares the branch as a whole, using
 * `base...HEAD` so that commits landing on the base after you branched are not
 * reported as your changes.
 */
export async function changedFiles(root: string, base: string | null): Promise<ChangedFile[]> {
  const diffArgs = base
    ? ['git', 'diff', '--unified=0', '--no-color', '--find-renames', `${base}...HEAD`]
    : ['git', 'diff', '--unified=0', '--no-color', '--find-renames', 'HEAD'];

  // Untracked files have no diff at all, but they are unambiguously part of
  // "what have I changed" and omitting them makes the answer wrong. The two
  // invocations are independent, so they run together.
  const [diff, status] = await Promise.all([
    run(diffArgs, root, GIT_TIMEOUT_MS),
    base ? null : run(['git', 'status', '--porcelain=v1', '--untracked-files=all'], root, GIT_TIMEOUT_MS),
  ]);

  const files = parseDiff(diff.output);

  if (status) {
    for (const line of status.output.split('\n')) {
      if (!line.startsWith('?? ')) continue;
      const path = line.slice(3).trim();
      if (path === '' || files.some((f) => f.path === path)) continue;
      files.push({ path, status: 'untracked', ranges: [], added: 0, removed: 0 });
    }
  }

  return files.sort((a, b) => b.added + b.removed - (a.added + a.removed));
}

/**
 * Parse a unified diff into per-file changed line ranges.
 *
 * Only the hunk headers are needed — `@@ -old,count +new,count @@` gives the
 * range in the new file directly, which is what maps onto symbols. Reading the
 * bodies would mean holding the entire diff's content in memory for nothing.
 */
export function parseDiff(diff: string): ChangedFile[] {
  const files: ChangedFile[] = [];
  let current: ChangedFile | null = null;

  /** The `a/` side of the current file, needed to name a deletion or rename. */
  let oldPath: string | null = null;

  for (const line of diff.split('\n')) {
    // `diff --git a/old b/new` opens each file section and names both sides.
    const heading = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
    if (heading) {
      oldPath = heading[1]!;
      current = {
        path: heading[2]!,
        status: 'modified',
        ranges: [],
        added: 0,
        removed: 0,
      };
      if (oldPath !== current.path) {
        current.status = 'renamed';
        current.previousPath = oldPath;
      }
      files.push(current);
      continue;
    }
    if (!current) continue;

    // `--- /dev/null` means the file is new; `+++ /dev/null` means it is gone.
    // Both appear after the heading, so the record already exists.
    if (line === '--- /dev/null') {
      current.status = 'added';
      continue;
    }
    if (line === '+++ /dev/null') {
      current.status = 'deleted';
      if (oldPath) current.path = oldPath;
      continue;
    }
    if (line.startsWith('--- ') || line.startsWith('+++ ')) continue;

    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (hunk) {
      const start = Number(hunk[1]);
      const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
      // A zero-length hunk is a pure deletion: nothing of it exists in the new
      // file, but the surrounding line is still where the change happened.
      if (count === 0) current.ranges.push([Math.max(1, start), Math.max(1, start)]);
      else current.ranges.push([start, start + count - 1]);
      continue;
    }

    if (line.startsWith('+')) current.added++;
    else if (line.startsWith('-')) current.removed++;
  }

  return files;
}
