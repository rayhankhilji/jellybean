#!/usr/bin/env node
/**
 * Cross-platform test launcher.
 *
 * `node --test dist-test/test/*.test.js` looks portable but is not: PowerShell
 * does not expand the glob, so Node receives the literal pattern and fails.
 * Node's own directory discovery is not an option either — it would pick up the
 * TypeScript sources in `test/` and try to execute them.
 *
 * So we enumerate the compiled tests ourselves and hand them over explicitly.
 */

import { readdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const compiled = join(root, 'dist-test', 'test');

let entries;
try {
  entries = await readdir(compiled);
} catch {
  process.stderr.write(`No compiled tests at ${compiled}. Run "npm run build" first.\n`);
  process.exit(1);
}

const files = entries
  .filter((name) => name.endsWith('.test.js'))
  .sort()
  .map((name) => join(compiled, name));

if (files.length === 0) {
  process.stderr.write(`No *.test.js files in ${compiled}.\n`);
  process.exit(1);
}

// `--expose-gc` is for one test: that the index does not retain the source text
// it was built from. There is no way to observe retention without being able to
// collect first, and that regression is invisible until someone points the
// server at a repository large enough for it to matter.
const child = spawn(process.execPath, ['--expose-gc', '--test', ...files], { stdio: 'inherit', cwd: root });
child.on('error', (error) => {
  process.stderr.write(`Failed to launch the test runner: ${error.message}\n`);
  process.exit(1);
});
child.on('exit', (code, signal) => process.exit(signal ? 1 : (code ?? 1)));
