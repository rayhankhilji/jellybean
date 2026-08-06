/**
 * `--doctor` tests.
 *
 * The doctor exists to be trusted when something is wrong, which means two
 * properties matter more than its wording: it must not change anything it looks
 * at, and its exit code must distinguish "this will not work" from "this is
 * merely worth knowing".
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { parseArgs } from '../src/config.js';
import { runDoctor } from '../src/doctor.js';

/** Collect what the doctor wrote. */
function sink(): { stream: Writable; text(): string } {
  const chunks: string[] = [];
  return {
    stream: new Writable({
      write(chunk, _encoding, callback): void {
        chunks.push(String(chunk));
        callback();
      },
    }),
    text: () => chunks.join(''),
  };
}

async function inTempRepo(body: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'jellybean-doctor-'));
  try {
    await body(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('a healthy workspace passes and exits zero', async () => {
  await inTempRepo(async (root) => {
    await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'x', scripts: { test: 'echo ok' } }), 'utf8');
    await mkdir(join(root, 'src'), { recursive: true });
    await writeFile(join(root, 'src/index.ts'), 'export const value = 1;\n', 'utf8');

    const out = sink();
    const code = await runDoctor(parseArgs([root]).config, out.stream);

    assert.equal(code, 0, out.text());
    assert.match(out.text(), /2 files indexed/);
    assert.match(out.text(), /jb_diagnose\s+1 check/);
  });
});

test('a missing workspace fails, and says what to do about it', async () => {
  const out = sink();
  const code = await runDoctor(parseArgs([join(tmpdir(), 'jellybean-does-not-exist-9d1f')]).config, out.stream);

  assert.equal(code, 1);
  assert.match(out.text(), /does not exist/);
  assert.match(out.text(), /will stop the server working/);
  // The checks below a broken root would all be consequences of it, and a wall
  // of derived failures buries the one that matters.
  assert.equal(out.text().includes('parse cache'), false, 'reported consequences of an unusable root');
});

test('an empty workspace fails rather than quietly indexing nothing', async () => {
  await inTempRepo(async (root) => {
    const out = sink();
    const code = await runDoctor(parseArgs([root]).config, out.stream);

    assert.equal(code, 1, out.text());
    assert.match(out.text(), /no files were indexed/);
  });
});

test('a non-blocking problem is reported without failing', async () => {
  await inTempRepo(async (root) => {
    // No .git and no declared checks: both worth saying, neither fatal.
    await writeFile(join(root, 'main.py'), 'def go():\n    return 1\n', 'utf8');

    const out = sink();
    const code = await runDoctor(parseArgs([root]).config, out.stream);

    assert.equal(code, 0, out.text());
    assert.match(out.text(), /not a git repository/);
    assert.match(out.text(), /No blocking problems/);
  });
});

test('the doctor leaves the workspace exactly as it found it', async () => {
  await inTempRepo(async (root) => {
    await writeFile(join(root, 'main.go'), 'package main\n\nfunc main() {}\n', 'utf8');
    const before = (await readdir(root)).sort();

    await runDoctor(parseArgs([root]).config, sink().stream);

    // Checking whether notes can be written must not be done by writing them.
    assert.deepEqual((await readdir(root)).sort(), before, 'the doctor created something');
  });
});

test('--doctor is recognised wherever it appears in the arguments', () => {
  assert.equal(parseArgs(['--doctor', '/tmp']).action, 'doctor');
  assert.equal(parseArgs(['/tmp', '--doctor']).action, 'doctor');
  assert.equal(parseArgs(['/tmp']).action, undefined);
});
