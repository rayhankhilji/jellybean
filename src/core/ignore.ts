/**
 * A `.gitignore`-compatible matcher.
 *
 * Implements the subset of gitignore semantics that actually appears in real
 * repositories: anchoring, directory-only rules, negation, `*`, `?`, `**`, and
 * character classes. Rules are evaluated last-match-wins, as git does.
 */

export interface IgnoreRule {
  /** Matches the path the rule names, exactly. */
  reSelf: RegExp;
  /** Matches anything *beneath* the path the rule names. */
  reUnder: RegExp;
  negated: boolean;
  directoryOnly: boolean;
  /** Directory the rule was declared in, relative to the root ('' for root). */
  base: string;
}

/** Directories that are never worth indexing, regardless of .gitignore. */
export const DEFAULT_IGNORES: readonly string[] = [
  '.git/',
  '.hg/',
  '.svn/',
  'node_modules/',
  'bower_components/',
  'vendor/',
  'dist/',
  'build/',
  'out/',
  'target/',
  '.next/',
  '.nuxt/',
  '.svelte-kit/',
  '.turbo/',
  '.parcel-cache/',
  'coverage/',
  '__pycache__/',
  '.pytest_cache/',
  '.mypy_cache/',
  '.ruff_cache/',
  '.tox/',
  '.venv/',
  'venv/',
  '.gradle/',
  '.idea/',
  '.vscode/',
  '.DS_Store',
  '*.min.js',
  '*.min.css',
  '*.map',
  '*.lock',
  'package-lock.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  '*.pyc',
  '*.class',
  '*.o',
  '*.so',
  '*.dylib',
  '*.dll',
  '*.exe',
  '*.pdf',
  '*.png',
  '*.jpg',
  '*.jpeg',
  '*.gif',
  '*.webp',
  '*.ico',
  '*.svg',
  '*.woff',
  '*.woff2',
  '*.ttf',
  '*.eot',
  '*.mp4',
  '*.mp3',
  '*.zip',
  '*.gz',
  '*.tar',
  '*.wasm',
];

/** Compile one gitignore line. Returns null for blanks and comments. */
export function compileRule(pattern: string, base = ''): IgnoreRule | null {
  let body = pattern.trim();
  if (body === '' || body.startsWith('#')) return null;

  const negated = body.startsWith('!');
  if (negated) body = body.slice(1);

  // An escaped leading '#' or '!' is a literal.
  body = body.replace(/^\\([!#])/, '$1');
  if (body === '') return null;

  const directoryOnly = body.endsWith('/');
  if (directoryOnly) body = body.slice(0, -1);

  // A pattern containing a slash (other than a trailing one) is anchored to the
  // directory holding the .gitignore; otherwise it matches at any depth.
  const anchored = body.includes('/');
  if (body.startsWith('/')) body = body.slice(1);

  // Two regexes rather than one, because git treats "this path" and "everything
  // under this path" differently: `dist/` names a directory, but every file
  // inside it is ignored too — even though those files are not directories.
  const prefix = anchored ? '' : '(?:.*/)?';
  const core = `${prefix}${globToRegExp(body)}`;
  return {
    reSelf: new RegExp(`^${core}$`),
    reUnder: new RegExp(`^${core}/`),
    negated,
    directoryOnly,
    base,
  };
}

/** Translate a gitignore glob into a regular expression body. */
function globToRegExp(glob: string): string {
  let out = '';
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i]!;
    switch (ch) {
      case '*':
        if (glob[i + 1] === '*') {
          // `**/` matches zero or more directories; a bare `**` matches anything.
          if (glob[i + 2] === '/') {
            out += '(?:.*/)?';
            i += 2;
          } else {
            out += '.*';
            i += 1;
          }
        } else {
          out += '[^/]*';
        }
        break;
      case '?':
        out += '[^/]';
        break;
      case '[': {
        const close = glob.indexOf(']', i + 1);
        if (close === -1) {
          out += '\\[';
          break;
        }
        let cls = glob.slice(i + 1, close);
        if (cls.startsWith('!')) cls = '^' + cls.slice(1);
        out += `[${cls.replace(/\\/g, '\\\\')}]`;
        i = close;
        break;
      }
      case '\\':
        out += '\\' + (glob[++i] ?? '\\');
        break;
      default:
        out += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return out;
}

/** An ordered set of rules, evaluated last-match-wins. */
export class IgnoreMatcher {
  private readonly rules: IgnoreRule[] = [];

  /** Add every rule in a `.gitignore` file body, scoped to `base`. */
  addGitignore(contents: string, base = ''): void {
    for (const line of contents.split('\n')) {
      const rule = compileRule(line, base);
      if (rule) this.rules.push(rule);
    }
  }

  /** Add raw patterns, scoped to the workspace root. */
  addPatterns(patterns: Iterable<string>, base = ''): void {
    for (const pattern of patterns) {
      const rule = compileRule(pattern, base);
      if (rule) this.rules.push(rule);
    }
  }

  /**
   * Whether `relPath` (POSIX-style, relative to the root, no leading slash)
   * is ignored. `isDir` matters for rules written with a trailing slash.
   */
  ignores(relPath: string, isDir: boolean): boolean {
    let ignored = false;
    for (const rule of this.rules) {
      let candidate = relPath;
      if (rule.base !== '') {
        if (!relPath.startsWith(rule.base + '/')) continue;
        candidate = relPath.slice(rule.base.length + 1);
      }

      // A directory-only rule cannot match a file by name, but it still ignores
      // everything nested beneath the directory it names.
      const matched = rule.reUnder.test(candidate) || ((!rule.directoryOnly || isDir) && rule.reSelf.test(candidate));
      if (matched) ignored = !rule.negated;
    }
    return ignored;
  }
}
