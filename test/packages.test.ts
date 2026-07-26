/**
 * Monorepo awareness.
 *
 * Built on a synthetic workspace rather than a real monorepo, because the
 * behaviour under test is boundary detection and a fixture can state the
 * boundaries unambiguously.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from '../src/config.js';
import { CodeIndex } from '../src/core/code-index.js';
import { HandleStore } from '../src/core/handles.js';
import { NotesStore } from '../src/core/notes.js';
import { Workspace } from '../src/core/workspace.js';
import { runMap } from '../src/tools/map.js';
import { runTrace } from '../src/tools/trace.js';
import type { ToolContext } from '../src/tools/context.js';

const MONOREPO: Record<string, string> = {
  'package.json': JSON.stringify({ name: 'root', private: true, workspaces: ['packages/*'] }),
  'packages/shared/package.json': JSON.stringify({ name: '@acme/shared' }),
  'packages/shared/src/config.ts': 'export const TIMEOUT_MS = 5000;\n',
  'packages/shared/src/local.ts': "import { TIMEOUT_MS } from './config.js';\n\nexport const doubled = TIMEOUT_MS * 2;\n",
  'packages/api/package.json': JSON.stringify({ name: '@acme/api' }),
  'packages/api/src/server.ts': "import { TIMEOUT_MS } from '../../shared/src/config.js';\n\nexport function serve(): number {\n  return TIMEOUT_MS;\n}\n",
};

const FLAT: Record<string, string> = {
  'package.json': JSON.stringify({ name: 'single' }),
  'src/a.ts': "import { b } from './b.js';\n\nexport const a = b;\n",
  'src/b.ts': 'export const b = 1;\n',
};

async function build(files: Record<string, string>): Promise<ToolContext> {
  const root = await mkdtemp(join(tmpdir(), 'jellybean-pkg-'));
  for (const [path, contents] of Object.entries(files)) {
    const absolute = join(root, path);
    await mkdir(join(absolute, '..'), { recursive: true });
    await writeFile(absolute, contents, 'utf8');
  }
  const { config } = parseArgs([root]);
  const workspace = new Workspace(config.root, config.ignore);
  const ctx: ToolContext = {
    config,
    workspace,
    index: new CodeIndex(workspace, config),
    handles: new HandleStore(),
    notes: NotesStore.forWorkspace(config.root, config.notesPath),
  };
  await ctx.index.ensureFresh(true);
  return ctx;
}

async function withWorkspace(files: Record<string, string>, body: (ctx: ToolContext) => Promise<void>): Promise<void> {
  const ctx = await build(files);
  try {
    await body(ctx);
  } finally {
    await rm(ctx.workspace.root, { recursive: true, force: true });
  }
}

test('packages are discovered from their manifests', async () => {
  await withWorkspace(MONOREPO, async (ctx) => {
    assert.ok(ctx.index.packages.isMonorepo, 'a packages/* layout was not recognised');
    const names = ctx.index.packages.all().map((p) => p.name);
    assert.ok(names.includes('@acme/shared'), names.join(', '));
    assert.ok(names.includes('@acme/api'), names.join(', '));
  });
});

test('a single-package repository is not treated as a monorepo', async () => {
  await withWorkspace(FLAT, async (ctx) => {
    // The concept adds nothing here, and labelling every edge "cross-package"
    // would be noise on top of being wrong.
    assert.equal(ctx.index.packages.isMonorepo, false);
    assert.equal(ctx.index.packages.owner('src/a.ts'), undefined);
    assert.equal(ctx.index.packages.crossesBoundary('src/a.ts', 'src/b.ts'), false);
  });
});

test('files are attributed to the package containing them', async () => {
  await withWorkspace(MONOREPO, async (ctx) => {
    assert.equal(ctx.index.packages.owner('packages/shared/src/config.ts')?.name, '@acme/shared');
    assert.equal(ctx.index.packages.owner('packages/api/src/server.ts')?.name, '@acme/api');
  });
});

test('a boundary is only crossed between different packages', async () => {
  await withWorkspace(MONOREPO, async (ctx) => {
    assert.equal(
      ctx.index.packages.crossesBoundary('packages/shared/src/config.ts', 'packages/api/src/server.ts'),
      true,
    );
    assert.equal(
      ctx.index.packages.crossesBoundary('packages/shared/src/config.ts', 'packages/shared/src/local.ts'),
      false,
      'two files in the same package must not count as crossing',
    );
  });
});

test('jb_map reports the package count', async () => {
  await withWorkspace(MONOREPO, async (ctx) => {
    const output = await runMap({ depth: 'tree' }, ctx);
    assert.ok(/\d+ packages/.test(output), output.split('\n')[0]);
  });
});

test('jb_trace flags a cross-package dependent and not a local one', async () => {
  await withWorkspace(MONOREPO, async (ctx) => {
    const output = await runTrace({ path: 'packages/shared/src/config.ts', tokenBudget: 800 }, ctx);

    const apiRow = output.split('\n').find((line) => line.includes('packages/api/src/server.ts'));
    assert.ok(apiRow, `the cross-package dependent was missing:\n${output}`);
    assert.ok(apiRow.includes('cross-package'), `not flagged as cross-package: ${apiRow}`);
    assert.ok(apiRow.includes('@acme/api'), `the owning package was not named: ${apiRow}`);

    const localRow = output.split('\n').find((line) => line.includes('packages/shared/src/local.ts'));
    if (localRow) {
      assert.equal(localRow.includes('cross-package'), false, `a same-package edge was flagged: ${localRow}`);
    }
  });
});
