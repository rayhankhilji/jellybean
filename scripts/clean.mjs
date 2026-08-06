#!/usr/bin/env node
/**
 * Remove build output.
 *
 * A script rather than `rm -rf` in package.json, for the same reason the test
 * launcher is one: `rm` does not exist on Windows, and `npm run clean` failing
 * there is a papercut that shows up on someone's first contribution.
 */

import { rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

await Promise.all(['dist', 'dist-test'].map((dir) => rm(join(projectRoot, dir), { recursive: true, force: true })));
