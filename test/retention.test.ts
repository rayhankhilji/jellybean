/**
 * Memory-retention tests.
 *
 * V8 stores a substring as a pointer into its parent rather than a copy, so
 * every symbol name, signature and import specifier the index extracts keeps its
 * entire source file alive unless something deliberately breaks the link. On a
 * 16,000-file repository that was the difference between 316MB and 914MB.
 *
 * It is a silent regression: nothing fails, no test goes red, and the only
 * symptom is a memory figure on a repository large enough for anyone to notice.
 * So it is asserted directly.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from '../src/config.js';
import { CodeIndex } from '../src/core/code-index.js';
import { Workspace } from '../src/core/workspace.js';
import { detachString } from '../src/util/text.js';

test('detachString returns an equal string, whatever is in it', () => {
  const cases = [
    '',
    'a',
    'short',
    'exactly12chr',
    'a name long enough to be stored as a slice',
    'ident_with_émoji_🎉_and_astral_text',
    '日本語の識別子です_longer_than_the_threshold',
    // A lone surrogate is legal in a JS string and can reach us from source. A
    // copy that round-trips through UTF-8 would silently replace it.
    `${'a'.repeat(20)}\uD800${'b'.repeat(20)}`,
    '\t  whitespace and \\ backslashes and "quotes"  ',
  ];

  for (const value of cases) {
    assert.equal(detachString(value), value, `changed: ${JSON.stringify(value)}`);
  }
});

test('an extracted string does not keep its source alive', { skip: typeof global.gc !== 'function' }, () => {
  const collect = (): number => {
    global.gc!();
    global.gc!();
    return process.memoryUsage().heapUsed;
  };

  const SOURCES = 400;
  const SIZE = 50_000;

  const measure = (extract: (source: string) => string): number => {
    const kept: string[] = [];
    const before = collect();
    for (let i = 0; i < SOURCES; i++) {
      kept.push(extract(`const marker${i} = 1;`.padEnd(SIZE, 'x')));
    }
    const after = collect();
    assert.equal(kept.length, SOURCES); // keep them reachable across the measurement
    return after - before;
  };

  const sliced = measure((source) => source.slice(6, 40));
  const detached = measure((source) => detachString(source.slice(6, 40)));

  // Half the raw source volume is a generous margin; in practice the difference
  // is the whole of it against essentially nothing.
  const sourceBytes = SOURCES * SIZE * 2;
  assert.ok(sliced > sourceBytes / 2, `expected plain slices to retain their sources, saw ${sliced} bytes`);
  assert.ok(
    detached < sourceBytes / 10,
    `detachString retained ${detached} bytes, against ${sliced} for plain slices`,
  );
});

test('the index does not retain the text it was built from', { skip: typeof global.gc !== 'function' }, async () => {
  // Files large enough that retaining them is unmistakable, with real
  // declarations so every extraction path runs: names, signatures, doc
  // comments, imports, exports, and search terms.
  const FILES = 60;
  const PADDING = 300_000;

  const root = await mkdtemp(join(tmpdir(), 'jellybean-retain-'));
  try {
    await mkdir(join(root, 'src'), { recursive: true });
    for (let i = 0; i < FILES; i++) {
      const body = [
        `import { helper${i} } from './helper${i}.js';`,
        '',
        '/** A generated declaration with a doc comment attached to it. */',
        `export class GeneratedService${i} {`,
        `  async fetchSomethingWithALongName${i}(identifier: string): Promise<string> {`,
        `    return helper${i}(identifier);`,
        '  }',
        '}',
        '',
        `export const GENERATED_CONSTANT_${i} = ${i};`,
        '',
        `// ${'filler '.repeat(PADDING / 7)}`,
      ].join('\n');
      await writeFile(join(root, 'src', `service${i}.ts`), body, 'utf8');
    }

    const collect = (): number => {
      global.gc!();
      global.gc!();
      return process.memoryUsage().heapUsed;
    };

    // Measure the index's own growth. Absolute heap is mostly the Node process
    // and this test file's own module graph, which would drown the signal.
    const baseline = collect();

    const { config } = parseArgs([root]);
    const index = new CodeIndex(new Workspace(config.root, config.ignore), config);
    await index.ensureFresh(true);

    // Sanity: the fixture must actually have been parsed, or this measures nothing.
    assert.equal(index.fileCount, FILES);
    assert.ok(index.get('src/service0.ts')?.symbols.some((s) => s.name === 'GeneratedService0'));

    const grew = collect() - baseline;

    // Source held in memory costs two bytes per ASCII character, so retaining
    // every file would show up as at least this much. A tenth of it is a
    // generous ceiling for a description of sixty small classes.
    const ifRetained = FILES * PADDING * 2;
    assert.ok(
      grew < ifRetained / 10,
      `indexing grew the heap by ${(grew / 1e6).toFixed(1)}MB; holding every source file would cost ` +
        `about ${(ifRetained / 1e6).toFixed(0)}MB, so extracted strings are pointing back at their files`,
    );

    await index.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
