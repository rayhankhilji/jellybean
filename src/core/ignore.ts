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

/**
 * An ordered set of rules, evaluated last-match-wins.
 *
 * The built-in list alone is ~60 rules, each with two regexes, and `ignores` is
 * called for every entry in every directory. Running 120 regexes per file made
 * walking a large repository slower than parsing it. So the overwhelmingly
 * common rule shapes — a bare directory name like `node_modules/`, a bare file
 * name like `.DS_Store`, and an extension glob like `*.png` — are bucketed into
 * sets and answered with a lookup. Only the remainder reach the regex path.
 *
 * The fast path is only valid while no negations exist: a `!keep.log` rule makes
 * order significant, so the presence of one disables bucketing entirely rather
 * than risk disagreeing with the general algorithm.
 */
export class IgnoreMatcher {
  private readonly rules: IgnoreRule[] = [];

  /** Bare names that ignore a directory outright, e.g. `node_modules/`. */
  private readonly literalDirectories = new Set<string>();
  /** Bare names that ignore a file outright, e.g. `.DS_Store`. */
  private readonly literalFiles = new Set<string>();
  /** Extensions from `*.ext` rules, stored with the dot. */
  private readonly extensions = new Set<string>();
  /** Set once any negation is added; disables the fast path. */
  private hasNegation = false;

  /** Add every rule in a `.gitignore` file body, scoped to `base`. */
  addGitignore(contents: string, base = ''): void {
    for (const line of contents.split('\n')) {
      const rule = compileRule(line, base);
      // Must go through `push`, not straight into `rules`: it is what notices a
      // negation and disables the fast path. Bypassing it here silently broke
      // `!keep.log` while leaving every other case correct.
      if (rule) this.push(line, rule);
    }
  }

  /** Add raw patterns, scoped to the workspace root. */
  addPatterns(patterns: Iterable<string>, base = ''): void {
    for (const pattern of patterns) {
      const rule = compileRule(pattern, base);
      if (rule) this.push(pattern, rule);
    }
  }

  /** Record a rule, bucketing it into the fast path when its shape allows. */
  private push(pattern: string, rule: IgnoreRule): void {
    this.rules.push(rule);
    if (rule.negated) {
      this.hasNegation = true;
      return;
    }
    if (rule.base !== '') return;

    const body = pattern.trim();
    // Only unanchored, unescaped, single-segment patterns can be bucketed.
    if (body.includes('/') && !/^[^/*?[\]\\]+\/$/.test(body)) return;

    const extension = /^\*(\.[A-Za-z0-9.]+)$/.exec(body);
    if (extension) {
      this.extensions.add(extension[1]!.toLowerCase());
      return;
    }
    if (/[*?[\]\\]/.test(body)) return;

    if (body.endsWith('/')) this.literalDirectories.add(body.slice(0, -1));
    else this.literalFiles.add(body);
  }

  private combinedCache: { any: RegExp; directoryOnly: RegExp; at: number } | null = null;
  private scopedCache: { rules: IgnoreRule[]; at: number } | null = null;

  /**
   * Root-scoped rules as two alternations: those that apply to any entry, and
   * those that only ignore a directory by name. Rebuilt when rules are added.
   */
  private combined(): { any: RegExp; directoryOnly: RegExp } {
    if (this.combinedCache && this.combinedCache.at === this.rules.length) return this.combinedCache;

    const any: string[] = [];
    const directoryOnly: string[] = [];
    for (const rule of this.rules) {
      if (rule.negated || rule.base !== '') continue;
      any.push(source(rule.reUnder));
      (rule.directoryOnly ? directoryOnly : any).push(source(rule.reSelf));
    }

    const built = {
      any: alternation(any),
      directoryOnly: alternation(directoryOnly),
      at: this.rules.length,
    };
    this.combinedCache = built;
    return built;
  }

  /** Rules declared in a nested .gitignore, which the alternation cannot cover. */
  private scopedRules(): IgnoreRule[] {
    if (this.scopedCache && this.scopedCache.at === this.rules.length) return this.scopedCache.rules;
    const rules = this.rules.filter((rule) => rule.base !== '');
    this.scopedCache = { rules, at: this.rules.length };
    return rules;
  }

  private matches(rule: IgnoreRule, relPath: string, isDir: boolean): boolean {
    let candidate = relPath;
    if (rule.base !== '') {
      if (!relPath.startsWith(rule.base + '/')) return false;
      candidate = relPath.slice(rule.base.length + 1);
    }
    return rule.reUnder.test(candidate) || ((!rule.directoryOnly || isDir) && rule.reSelf.test(candidate));
  }

  /**
   * Whether `relPath` (POSIX-style, relative to the root, no leading slash)
   * is ignored. `isDir` matters for rules written with a trailing slash.
   */
  ignores(relPath: string, isDir: boolean): boolean {
    if (!this.hasNegation) {
      const name = relPath.slice(relPath.lastIndexOf('/') + 1);
      if (isDir) {
        if (this.literalDirectories.has(name)) return true;
      } else {
        if (this.literalFiles.has(name)) return true;
        const dot = name.lastIndexOf('.');
        if (dot > 0 && this.extensions.has(name.slice(dot).toLowerCase())) return true;
      }

      // A bucket miss is not an answer, but with no negations every root rule
      // can be tried as one alternation instead of two regexes apiece — which
      // is the difference on the overwhelmingly common case, an ordinary source
      // file that matches nothing.
      const combined = this.combined();
      if (combined.any.test(relPath)) return true;
      if (isDir && combined.directoryOnly.test(relPath)) return true;

      // Only scoped rules remain unconsulted.
      return this.scopedRules().some((rule) => this.matches(rule, relPath, isDir));
    }

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

/** The body of a regex, without its anchors, for use inside an alternation. */
function source(re: RegExp): string {
  return re.source;
}

/** Combine alternatives into one regex. Never matches when there are none. */
function alternation(parts: readonly string[]): RegExp {
  if (parts.length === 0) return /(?!)/;
  return new RegExp(parts.map((part) => `(?:${part})`).join('|'));
}
