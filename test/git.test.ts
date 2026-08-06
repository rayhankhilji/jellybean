import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { changedFiles, defaultBase, isRepository, parseDiff } from '../src/core/git.js';
import { run } from '../src/diagnostics/runner.js';

test('a modified file yields its changed ranges and counts', () => {
  const diff = [
    'diff --git a/src/store.ts b/src/store.ts',
    'index 1111111..2222222 100644',
    '--- a/src/store.ts',
    '+++ b/src/store.ts',
    '@@ -10,2 +10,3 @@',
    '-old line',
    '-another old',
    '+new line',
    '+second new',
    '+third new',
    '@@ -40,0 +42,1 @@',
    '+appended',
  ].join('\n');

  const files = parseDiff(diff);
  assert.equal(files.length, 1);
  const file = files[0]!;
  assert.equal(file.path, 'src/store.ts');
  assert.equal(file.status, 'modified');
  assert.deepEqual(file.ranges, [
    [10, 12],
    [42, 42],
  ]);
  assert.equal(file.added, 4);
  assert.equal(file.removed, 2);
});

test('an added file is reported as added, not modified', () => {
  const diff = [
    'diff --git a/src/new.ts b/src/new.ts',
    'new file mode 100644',
    '--- /dev/null',
    '+++ b/src/new.ts',
    '@@ -0,0 +1,2 @@',
    '+export const a = 1;',
    '+export const b = 2;',
  ].join('\n');

  const file = parseDiff(diff)[0]!;
  assert.equal(file.status, 'added');
  assert.equal(file.path, 'src/new.ts');
  assert.deepEqual(file.ranges, [[1, 2]]);
});

test('a deleted file keeps its original path', () => {
  const diff = [
    'diff --git a/src/gone.ts b/src/gone.ts',
    'deleted file mode 100644',
    '--- a/src/gone.ts',
    '+++ /dev/null',
    '@@ -1,2 +0,0 @@',
    '-export const a = 1;',
    '-export const b = 2;',
  ].join('\n');

  const file = parseDiff(diff)[0]!;
  assert.equal(file.status, 'deleted');
  assert.equal(file.path, 'src/gone.ts', 'a deleted file must not be named /dev/null');
  assert.equal(file.removed, 2);
});

test('a rename records where the file came from', () => {
  const diff = [
    'diff --git a/src/old-name.ts b/src/new-name.ts',
    'similarity index 95%',
    'rename from src/old-name.ts',
    'rename to src/new-name.ts',
    '--- a/src/old-name.ts',
    '+++ b/src/new-name.ts',
    '@@ -3,1 +3,1 @@',
    '-const a = 1;',
    '+const a = 2;',
  ].join('\n');

  const file = parseDiff(diff)[0]!;
  assert.equal(file.status, 'renamed');
  assert.equal(file.path, 'src/new-name.ts');
  assert.equal(file.previousPath, 'src/old-name.ts');
});

test('several files in one diff are kept separate', () => {
  const diff = [
    'diff --git a/a.ts b/a.ts',
    '--- a/a.ts',
    '+++ b/a.ts',
    '@@ -1,1 +1,1 @@',
    '-a',
    '+A',
    'diff --git a/b.ts b/b.ts',
    '--- a/b.ts',
    '+++ b/b.ts',
    '@@ -5,1 +5,2 @@',
    '+B',
    '+B2',
  ].join('\n');

  const files = parseDiff(diff);
  assert.deepEqual(
    files.map((f) => f.path).sort(),
    ['a.ts', 'b.ts'],
  );
  assert.deepEqual(files.find((f) => f.path === 'b.ts')!.ranges, [[5, 6]]);
});

test('a hunk header without a count means a single line', () => {
  const diff = ['diff --git a/x.ts b/x.ts', '--- a/x.ts', '+++ b/x.ts', '@@ -7 +7 @@', '-x', '+y'].join('\n');
  assert.deepEqual(parseDiff(diff)[0]!.ranges, [[7, 7]]);
});

test('empty and non-diff input parse to nothing', () => {
  assert.deepEqual(parseDiff(''), []);
  assert.deepEqual(parseDiff('fatal: not a git repository\n'), []);
});

test('the parser is reentrant across calls', () => {
  // An earlier version kept module-level state between files, so a second call
  // inherited the first's rename and deletion flags.
  const added = ['diff --git a/n.ts b/n.ts', '--- /dev/null', '+++ b/n.ts', '@@ -0,0 +1,1 @@', '+x'].join('\n');
  const plain = ['diff --git a/p.ts b/p.ts', '--- a/p.ts', '+++ b/p.ts', '@@ -1,1 +1,1 @@', '-a', '+b'].join('\n');

  assert.equal(parseDiff(added)[0]!.status, 'added');
  assert.equal(parseDiff(plain)[0]!.status, 'modified', 'state leaked from the previous parse');
  assert.equal(parseDiff(added)[0]!.status, 'added');
});

/**
 * The rest of this file drives real `git` against real repositories.
 *
 * `defaultBase` guesses which branch you forked from, which is a convention
 * rather than something git records, and it is now answered from one listing of
 * every ref instead of one lookup per candidate. That rewrite is only correct if
 * it still picks the same branch, including the precedence between candidates.
 */

async function inRepo(body: (root: string) => Promise<void>, setup: readonly string[][] = []): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'jellybean-git-'));
  try {
    await writeFile(join(root, 'a.txt'), 'one\n', 'utf8');
    const commands = [
      ['git', 'init', '--quiet'],
      ['git', 'config', 'user.email', 'test@example.com'],
      ['git', 'config', 'user.name', 'Test'],
      ['git', 'config', 'commit.gpgsign', 'false'],
      ['git', 'add', '.'],
      ['git', 'commit', '--quiet', '-m', 'first'],
      ...setup,
    ];
    for (const argv of commands) {
      const result = await run(argv, root, 20_000);
      assert.equal(result.exitCode, 0, `${argv.join(' ')} failed: ${result.output}`);
    }
    await body(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('defaultBase finds a conventional branch, and prefers the remote one', async () => {
  await inRepo(
    async (root) => {
      assert.equal(await defaultBase(root), 'origin/main');
    },
    [
      ['git', 'branch', '-m', 'main'],
      ['git', 'branch', 'develop'],
      // A remote-tracking ref, without a remote to fetch from.
      ['git', 'update-ref', 'refs/remotes/origin/main', 'HEAD'],
    ],
  );
});

test('defaultBase falls back to a local branch when there is no remote', async () => {
  await inRepo(
    async (root) => {
      assert.equal(await defaultBase(root), 'master');
    },
    [['git', 'branch', '-m', 'master']],
  );
});

test('defaultBase returns null rather than guessing when nothing conventional exists', async () => {
  await inRepo(
    async (root) => {
      assert.equal(await defaultBase(root), null);
    },
    [['git', 'branch', '-m', 'wip/experiment']],
  );
});

test('changedFiles reports edits and untracked files together', async () => {
  await inRepo(async (root) => {
    await writeFile(join(root, 'a.txt'), 'one\ntwo\n', 'utf8');
    await writeFile(join(root, 'b.txt'), 'new file\n', 'utf8');

    const files = await changedFiles(root, null);
    const byPath = new Map(files.map((f) => [f.path, f]));

    assert.equal(byPath.get('a.txt')?.status, 'modified');
    assert.equal(byPath.get('a.txt')?.added, 1);
    // An untracked file has no diff at all; omitting it makes "what have I
    // changed" wrong in the most common case of all, a brand new file.
    assert.equal(byPath.get('b.txt')?.status, 'untracked');
  });
});

test('isRepository is false outside a working tree', async () => {
  const root = await mkdtemp(join(tmpdir(), 'jellybean-nogit-'));
  try {
    assert.equal(await isRepository(root), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
