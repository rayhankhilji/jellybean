/**
 * The package version.
 *
 * Held in package.json alone. A hardcoded copy in the source is a second place
 * to forget, and the version a client is told during initialization is exactly
 * the one a bug report will be filed against — being wrong there sends someone
 * looking through the wrong release.
 *
 * Read by walking up from this module, because there are three layouts to cover:
 * `dist/version.js` when installed, `dist-test/src/version.js` when running the
 * test build, and neither if someone vendors the source somewhere unexpected.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Only ever seen if package.json cannot be found at all, which should not happen. */
const UNKNOWN = '0.0.0-unknown';

function readVersion(): string {
  let dir = dirname(fileURLToPath(import.meta.url));

  for (let depth = 0; depth < 5; depth++) {
    try {
      const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as Record<string, unknown>;
      // Any package.json will do as long as it is ours: a stray one in a build
      // directory would otherwise report someone else's version.
      if (manifest['name'] === 'jellybean-mcp' && typeof manifest['version'] === 'string') {
        return manifest['version'];
      }
    } catch {
      // Not here, or not readable. Keep walking.
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  return UNKNOWN;
}

export const SERVER_VERSION = readVersion();
