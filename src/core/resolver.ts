/**
 * Import resolution: turn a module specifier into a workspace file.
 *
 * This is what makes `jb_trace` possible. It is intentionally heuristic — a
 * faithful resolver would need each language's full module-search algorithm
 * plus its build configuration. What we need instead is: given `./core/index.js`
 * in a TypeScript project, find `src/core/index.ts`. Unresolvable specifiers
 * are reported as external dependencies rather than guessed at.
 */

import type { LanguageId } from '../lang/types.js';

export interface ResolutionContext {
  /** Whether an exact workspace-relative path exists. */
  has(path: string): boolean;
  /** Every path whose final segment equals `name`. */
  byBasename(name: string): readonly string[];
}

/** Extensions tried when a specifier omits one, per language family. */
const CANDIDATE_EXTENSIONS: Partial<Record<LanguageId, string[]>> = {
  typescript: ['.ts', '.tsx', '.d.ts', '.js', '.jsx', '.mts', '.cts', '.mjs', '.cjs'],
  javascript: ['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx'],
  python: ['.py', '.pyi'],
  go: ['.go'],
  rust: ['.rs'],
  ruby: ['.rb'],
  php: ['.php'],
  c: ['.h', '.c'],
  cpp: ['.hpp', '.h', '.cpp', '.cc'],
};

/** Files tried when a specifier resolves to a directory. */
const INDEX_STEMS: Partial<Record<LanguageId, string[]>> = {
  typescript: ['index'],
  javascript: ['index'],
  python: ['__init__'],
  rust: ['mod'],
  ruby: ['index'],
};

export function resolveSpecifier(
  specifier: string,
  fromPath: string,
  language: LanguageId,
  ctx: ResolutionContext,
): string | null {
  if (specifier === '') return null;

  switch (language) {
    case 'typescript':
    case 'javascript':
      return resolveRelativeStyle(specifier, fromPath, language, ctx);
    case 'python':
      return resolvePython(specifier, fromPath, ctx);
    case 'rust':
      return resolveRust(specifier, fromPath, ctx);
    case 'go':
      return resolveByPathSuffix(specifier, ctx, ['.go']);
    case 'java':
    case 'kotlin':
    case 'csharp':
      return resolveDotted(specifier, ctx, language === 'kotlin' ? ['.kt', '.java'] : ['.java', '.cs']);
    case 'c':
    case 'cpp':
    case 'ruby':
    case 'php':
    case 'shell':
      return resolveRelativeStyle(specifier, fromPath, language, ctx) ?? resolveByPathSuffix(specifier, ctx, []);
    default:
      return null;
  }
}

/** Resolve `./x`, `../x`, or a bare path against the importing file's directory. */
function resolveRelativeStyle(
  specifier: string,
  fromPath: string,
  language: LanguageId,
  ctx: ResolutionContext,
): string | null {
  if (!specifier.startsWith('.') && !specifier.startsWith('/')) return null;

  const base = joinPosix(dirnamePosix(fromPath), specifier);
  return resolveFileOrDirectory(base, language, ctx);
}

function resolveFileOrDirectory(base: string, language: LanguageId, ctx: ResolutionContext): string | null {
  if (ctx.has(base)) return base;

  const extensions = CANDIDATE_EXTENSIONS[language] ?? [];

  // A specifier written with a `.js` extension in a TypeScript project points at
  // the compiled output; the source next to it is what we actually want.
  const rewritten = base.replace(/\.(js|mjs|cjs|jsx)$/, '');
  const stems = rewritten === base ? [base] : [rewritten, base];

  for (const stem of stems) {
    for (const ext of extensions) {
      if (ctx.has(stem + ext)) return stem + ext;
    }
  }

  for (const stem of INDEX_STEMS[language] ?? []) {
    for (const ext of extensions) {
      const candidate = `${base}/${stem}${ext}`;
      if (ctx.has(candidate)) return candidate;
    }
  }
  return null;
}

function resolvePython(specifier: string, fromPath: string, ctx: ResolutionContext): string | null {
  // Leading dots mean "relative to my package", one level per dot.
  const leadingDots = /^\.+/.exec(specifier)?.[0].length ?? 0;
  const body = specifier.slice(leadingDots).replace(/\./g, '/');

  if (leadingDots > 0) {
    let dir = dirnamePosix(fromPath);
    for (let i = 1; i < leadingDots; i++) dir = dirnamePosix(dir);
    const base = body === '' ? dir : joinPosix(dir, body);
    return resolveFileOrDirectory(base, 'python', ctx);
  }

  // Absolute module path: try it from the repository root and from the usual
  // source roots before falling back to a suffix match.
  for (const prefix of ['', 'src/', 'lib/', 'app/']) {
    const found = resolveFileOrDirectory(prefix + body, 'python', ctx);
    if (found) return found;
  }
  return resolveByPathSuffix(body, ctx, ['.py']);
}

function resolveRust(specifier: string, fromPath: string, ctx: ResolutionContext): string | null {
  const segments = specifier.split('::').filter(Boolean);
  if (segments.length === 0) return null;

  const head = segments[0]!;
  if (head === 'std' || head === 'core' || head === 'alloc') return null;

  let rest = segments.slice(1);
  let base: string;

  if (head === 'crate') {
    base = 'src';
  } else if (head === 'self') {
    base = dirnamePosix(fromPath);
  } else if (head === 'super') {
    base = dirnamePosix(dirnamePosix(fromPath));
    while (rest[0] === 'super') {
      base = dirnamePosix(base);
      rest = rest.slice(1);
    }
  } else {
    // Either a sibling module or an external crate; try the module first.
    base = dirnamePosix(fromPath);
    rest = segments;
  }

  // Trailing segments may name items rather than modules, so try progressively
  // shorter paths: `crate::a::b::Thing` → `src/a/b.rs`, then `src/a.rs`.
  for (let take = rest.length; take >= 0; take--) {
    const candidate = [base, ...rest.slice(0, take)].filter(Boolean).join('/');
    const found = resolveFileOrDirectory(candidate, 'rust', ctx);
    if (found) return found;
  }
  return null;
}

function resolveDotted(specifier: string, ctx: ResolutionContext, extensions: string[]): string | null {
  const asPath = specifier.replace(/\./g, '/').replace(/\/\*$/, '');
  return resolveByPathSuffix(asPath, ctx, extensions);
}

/** Match a specifier against the tail of known paths, e.g. `pkg/util` → `src/pkg/util.go`. */
function resolveByPathSuffix(specifier: string, ctx: ResolutionContext, extensions: string[]): string | null {
  const cleaned = specifier.replace(/^\.\//, '').replace(/\/+$/, '');
  if (cleaned === '') return null;

  const leaf = cleaned.slice(cleaned.lastIndexOf('/') + 1);
  const leafStem = leaf.includes('.') ? leaf.slice(0, leaf.lastIndexOf('.')) : leaf;

  const names = extensions.length > 0 ? extensions.map((ext) => leafStem + ext) : [leaf];
  const candidates: string[] = [];
  for (const name of names) candidates.push(...ctx.byBasename(name));

  if (candidates.length === 0) return null;

  // Prefer a candidate whose full path ends with the specifier, so `a/b/util`
  // does not match `z/util` when `a/b/util.go` exists.
  const withSlash = '/' + cleaned;
  const exact = candidates.filter((p) => p === cleaned || stripExt(p) === cleaned || stripExt('/' + p).endsWith(withSlash));
  const pool = exact.length > 0 ? exact : candidates;

  // Ambiguity is not resolution — a wrong edge is worse than a missing one.
  if (pool.length > 1 && exact.length !== 1) return null;
  return pool[0] ?? null;
}

function stripExt(path: string): string {
  const dot = path.lastIndexOf('.');
  const slash = path.lastIndexOf('/');
  return dot > slash ? path.slice(0, dot) : path;
}

function dirnamePosix(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash === -1 ? '' : path.slice(0, slash);
}

/** Join and normalize `.` / `..` segments without touching the filesystem. */
function joinPosix(base: string, relative: string): string {
  const segments = relative.startsWith('/') ? [] : base.split('/').filter(Boolean);
  for (const segment of relative.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') segments.pop();
    else segments.push(segment);
  }
  return segments.join('/');
}
