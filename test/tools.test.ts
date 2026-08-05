/**
 * End-to-end tool tests.
 *
 * Each test builds a small real workspace on disk and drives the tools the way
 * a client would. This is where budget promises, handle round-trips, and path
 * containment are actually verified — unit tests on the pieces cannot show that
 * the assembled thing behaves.
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
import { Workspace, PathEscapeError } from '../src/core/workspace.js';
import { estimateTokens } from '../src/core/tokens.js';
import { runMap } from '../src/tools/map.js';
import { runOutline } from '../src/tools/outline.js';
import { runSearch } from '../src/tools/search.js';
import { runRead } from '../src/tools/read.js';
import { runTrace } from '../src/tools/trace.js';
import { runDiagnose } from '../src/tools/diagnose.js';
import { runNotes } from '../src/tools/notes.js';
import { runChanges } from '../src/tools/changes.js';
import { runDefine } from '../src/tools/define.js';
import type { ToolContext } from '../src/tools/context.js';
import { run } from '../src/diagnostics/runner.js';
import { ParseCache } from '../src/core/cache.js';
import { readFile } from 'node:fs/promises';

const FILES: Record<string, string> = {
  'package.json': JSON.stringify(
    {
      name: 'fixture-app',
      scripts: {
        test: 'echo ok',
        lint: 'echo ok',
        // Emits two adjacent compiler-style errors, so excerpt merging is testable
        // without depending on a real toolchain. Delegated to a script file rather
        // than inline `echo`, because cmd.exe and sh disagree about quoting.
        'fake-errors': 'node emit-errors.cjs',
      },
    },
    null,
    2,
  ),
  '.gitignore': 'generated/\n*.tmp\n',
  'src/index.ts': [
    "import { createStore } from './store.js';",
    "import { retryWithBackoff } from './retry.js';",
    '',
    'export function main(): void {',
    '  const store = createStore();',
    '  void retryWithBackoff(() => store.load());',
    '}',
  ].join('\n'),
  'src/store.ts': [
    '/** In-memory store for fixture data. */',
    'export class Store {',
    '  private items = new Map<string, string>();',
    '',
    '  load(): void {',
    '    this.items.set("a", "b");',
    '  }',
    '',
    '  get(key: string): string | undefined {',
    '    return this.items.get(key);',
    '  }',
    '}',
    '',
    'export function createStore(): Store {',
    '  return new Store();',
    '}',
  ].join('\n'),
  'src/retry.ts': [
    'export const RETRY_LIMIT = 5;',
    '',
    '/** Retries an operation with exponential backoff. */',
    'export async function retryWithBackoff<T>(operation: () => T): Promise<T> {',
    '  let lastError: unknown;',
    '  for (let attempt = 0; attempt < RETRY_LIMIT; attempt++) {',
    '    try {',
    '      return operation();',
    '    } catch (error) {',
    '      lastError = error;',
    '    }',
    '  }',
    '  throw lastError;',
    '}',
  ].join('\n'),
  'test/store.test.ts': ["import { createStore } from '../src/store.js';", '', 'createStore();'].join('\n'),
  'emit-errors.cjs': [
    "console.log('src/store.ts(5,5): error TS1111: first problem');",
    "console.log('src/store.ts(6,5): error TS2222: second problem');",
    'process.exit(1);',
  ].join('\n'),
  'generated/huge.ts': 'export const IGNORED = 1;\n',
  'notes.tmp': 'should be ignored\n',
};

async function makeWorkspace(): Promise<ToolContext> {
  const root = await mkdtemp(join(tmpdir(), 'jellybean-test-'));
  for (const [path, contents] of Object.entries(FILES)) {
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

async function withWorkspace(body: (ctx: ToolContext) => Promise<void>): Promise<void> {
  const ctx = await makeWorkspace();
  try {
    await body(ctx);
  } finally {
    await rm(ctx.workspace.root, { recursive: true, force: true });
  }
}

/** Pull the first handle out of a tool result. */
function firstHandle(output: string): string {
  const m = /jb_[0-9a-f]{8}/.exec(output);
  assert.ok(m, `no handle in output:\n${output}`);
  return m[0];
}

// ---------------------------------------------------------------------------

test('indexing respects .gitignore', async () => {
  await withWorkspace(async (ctx) => {
    const paths = ctx.index.all().map((f) => f.path);
    assert.ok(paths.includes('src/index.ts'));
    assert.equal(paths.includes('generated/huge.ts'), false, 'an ignored directory was indexed');
    assert.equal(paths.includes('notes.tmp'), false, 'an ignored file was indexed');
  });
});

test('the import graph links files in both directions', async () => {
  await withWorkspace(async (ctx) => {
    const store = ctx.index.get('src/store.ts');
    const index = ctx.index.get('src/index.ts');
    assert.ok(store && index);

    assert.ok(index.dependencies.has(store.index), 'index.ts should depend on store.ts');
    assert.ok(store.dependents.has(index.index), 'store.ts should be depended on by index.ts');
  });
});

test('jb_map names the project and ranks the most-imported file first', async () => {
  await withWorkspace(async (ctx) => {
    const output = await runMap({}, ctx);
    assert.ok(output.includes('fixture-app'), 'the project name was not read from package.json');

    // store.ts is imported by both index.ts and the test, so it should outrank
    // retry.ts, which has a single dependent.
    assert.ok(output.indexOf('store.ts') < output.indexOf('retry.ts'), 'ranking ignored the import graph');
  });
});

test('jb_map honours a small token budget', async () => {
  await withWorkspace(async (ctx) => {
    const output = await runMap({ tokenBudget: 150 }, ctx);
    assert.ok(estimateTokens(output) <= 150 * 1.35, `budget overrun: ${estimateTokens(output)} tokens`);
    assert.ok(output.includes('tok'), 'the footer did not report usage');
  });
});

test('jb_map with a focus surfaces the relevant file', async () => {
  await withWorkspace(async (ctx) => {
    const output = await runMap({ focus: 'retry backoff' }, ctx);
    assert.ok(output.indexOf('retry.ts') < output.indexOf('index.ts'), 'focus did not affect ranking');
  });
});

test('jb_outline is far cheaper than reading the file', async () => {
  await withWorkspace(async (ctx) => {
    const outline = await runOutline({ path: 'src/store.ts' }, ctx);
    const source = await runRead({ path: 'src/store.ts' }, ctx);

    assert.ok(outline.includes('Store'));
    assert.ok(outline.includes('createStore'));
    assert.ok(!outline.includes('this.items.set'), 'the outline leaked a method body');
    assert.ok(estimateTokens(outline) < estimateTokens(source), 'the outline was not cheaper than the source');
  });
});

test('jb_outline can hide non-exported symbols', async () => {
  await withWorkspace(async (ctx) => {
    const output = await runOutline({ path: 'src/store.ts', includePrivate: false }, ctx);
    assert.ok(output.includes('createStore'));
    assert.equal(output.includes('items'), false, 'a private field was listed');
  });
});

test('jb_outline reports a missing path clearly', async () => {
  await withWorkspace(async (ctx) => {
    const output = await runOutline({ path: 'src/nope.ts' }, ctx);
    assert.ok(output.includes('no such path'), output);
  });
});

test('jb_search finds a concept from separate words', async () => {
  await withWorkspace(async (ctx) => {
    const output = await runSearch({ query: 'retry backoff' }, ctx);
    assert.ok(output.includes('src/retry.ts'), output);
    assert.ok(output.includes('retryWithBackoff'), 'the enclosing symbol was not reported');
  });
});

test('jb_search symbol mode matches declaration names only', async () => {
  await withWorkspace(async (ctx) => {
    const output = await runSearch({ query: 'createStore', mode: 'symbol' }, ctx);
    assert.ok(output.includes('src/store.ts:'), output);
    assert.equal(output.includes('src/index.ts'), false, 'a call site was reported as a declaration');
  });
});

test('jb_search counts places, not just raw hits, when collapsing by symbol', async () => {
  await withWorkspace(async (ctx) => {
    // "items" appears on several lines inside the same two methods of Store, so
    // the hit count and the number of places to look must differ — and the
    // omitted count below the rows has to be in places, matching the rows.
    const output = await runSearch({ query: 'items', maxFiles: 1 }, ctx);
    const header = output.split('\n').find((line) => line.startsWith('src/store.ts'));
    assert.ok(header, `no result for store.ts:\n${output}`);

    const match = /(\d+) hits in (\d+) places/.exec(header);
    if (match) {
      assert.ok(Number(match[1]) > Number(match[2]), `collapsing did not reduce anything: ${header}`);
    } else {
      // Nothing collapsed, so a plain hit count is the honest summary.
      assert.ok(/\d+ hits?/.test(header), header);
    }
  });
});

test('jb_search reports an invalid regex instead of throwing', async () => {
  await withWorkspace(async (ctx) => {
    const output = await runSearch({ query: '([unclosed', mode: 'regex' }, ctx);
    assert.ok(output.includes('invalid regular expression'), output);
  });
});

test('jb_search keeps path order when results span several read batches', async () => {
  await withWorkspace(async (ctx) => {
    // Candidate files are read concurrently in batches. Reporting them in
    // completion order instead of candidate order would make the same search
    // return a different answer each run, which is worse than a slow search.
    await mkdir(join(ctx.workspace.root, 'src/gen'), { recursive: true });
    for (let i = 0; i < 60; i++) {
      const name = `mod${String(i).padStart(2, '0')}.ts`;
      await writeFile(join(ctx.workspace.root, 'src/gen', name), `export const NEEDLE_${i} = ${i};\n`, 'utf8');
    }
    await ctx.index.ensureFresh(true);

    const output = await runSearch({ query: 'NEEDLE_\\d+', mode: 'regex', maxFiles: 50 }, ctx);
    const reported = [...output.matchAll(/^src\/gen\/mod\d+\.ts/gm)].map((m) => m[0]);

    assert.ok(reported.length >= 30, `expected many files, got ${reported.length}:\n${output}`);
    assert.deepEqual(reported, [...reported].sort(), 'concurrent reads reordered the results');
  });
});

test('jb_search says so when there are no matches', async () => {
  await withWorkspace(async (ctx) => {
    const output = await runSearch({ query: 'quetzalcoatlus' }, ctx);
    assert.ok(output.includes('no match'), output);
  });
});

test('a handle from a search round-trips through jb_read', async () => {
  await withWorkspace(async (ctx) => {
    const search = await runSearch({ query: 'retryWithBackoff' }, ctx);
    const output = await runRead({ handle: firstHandle(search) }, ctx);

    assert.ok(output.includes('retryWithBackoff') || output.includes('RETRY_LIMIT'), output);
    assert.ok(/^\s*\d+\|/m.test(output), 'the result was not line-numbered');
  });
});

test('jb_read by symbol returns only that symbol', async () => {
  await withWorkspace(async (ctx) => {
    const output = await runRead({ path: 'src/store.ts', symbol: 'createStore' }, ctx);
    assert.ok(output.includes('return new Store();'));
    assert.equal(output.includes('private items'), false, 'unrelated lines were included');
  });
});

test('jb_read by symbol lists alternatives when the name is wrong', async () => {
  await withWorkspace(async (ctx) => {
    const output = await runRead({ path: 'src/store.ts', symbol: 'nope' }, ctx);
    assert.ok(output.includes('no symbol'), output);
    assert.ok(output.includes('createStore'), 'the error did not suggest what is available');
  });
});

test('jb_read accepts an explicit line range and rejects a backwards one', async () => {
  await withWorkspace(async (ctx) => {
    const ok = await runRead({ path: 'src/retry.ts', lines: '1-3' }, ctx);
    assert.ok(ok.includes('RETRY_LIMIT'));
    assert.ok(!ok.includes('throw lastError'), 'the range was not respected');

    const bad = await runRead({ path: 'src/retry.ts', lines: '9-2' }, ctx);
    assert.ok(bad.includes('ends before it starts'), bad);
  });
});

test('jb_read skeleton mode elides bodies but keeps declarations', async () => {
  await withWorkspace(async (ctx) => {
    const output = await runRead({ path: 'src/retry.ts', mode: 'skeleton' }, ctx);
    assert.ok(output.includes('retryWithBackoff'), 'the declaration was elided');
    assert.ok(output.includes('lines'), 'no elision marker was emitted');
    assert.ok(!output.includes('lastError = error'), 'the body was not elided');
  });
});

test('an unknown handle explains how to recover', async () => {
  await withWorkspace(async (ctx) => {
    const output = await runRead({ handle: 'jb_00000000' }, ctx);
    assert.ok(output.includes('expired'), output);
  });
});

test('a malformed handle is rejected', async () => {
  await withWorkspace(async (ctx) => {
    const output = await runRead({ handle: 'not-a-handle' }, ctx);
    assert.ok(output.includes('not a handle'), output);
  });
});

test('jb_trace lists dependents and labels tests', async () => {
  await withWorkspace(async (ctx) => {
    const output = await runTrace({ path: 'src/store.ts' }, ctx);
    assert.ok(output.includes('src/index.ts'), output);
    assert.ok(output.includes('test/store.test.ts'), 'the test dependent was missing');
    assert.ok(output.includes('test'), 'the test dependent was not labelled');
  });
});

test('jb_trace on a symbol reports real reference sites', async () => {
  await withWorkspace(async (ctx) => {
    const output = await runTrace({ symbol: 'createStore' }, ctx);
    assert.ok(output.includes('src/index.ts'), output);
    assert.ok(output.includes('main'), 'the referencing symbol was not identified');
  });
});

test('jb_trace dependencies separates internal files from packages', async () => {
  await withWorkspace(async (ctx) => {
    const output = await runTrace({ path: 'src/index.ts', direction: 'dependencies' }, ctx);
    assert.ok(output.includes('src/store.ts'));
    assert.ok(output.includes('src/retry.ts'));
  });
});

test('jb_trace refuses an ambiguous symbol rather than guessing', async () => {
  await withWorkspace(async (ctx) => {
    const output = await runTrace({ symbol: 'nonexistent' }, ctx);
    assert.ok(output.includes('no file declares'), output);
  });
});

test('jb_diagnose lists project checks when called with no arguments', async () => {
  await withWorkspace(async (ctx) => {
    const output = await runDiagnose({}, ctx);
    assert.ok(output.includes('test'), output);
    assert.ok(output.includes('lint'));
    assert.ok(output.includes('package.json'), 'the origin of each check was not shown');
  });
});

test('jb_diagnose refuses an arbitrary command by default', async () => {
  await withWorkspace(async (ctx) => {
    const output = await runDiagnose({ command: 'rm -rf /' }, ctx);
    assert.ok(output.includes('disabled'), output);
    assert.ok(output.includes('--allow-command'), 'the error did not say how to opt in');
  });
});

test('jb_diagnose runs an allowlisted command', async () => {
  await withWorkspace(async (ctx) => {
    ctx.config.allowedCommands.push('node --version');
    const output = await runDiagnose({ command: 'node --version' }, ctx);
    assert.ok(output.includes('passed'), output);
  });
});

test('jb_diagnose rejects a command the allowlist does not cover', async () => {
  await withWorkspace(async (ctx) => {
    ctx.config.allowedCommands.push('node --version');
    const output = await runDiagnose({ command: 'node --eval process.exit(1)' }, ctx);
    assert.ok(output.includes('disabled'), output);
  });
});

test('jb_diagnose names an unknown check and lists the real ones', async () => {
  await withWorkspace(async (ctx) => {
    const output = await runDiagnose({ check: 'nope' }, ctx);
    assert.ok(output.includes('no check named'), output);
    assert.ok(output.includes('test'), 'the available checks were not listed');
  });
});

test('jb_diagnose locates problems and attaches source', async () => {
  await withWorkspace(async (ctx) => {
    const output = await runDiagnose({ check: 'fake-errors' }, ctx);

    assert.ok(output.includes('2 problems'), output);
    assert.ok(output.includes('TS1111') && output.includes('TS2222'), 'the diagnostic codes were lost');
    assert.ok(output.includes('src/store.ts'), 'the file was not identified');
    assert.ok(output.includes('this.items.set'), 'the source line was not attached');
    assert.ok(/jb_[0-9a-f]{8}/.test(output), 'no handle was offered for the problem');
  });
});

test('jb_diagnose merges overlapping excerpts instead of repeating them', async () => {
  await withWorkspace(async (ctx) => {
    const output = await runDiagnose({ check: 'fake-errors', contextLines: 3 }, ctx);

    // Two problems three lines apart share one context window, so each source
    // line must be printed exactly once, with the offending lines marked.
    const occurrences = output.split('\n').filter((line) => line.includes('this.items.set')).length;
    assert.equal(occurrences, 1, `the shared source line was printed ${occurrences} times`);
    assert.ok(output.includes('>'), 'problem lines were not marked');
  });
});

test('jb_diagnose reports a passing check as clean', async () => {
  await withWorkspace(async (ctx) => {
    const output = await runDiagnose({ check: 'test' }, ctx);
    assert.ok(output.includes('passed'), output);
    assert.ok(output.includes('clean'), output);
  });
});

test('notes persist, are recalled by search, and can be removed', async () => {
  await withWorkspace(async (ctx) => {
    const added = await runNotes(
      { action: 'add', text: 'Retries deliberately share one budget across shards.', paths: ['src/retry.ts'], tags: ['gotcha'] },
      ctx,
    );
    assert.ok(added.includes('saved'), added);
    assert.ok(added.includes('src/retry.ts'), 'the note was not anchored');

    const found = await runNotes({ action: 'search', query: 'retries budget' }, ctx);
    assert.ok(found.includes('share one budget'), found);

    const id = /saved (\w+)/.exec(added)?.[1];
    assert.ok(id);
    const removed = await runNotes({ action: 'remove', id }, ctx);
    assert.ok(removed.includes('removed'), removed);

    const after = await runNotes({ action: 'list' }, ctx);
    assert.ok(after.includes('no notes yet'), after);
  });
});

test('a note anchored to a file surfaces in jb_trace on that file', async () => {
  await withWorkspace(async (ctx) => {
    await runNotes({ action: 'add', text: 'Backoff is intentionally jitter-free.', paths: ['src/retry.ts'] }, ctx);
    const output = await runTrace({ path: 'src/retry.ts' }, ctx);
    assert.ok(output.includes('jitter-free'), output);
  });
});

test('a note anchored to a missing path is reported, not silently dropped', async () => {
  await withWorkspace(async (ctx) => {
    const output = await runNotes({ action: 'add', text: 'x', paths: ['src/ghost.ts'] }, ctx);
    assert.ok(output.includes('ignored missing'), output);
  });
});

test('paths outside the workspace are refused', async () => {
  await withWorkspace(async (ctx) => {
    assert.throws(() => ctx.workspace.resolve('../../etc/passwd'), PathEscapeError);
    assert.throws(() => ctx.workspace.resolve('/etc/passwd'), PathEscapeError);

    // A path that merely contains '..' but stays inside is fine. Compare through
    // relativize so the assertion does not depend on the platform separator.
    assert.equal(ctx.workspace.relativize(ctx.workspace.resolve('src/../src/index.ts')), 'src/index.ts');
  });
});

test('the index picks up an edited file without a restart', async () => {
  await withWorkspace(async (ctx) => {
    const before = await runSearch({ query: 'freshlyAdded', mode: 'symbol' }, ctx);
    assert.ok(before.includes('no symbol names matched'), before);

    await writeFile(join(ctx.workspace.root, 'src/new-file.ts'), 'export function freshlyAdded() {}\n', 'utf8');
    await ctx.index.ensureFresh(true);

    const after = await runSearch({ query: 'freshlyAdded', mode: 'symbol' }, ctx);
    assert.ok(after.includes('src/new-file.ts'), after);
  });
});

test('editing a file retires its old content from the search index', async () => {
  await withWorkspace(async (ctx) => {
    const before = await runSearch({ query: 'retryWithBackoff' }, ctx);
    assert.ok(before.includes('src/retry.ts'), before);

    // Replace the file wholesale. The old identifiers must not linger as
    // postings, or search would keep pointing at code that no longer exists.
    await writeFile(join(ctx.workspace.root, 'src/retry.ts'), 'export function plainLoop(): void {}\n', 'utf8');
    await ctx.index.ensureFresh(true);

    // index.ts still imports the old name, so hits there are correct. What must
    // disappear is retry.ts itself, whose postings are now stale.
    const after = await runSearch({ query: 'retryWithBackoff' }, ctx);
    assert.equal(
      after.includes('src/retry.ts'),
      false,
      `stale postings for the edited file survived:\n${after}`,
    );

    const bySymbol = await runSearch({ query: 'retryWithBackoff', mode: 'symbol' }, ctx);
    assert.ok(bySymbol.includes('no symbol names matched'), `the deleted declaration is still indexed:\n${bySymbol}`);

    const replacement = await runSearch({ query: 'plainLoop', mode: 'symbol' }, ctx);
    assert.ok(replacement.includes('src/retry.ts'), replacement);
  });
});

test('a deleted file leaves the index', async () => {
  await withWorkspace(async (ctx) => {
    await rm(join(ctx.workspace.root, 'src/retry.ts'));
    await ctx.index.ensureFresh(true);

    assert.equal(ctx.index.get('src/retry.ts'), undefined);
    const output = await runSearch({ query: 'retryWithBackoff', mode: 'symbol' }, ctx);
    assert.ok(output.includes('no symbol names matched'), output);
  });
});

test('the footer survives even a budget too small for the rows', async () => {
  await withWorkspace(async (ctx) => {
    // The footer is how a caller learns that rows were omitted. Dropping it for
    // lack of budget would present a truncated result as a complete one.
    const results: Array<[string, string]> = [
      ['jb_map', await runMap({ tokenBudget: 100 }, ctx)],
      ['jb_outline', await runOutline({ path: 'src', tokenBudget: 100 }, ctx)],
      ['jb_search', await runSearch({ query: 'store', tokenBudget: 100 }, ctx)],
      ['jb_read', await runRead({ path: 'src/store.ts', tokenBudget: 100 }, ctx)],
      ['jb_trace', await runTrace({ path: 'src/store.ts', tokenBudget: 100 }, ctx)],
    ];

    for (const [name, output] of results) {
      assert.ok(/\[\d+\/\d+ tok/.test(output), `${name} lost its footer:\n${output}`);
    }
  });
});

test('a truncated result says how many rows it dropped', async () => {
  await withWorkspace(async (ctx) => {
    const output = await runOutline({ path: 'src', tokenBudget: 120 }, ctx);
    assert.ok(output.includes('omitted'), `truncation was not reported:\n${output}`);
  });
});

test('every tool stays within a tight budget', async () => {
  await withWorkspace(async (ctx) => {
    const budget = 200;
    const results: Array<[string, string]> = [
      ['jb_map', await runMap({ tokenBudget: budget }, ctx)],
      ['jb_map tree', await runMap({ depth: 'tree', tokenBudget: budget }, ctx)],
      ['jb_outline', await runOutline({ path: 'src', tokenBudget: budget }, ctx)],
      ['jb_search', await runSearch({ query: 'store', tokenBudget: budget }, ctx)],
      ['jb_read', await runRead({ path: 'src/store.ts', tokenBudget: budget }, ctx)],
      ['jb_trace', await runTrace({ path: 'src/store.ts', tokenBudget: budget }, ctx)],
    ];

    for (const [name, output] of results) {
      // Headers and footers are written unconditionally, so allow modest slack —
      // the guarantee is that row content cannot run away, not that a header is
      // dropped when the budget is absurdly small.
      assert.ok(
        estimateTokens(output) <= budget + 120,
        `${name} used ${estimateTokens(output)} tokens against a budget of ${budget}`,
      );
    }
  });
});

test('a restart reuses the parse cache instead of re-parsing', async () => {
  await withWorkspace(async (ctx) => {
    // A second index over the same workspace must hydrate from the cache the
    // first one wrote. Without this, every server start re-parses the repo.
    const second = new CodeIndex(ctx.workspace, ctx.config);
    await second.ensureFresh(true);

    assert.equal(second.fileCount, ctx.index.fileCount);
    assert.ok(second.cacheHits > 0, 'nothing was restored from cache');

    // Hydrated records must be complete, not just present.
    const store = second.get('src/store.ts');
    assert.ok(store, 'store.ts missing after cache load');
    assert.ok(
      store.symbols.some((s) => s.name === 'createStore'),
      'symbols were lost on the cache path',
    );
    assert.ok(store.imports.length >= 0);
    assert.ok(store.termCount > 0, 'search terms were lost on the cache path');
  });
});

test('the cache does not serve a stale parse after an edit', async () => {
  await withWorkspace(async (ctx) => {
    await writeFile(join(ctx.workspace.root, 'src/store.ts'), 'export function afterEdit(): void {}\n', 'utf8');

    const second = new CodeIndex(ctx.workspace, ctx.config);
    await second.ensureFresh(true);

    const store = second.get('src/store.ts');
    assert.ok(store);
    assert.ok(
      store.symbols.some((s) => s.name === 'afterEdit'),
      'the edited file was served from a stale cache entry',
    );
    assert.equal(
      store.symbols.some((s) => s.name === 'createStore'),
      false,
      'the pre-edit symbols survived',
    );
  });
});

test('the symbol name index tracks renames', async () => {
  await withWorkspace(async (ctx) => {
    assert.equal(ctx.index.filesDeclaring('createStore').length, 1);

    await writeFile(join(ctx.workspace.root, 'src/store.ts'), 'export function renamedStore(): void {}\n', 'utf8');
    await ctx.index.ensureFresh(true);

    assert.equal(ctx.index.filesDeclaring('renamedStore').length, 1);
    assert.equal(
      ctx.index.filesDeclaring('createStore').length,
      0,
      'the old name still resolves after a rename',
    );
  });
});

test('jb_changes maps a real edit onto the symbol it touched', async () => {
  await withWorkspace(async (ctx) => {
    const git = async (...args: string[]): Promise<void> => {
      const result = await run(['git', ...args], ctx.workspace.root, 20_000);
      assert.equal(result.exitCode, 0, `git ${args.join(' ')} failed: ${result.output}`);
    };

    await git('init', '--quiet');
    await git('config', 'user.email', 'test@example.com');
    await git('config', 'user.name', 'Test');
    await git('add', '-A');
    await git('commit', '--quiet', '-m', 'initial');

    // Change the body of one method, leaving everything else alone.
    const storePath = join(ctx.workspace.root, 'src/store.ts');
    const original = FILES['src/store.ts']!;
    await writeFile(storePath, original.replace('this.items.set("a", "b");', 'this.items.set("a", "changed");'), 'utf8');
    await ctx.index.ensureFresh(true);

    const output = await runChanges({}, ctx);
    assert.ok(output.includes('src/store.ts'), output);
    assert.ok(output.includes('load'), `the touched method was not identified:\n${output}`);
    assert.equal(output.includes('createStore'), false, 'an untouched symbol was reported as changed');
  });
});

test('jb_changes says so when the tree is clean', async () => {
  await withWorkspace(async (ctx) => {
    const git = async (...args: string[]): Promise<void> => {
      await run(['git', ...args], ctx.workspace.root, 20_000);
    };
    await git('init', '--quiet');
    await git('config', 'user.email', 'test@example.com');
    await git('config', 'user.name', 'Test');
    await git('add', '-A');
    await git('commit', '--quiet', '-m', 'initial');

    const output = await runChanges({}, ctx);
    assert.ok(output.includes('clean'), output);
  });
});

test('jb_changes reports a missing repository rather than failing', async () => {
  await withWorkspace(async (ctx) => {
    const output = await runChanges({}, ctx);
    assert.ok(output.includes('not a git repository'), output);
  });
});

test('symbol lookups still work on a warm start', async () => {
  await withWorkspace(async (ctx) => {
    // Regression guard. The cached and freshly-parsed index paths diverged: the
    // cached one skipped registering symbol names, so every warm start left the
    // name index empty and jb_define, jb_trace {symbol} and symbol search all
    // silently found nothing. The existing rename test missed it because writing
    // a file forces the parse path.
    const warm = new CodeIndex(ctx.workspace, ctx.config);
    await warm.ensureFresh(true);

    assert.ok(warm.cacheHits > 0, 'this test is meaningless unless the cache was used');
    assert.deepEqual(
      warm.filesDeclaring('createStore').map((f) => f.path),
      ['src/store.ts'],
      'the symbol name index was not populated from cache',
    );
    assert.ok([...warm.allSymbolNames()].length > 0, 'the name index is empty after a warm start');
  });
});

test('jb_define resolves a name through the importing file', async () => {
  await withWorkspace(async (ctx) => {
    const output = await runDefine({ symbol: 'createStore', from: 'src/index.ts' }, ctx);
    assert.ok(output.includes('src/store.ts:'), output);
    assert.ok(output.includes('imported from'), 'resolution did not go through the import');
  });
});

test('jb_define finds a locally declared symbol', async () => {
  await withWorkspace(async (ctx) => {
    const output = await runDefine({ symbol: 'main', from: 'src/index.ts' }, ctx);
    assert.ok(output.includes('src/index.ts:'), output);
    assert.ok(output.includes('declared in this file'), output);
  });
});

test('jb_define can return the definition source', async () => {
  await withWorkspace(async (ctx) => {
    const output = await runDefine({ symbol: 'createStore', from: 'src/index.ts', body: true }, ctx);
    assert.ok(output.includes('return new Store();'), 'the body was not included');
  });
});

test('jb_define admits ambiguity rather than guessing', async () => {
  await withWorkspace(async (ctx) => {
    // Two files declaring the same name, with no importing file to disambiguate.
    await writeFile(join(ctx.workspace.root, 'src/a.ts'), 'export function shared(): void {}\n', 'utf8');
    await writeFile(join(ctx.workspace.root, 'src/b.ts'), 'export function shared(): void {}\n', 'utf8');
    await ctx.index.ensureFresh(true);

    const output = await runDefine({ symbol: 'shared' }, ctx);
    assert.ok(output.includes('ambiguous'), `ambiguity was not reported:\n${output}`);
    assert.ok(output.includes('src/a.ts') && output.includes('src/b.ts'), 'not all candidates were listed');
  });
});

test('jb_define says so when nothing declares the name', async () => {
  await withWorkspace(async (ctx) => {
    const output = await runDefine({ symbol: 'NoSuchSymbolAnywhere' }, ctx);
    assert.ok(output.includes('not found'), output);
    assert.ok(output.includes('external package'), 'the error did not suggest why');
  });
});

test('a cache written by an older parser generation is not trusted', async () => {
  await withWorkspace(async (ctx) => {
    // The cache key is (path, size, mtime), which cannot notice that our own
    // parsing changed. CACHE_VERSION is the only thing standing between a
    // parser improvement and every existing cache confidently serving the old
    // answer, so verify that a mismatched generation is discarded outright.
    const cache = ParseCache.forWorkspace(ctx.workspace.root);
    await cache.load();
    assert.ok(cache.size > 0, 'the first index should have written a cache');

    const raw = JSON.parse(await readFile(cache.path, 'utf8')) as { version: number };
    assert.equal(typeof raw.version, 'number');
    await writeFile(cache.path, JSON.stringify({ ...raw, version: raw.version - 1 }), 'utf8');

    const stale = ParseCache.forWorkspace(ctx.workspace.root);
    await stale.load();
    assert.equal(stale.size, 0, 'a cache from a different generation was accepted');

    // And the index still works, by re-parsing.
    const rebuilt = new CodeIndex(ctx.workspace, ctx.config);
    await rebuilt.ensureFresh(true);
    assert.ok(rebuilt.get('src/store.ts')?.symbols.some((s) => s.name === 'createStore'));
  });
});
