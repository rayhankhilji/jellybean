/**
 * Incremental rescan tests.
 *
 * A live session's cost is decided here: when the watcher can say *which* paths
 * changed, the index stats those instead of walking the tree, and updates only
 * the edited files' edges instead of rebuilding the whole graph. Both shortcuts
 * are only worth having if they land in exactly the same state as the slow path,
 * so most of these tests assert precisely that — targeted result equals full
 * walk — rather than asserting the shortcut merely "worked".
 *
 * The watcher is scripted rather than real. Real filesystem events are timing
 * dependent and platform dependent, and the thing under test is what the index
 * does with a hint, not whether macOS delivers one.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from '../src/config.js';
import { CodeIndex } from '../src/core/code-index.js';
import { Workspace } from '../src/core/workspace.js';
import { WorkspaceWatcher, type PendingChanges } from '../src/core/watcher.js';
import { ParseCache } from '../src/core/cache.js';

/**
 * A watcher whose reports the test dictates.
 *
 * `hasChanges` is false until something is queued, so a scan happens exactly
 * when the test says it does and never on a timer.
 */
class ScriptedWatcher extends WorkspaceWatcher {
  private queued: PendingChanges[] = [];

  override start(): boolean {
    return true;
  }

  override stop(): void {}

  override get watching(): boolean {
    return true;
  }

  override get hasChanges(): boolean {
    return this.queued.length > 0;
  }

  override take(): PendingChanges {
    return this.queued.shift() ?? { paths: [] };
  }

  /** `null` means "I lost track" — the index must fall back to a walk. */
  report(paths: string[] | null): void {
    this.queued.push({ paths });
  }
}

const FIXTURE: Record<string, string> = {
  'package.json': JSON.stringify({ name: 'fixture' }),
  '.gitignore': 'generated/\n',
  'src/index.ts': [
    "import { createStore } from './store.js';",
    "import { retry } from './retry.js';",
    // Deliberately unresolvable at first: creating this file later is what makes
    // the "a new file can create an edge elsewhere" case testable.
    "import { warm } from './cache.js';",
    '',
    'export function main(): void {',
    '  void retry(() => createStore());',
    '  void warm();',
    '}',
  ].join('\n'),
  'src/store.ts': ['export class Store {', '  load(): void {}', '}', '', 'export function createStore(): Store {', '  return new Store();', '}'].join('\n'),
  'src/retry.ts': ['export function retry<T>(operation: () => T): T {', '  return operation();', '}'].join('\n'),
  'generated/out.ts': 'export const GENERATED = 1;\n',
};

interface Fixture {
  root: string;
  workspace: Workspace;
  watcher: ScriptedWatcher;
  index: CodeIndex;
  /** Build a second index over the same tree the slow way, for comparison. */
  reference(): Promise<CodeIndex>;
  write(path: string, contents: string): Promise<void>;
  remove(path: string): Promise<void>;
}

async function withFixture(body: (f: Fixture) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'jellybean-incr-'));
  try {
    for (const [path, contents] of Object.entries(FIXTURE)) {
      await mkdir(join(root, path, '..'), { recursive: true });
      await writeFile(join(root, path), contents, 'utf8');
    }

    const { config } = parseArgs([root]);
    const workspace = new Workspace(config.root, config.ignore);
    const watcher = new ScriptedWatcher(config.root);
    const index = new CodeIndex(workspace, config, watcher);
    await index.ensureFresh(true);

    await body({
      root,
      workspace,
      watcher,
      index,
      async reference() {
        const fresh = new CodeIndex(new Workspace(config.root, config.ignore), config);
        await fresh.ensureFresh(true);
        return fresh;
      },
      async write(path, contents) {
        await mkdir(join(root, path, '..'), { recursive: true });
        await writeFile(join(root, path), contents, 'utf8');
      },
      async remove(path) {
        await rm(join(root, path), { force: true });
      },
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/**
 * Everything about the index that a tool can observe, keyed by path.
 *
 * Edges are rendered as paths rather than the internal file indexes, which are
 * assigned in discovery order and so legitimately differ between two indexes
 * that describe the same tree.
 */
function snapshot(index: CodeIndex): string {
  const edges = (set: ReadonlySet<number>): string =>
    [...set]
      .map((i) => index.at(i)?.path ?? '<dangling>')
      .sort()
      .join(' ');

  return index
    .all()
    .map((record) =>
      [
        record.path,
        `lang=${record.language}`,
        `symbols=${record.symbols.map((s) => `${s.kind}:${s.name}`).join(',')}`,
        `exports=${[...record.exports].sort().join(',')}`,
        `externals=${[...record.externals].sort().join(',')}`,
        `deps=${edges(record.dependencies)}`,
        `dependents=${edges(record.dependents)}`,
      ].join(' | '),
    )
    .join('\n');
}

function paths(index: CodeIndex, set: ReadonlySet<number>): string[] {
  return [...set].map((i) => index.at(i)?.path ?? '<dangling>').sort();
}

test('a targeted rescan of an edited file lands where a full walk lands', async () => {
  await withFixture(async (f) => {
    await f.write(
      'src/index.ts',
      ["import { createStore } from './store.js';", '', 'export function main(): void {', '  void createStore();', '}'].join('\n'),
    );
    f.watcher.report(['src/index.ts']);
    await f.index.ensureFresh();

    assert.equal(snapshot(f.index), snapshot(await f.reference()));
  });
});

test('an edit that drops an import detaches the far side of the edge', async () => {
  await withFixture(async (f) => {
    const retry = f.index.get('src/retry.ts');
    assert.ok(retry);
    assert.deepEqual(paths(f.index, retry.dependents), ['src/index.ts']);

    await f.write('src/index.ts', ["import { createStore } from './store.js';", 'export const main = () => createStore();'].join('\n'));
    f.watcher.report(['src/index.ts']);
    await f.index.ensureFresh();

    // The stale dependent lives on the *other* record, which was never rescanned.
    // Nothing else in the run would notice if it were left behind.
    assert.deepEqual(paths(f.index, f.index.get('src/retry.ts')!.dependents), []);
    assert.deepEqual(paths(f.index, f.index.get('src/index.ts')!.dependencies), ['src/store.ts']);
  });
});

test('a new file can complete an import that another file already had', async () => {
  await withFixture(async (f) => {
    const before = f.index.get('src/index.ts');
    assert.ok(before);
    assert.ok(before.externals.includes('./cache.js'), 'expected the unresolvable import to be external at first');

    await f.write('src/cache.ts', 'export function warm(): void {}\n');
    // Only the new file is reported. The edge that has to change belongs to a
    // file the watcher said nothing about.
    f.watcher.report(['src/cache.ts']);
    await f.index.ensureFresh();

    const after = f.index.get('src/index.ts');
    assert.ok(after);
    assert.deepEqual(paths(f.index, after.dependencies).sort(), ['src/cache.ts', 'src/retry.ts', 'src/store.ts']);
    assert.equal(after.externals.includes('./cache.js'), false, './cache.js resolves now and must not still be listed as external');
    assert.equal(snapshot(f.index), snapshot(await f.reference()));
  });
});

test('a deleted file is dropped and the imports pointing at it become external', async () => {
  await withFixture(async (f) => {
    await f.remove('src/retry.ts');
    f.watcher.report(['src/retry.ts']);
    await f.index.ensureFresh();

    assert.equal(f.index.get('src/retry.ts'), undefined);
    const main = f.index.get('src/index.ts');
    assert.ok(main);
    assert.deepEqual(paths(f.index, main.dependencies), ['src/store.ts']);
    assert.ok(main.externals.includes('./retry.js'));
    assert.equal(snapshot(f.index), snapshot(await f.reference()));
  });
});

test('a .gitignore change forces a walk, because targeted stats inherit its rules', async () => {
  await withFixture(async (f) => {
    assert.equal(f.index.get('generated/out.ts'), undefined, 'the fixture should start with generated/ ignored');

    await f.write('.gitignore', '# nothing ignored now\n');
    // A targeted scan would stat .gitignore, see one changed file, and never
    // discover that a whole directory just became visible.
    f.watcher.report(['.gitignore']);
    await f.index.ensureFresh();

    assert.ok(f.index.get('generated/out.ts'), 'a newly unignored file was not picked up');
  });
});

test('a manifest change forces a walk, so package boundaries stay right', async () => {
  await withFixture(async (f) => {
    await f.write('packages/app/package.json', JSON.stringify({ name: '@fixture/app' }));
    await f.write('packages/app/main.ts', "import { helper } from '../lib/helper.js';\nexport const run = () => helper();\n");
    await f.write('packages/lib/package.json', JSON.stringify({ name: '@fixture/lib' }));
    await f.write('packages/lib/helper.ts', 'export function helper(): void {}\n');

    // Only the manifests are reported — the source files are not. A targeted
    // scan would index nothing and leave the workspace looking like a single
    // package, which silently disables cross-package reporting everywhere.
    f.watcher.report(['packages/app/package.json', 'packages/lib/package.json']);
    await f.index.ensureFresh();

    assert.ok(f.index.get('packages/app/main.ts'), 'sibling sources were not walked');
    assert.equal(f.index.packages.isMonorepo, true);
    assert.equal(f.index.packages.owner('packages/app/main.ts')?.name, '@fixture/app');
    assert.equal(f.index.packages.crossesBoundary('packages/app/main.ts', 'packages/lib/helper.ts'), true);
  });
});

test('a watcher that lost track falls back to a full walk', async () => {
  await withFixture(async (f) => {
    await f.write('src/late.ts', 'export const LATE = 1;\n');
    f.watcher.report(null);
    await f.index.ensureFresh();

    assert.ok(f.index.get('src/late.ts'));
  });
});

test('a directory in the hint falls back to a full walk', async () => {
  await withFixture(async (f) => {
    await f.write('src/nested/deep.ts', 'export const DEEP = 1;\n');
    // Some platforms report the containing directory rather than the file.
    // Statting a directory says nothing about what is inside it.
    f.watcher.report(['src/nested']);
    await f.index.ensureFresh();

    assert.ok(f.index.get('src/nested/deep.ts'));
  });
});

test('an empty report is not a reason to walk anything', async () => {
  await withFixture(async (f) => {
    const before = snapshot(f.index);
    // Every event was noise — a write under dist/, say. Walking here is exactly
    // the cost this whole path exists to avoid.
    f.watcher.report([]);
    await f.index.ensureFresh();

    assert.equal(snapshot(f.index), before);
  });
});

test('an ignored file appearing in a report is not indexed', async () => {
  await withFixture(async (f) => {
    await f.write('generated/extra.ts', 'export const EXTRA = 1;\n');
    f.watcher.report(['generated/extra.ts']);
    await f.index.ensureFresh();

    assert.equal(f.index.get('generated/extra.ts'), undefined);
  });
});

test('a rescan does not rewrite the whole cache, and shutdown does not lose it', async () => {
  await withFixture(async (f) => {
    const cachePath = ParseCache.forWorkspace(f.root).path;
    const written = async (): Promise<string> => readFile(cachePath, 'utf8');
    assert.ok((await written()).length > 0, 'the first scan should have written the cache straight away');

    await f.write('src/store.ts', 'export function beaconSymbol(): void {}\n');
    f.watcher.report(['src/store.ts']);
    await f.index.ensureFresh();

    // Serialising a few megabytes of JSON per keystroke costs more than the
    // rescan it is recording.
    assert.equal((await written()).includes('beaconSymbol'), false, 'a one-file rescan rewrote the entire cache');

    await f.index.close();
    assert.ok((await written()).includes('beaconSymbol'), 'shutdown dropped the pending cache write');
  });
});

test('repeated targeted rescans do not accumulate stale state', async () => {
  await withFixture(async (f) => {
    for (let i = 0; i < 5; i++) {
      await f.write('src/store.ts', [`// revision ${i}`, 'export class Store {', `  load(): number { return ${i}; }`, '}', 'export function createStore(): Store {', '  return new Store();', '}'].join('\n'));
      f.watcher.report(['src/store.ts']);
      await f.index.ensureFresh();
    }

    // Five rescans of the same file must leave one dependent, not five.
    assert.deepEqual(paths(f.index, f.index.get('src/store.ts')!.dependents), ['src/index.ts']);
    assert.equal(snapshot(f.index), snapshot(await f.reference()));
  });
});
