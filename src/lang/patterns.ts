/**
 * Declaration patterns per language.
 *
 * These are deliberately regex-based rather than a real parser. A full parser
 * per language would mean a tree-sitter dependency per language, native builds,
 * and version drift — for an outline that only needs a name, a kind, and a line
 * range, that is a bad trade. Every pattern here runs against *masked* source
 * (see scanner.ts), so strings and comments cannot produce false matches.
 *
 * Each pattern must expose a `name` capture group.
 */

import type { LanguageId, SymbolKind } from './types.js';

export interface DeclPattern {
  kind: SymbolKind;
  re: RegExp;
  /**
   * When true, the pattern may only match inside a class-like container.
   * Keeps object-literal methods and local closures out of the outline.
   */
  memberOnly?: boolean;
  /**
   * When true, the pattern is not anchored by a declaration keyword, so it could
   * accidentally match control flow — `if (x) {` looks a lot like a method
   * declaration. Only these patterns are filtered against RESERVED_NAMES.
   *
   * Keyword-anchored patterns must *not* set this: `fn new()` and `def next()`
   * are perfectly ordinary declarations whose names happen to be keywords
   * elsewhere, and rejecting them would silently drop every Rust constructor.
   */
  loose?: boolean;
  /**
   * Prepended to the captured name. Used where the bare name would collide with
   * another declaration — a Rust `impl Config` block and the `struct Config` it
   * implements would otherwise both be listed as "Config".
   */
  namePrefix?: string;
}

/** Kinds that can contain members. */
export const CONTAINER_KINDS: ReadonlySet<SymbolKind> = new Set<SymbolKind>([
  'class',
  'interface',
  'struct',
  'enum',
  'trait',
  'module',
]);

const TS_PATTERNS: DeclPattern[] = [
  { kind: 'class', re: /^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+(?<name>[A-Za-z_$][\w$]*)/ },
  { kind: 'interface', re: /^\s*(?:export\s+)?(?:declare\s+)?interface\s+(?<name>[A-Za-z_$][\w$]*)/ },
  { kind: 'enum', re: /^\s*(?:export\s+)?(?:declare\s+)?(?:const\s+)?enum\s+(?<name>[A-Za-z_$][\w$]*)/ },
  { kind: 'type', re: /^\s*(?:export\s+)?(?:declare\s+)?type\s+(?<name>[A-Za-z_$][\w$]*)/ },
  { kind: 'module', re: /^\s*(?:export\s+)?(?:declare\s+)?(?:namespace|module)\s+(?<name>[A-Za-z_$][\w$.]*)/ },
  {
    kind: 'function',
    re: /^\s*(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:async\s+)?function\s*\*?\s*(?<name>[A-Za-z_$][\w$]*)/,
  },
  // Arrow functions and function expressions bound to a name.
  {
    kind: 'function',
    re: /^\s*(?:export\s+)?(?:declare\s+)?(?:const|let|var)\s+(?<name>[A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s*)?(?:function\b|\([^)]*\)\s*(?::[^=]+?)?=>|[A-Za-z_$][\w$]*\s*=>)/,
  },
  // Any other bound top-level value. Ordered after the function forms so a
  // named arrow function is reported as a function, not a constant.
  {
    kind: 'constant',
    re: /^\s*(?:export\s+)?(?:declare\s+)?(?:const|let|var)\s+(?<name>[A-Za-z_$][\w$]*)\s*(?::|=)/,
  },
  { kind: 'method', re: /^\s*(?<name>constructor)\s*\(/, memberOnly: true },
  {
    kind: 'method',
    re: /^\s*(?:public\s+|private\s+|protected\s+|static\s+|readonly\s+|abstract\s+|override\s+|async\s+|get\s+|set\s+|\*\s*)*(?<name>[A-Za-z_$#][\w$]*)\s*(?:<[^>(]*>)?\s*\((?![^)]*\)\s*=>\s*[,)])/,
    memberOnly: true,
    loose: true,
  },
  {
    kind: 'property',
    re: /^\s*(?:public\s+|private\s+|protected\s+|static\s+|readonly\s+|abstract\s+|override\s+|declare\s+)*(?<name>[A-Za-z_$#][\w$]*)\s*[?!]?\s*[:=][^=]/,
    memberOnly: true,
    loose: true,
  },
];

const PYTHON_PATTERNS: DeclPattern[] = [
  { kind: 'class', re: /^\s*class\s+(?<name>[A-Za-z_]\w*)/ },
  { kind: 'function', re: /^\s*(?:async\s+)?def\s+(?<name>[A-Za-z_]\w*)/ },
  { kind: 'constant', re: /^(?<name>[A-Z_][A-Z0-9_]*)\s*(?::[^=]+)?=/, loose: true },
];

const GO_PATTERNS: DeclPattern[] = [
  { kind: 'method', re: /^func\s+\([^)]*\)\s*(?<name>[A-Za-z_]\w*)\s*\(/ },
  { kind: 'function', re: /^func\s+(?<name>[A-Za-z_]\w*)\s*(?:\[[^\]]*\])?\s*\(/ },
  { kind: 'struct', re: /^\s*type\s+(?<name>[A-Za-z_]\w*)(?:\[[^\]]*\])?\s+struct\b/ },
  { kind: 'interface', re: /^\s*type\s+(?<name>[A-Za-z_]\w*)(?:\[[^\]]*\])?\s+interface\b/ },
  { kind: 'type', re: /^\s*type\s+(?<name>[A-Za-z_]\w*)/ },
  { kind: 'constant', re: /^\s*(?:const|var)\s+(?<name>[A-Za-z_]\w*)\s*(?:[\w*.\[\]]+\s*)?=/ },
];

const RUST_PATTERNS: DeclPattern[] = [
  { kind: 'struct', re: /^\s*(?:pub(?:\([^)]*\))?\s+)?struct\s+(?<name>[A-Za-z_]\w*)/ },
  { kind: 'enum', re: /^\s*(?:pub(?:\([^)]*\))?\s+)?enum\s+(?<name>[A-Za-z_]\w*)/ },
  { kind: 'trait', re: /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:unsafe\s+)?trait\s+(?<name>[A-Za-z_]\w*)/ },
  { kind: 'module', re: /^\s*(?:pub(?:\([^)]*\))?\s+)?mod\s+(?<name>[A-Za-z_]\w*)/ },
  // `impl Foo` and `impl Trait for Foo` both become a container for the type.
  {
    kind: 'module',
    re: /^\s*impl(?:\s*<[^>]*>)?\s+(?:(?:[\w:]+(?:<[^>]*>)?)\s+for\s+)?(?<name>[A-Za-z_][\w:]*)/,
    namePrefix: 'impl ',
  },
  {
    kind: 'function',
    re: /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:default\s+)?(?:const\s+)?(?:async\s+)?(?:unsafe\s+)?(?:extern\s+"[^"]*"\s+)?fn\s+(?<name>[A-Za-z_]\w*)/,
  },
  { kind: 'type', re: /^\s*(?:pub(?:\([^)]*\))?\s+)?type\s+(?<name>[A-Za-z_]\w*)/ },
  { kind: 'constant', re: /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:const|static)\s+(?:mut\s+)?(?<name>[A-Za-z_]\w*)\s*:/ },
];

const JVM_MODIFIERS =
  '(?:public\\s+|private\\s+|protected\\s+|internal\\s+|static\\s+|final\\s+|abstract\\s+|sealed\\s+|open\\s+|override\\s+|suspend\\s+|inline\\s+|data\\s+|synchronized\\s+|native\\s+|default\\s+)*';

const JAVA_PATTERNS: DeclPattern[] = [
  { kind: 'class', re: new RegExp(`^\\s*${JVM_MODIFIERS}(?:class|record)\\s+(?<name>[A-Za-z_]\\w*)`) },
  { kind: 'interface', re: new RegExp(`^\\s*${JVM_MODIFIERS}interface\\s+(?<name>[A-Za-z_]\\w*)`) },
  { kind: 'enum', re: new RegExp(`^\\s*${JVM_MODIFIERS}enum\\s+(?<name>[A-Za-z_]\\w*)`) },
  {
    kind: 'method',
    re: new RegExp(
      `^\\s*${JVM_MODIFIERS}(?:<[^>]+>\\s*)?[\\w$<>\\[\\],.?\\s]+?\\s+(?<name>[A-Za-z_]\\w*)\\s*\\([^;]*$`,
    ),
    memberOnly: true,
    loose: true,
  },
];

const KOTLIN_PATTERNS: DeclPattern[] = [
  { kind: 'class', re: new RegExp(`^\\s*${JVM_MODIFIERS}(?:class|object)\\s+(?<name>[A-Za-z_]\\w*)`) },
  { kind: 'interface', re: new RegExp(`^\\s*${JVM_MODIFIERS}interface\\s+(?<name>[A-Za-z_]\\w*)`) },
  { kind: 'enum', re: new RegExp(`^\\s*${JVM_MODIFIERS}enum\\s+class\\s+(?<name>[A-Za-z_]\\w*)`) },
  { kind: 'function', re: new RegExp(`^\\s*${JVM_MODIFIERS}fun\\s+(?:<[^>]+>\\s*)?(?:[\\w.<>]+\\.)?(?<name>[A-Za-z_]\\w*)\\s*\\(`) },
  { kind: 'constant', re: new RegExp(`^\\s*${JVM_MODIFIERS}(?:val|var)\\s+(?<name>[A-Za-z_]\\w*)`) },
];

const SWIFT_PATTERNS: DeclPattern[] = [
  { kind: 'class', re: /^\s*(?:public\s+|private\s+|internal\s+|fileprivate\s+|open\s+|final\s+|static\s+)*class\s+(?<name>[A-Za-z_]\w*)/ },
  { kind: 'struct', re: /^\s*(?:public\s+|private\s+|internal\s+|fileprivate\s+|frozen\s+)*struct\s+(?<name>[A-Za-z_]\w*)/ },
  { kind: 'interface', re: /^\s*(?:public\s+|private\s+|internal\s+)*protocol\s+(?<name>[A-Za-z_]\w*)/ },
  { kind: 'enum', re: /^\s*(?:public\s+|private\s+|internal\s+|indirect\s+)*enum\s+(?<name>[A-Za-z_]\w*)/ },
  { kind: 'module', re: /^\s*(?:public\s+|private\s+|internal\s+)*extension\s+(?<name>[A-Za-z_]\w*)/ },
  { kind: 'function', re: /^\s*(?:public\s+|private\s+|internal\s+|fileprivate\s+|open\s+|final\s+|static\s+|class\s+|override\s+|mutating\s+|@\w+\s+)*func\s+(?<name>[A-Za-z_]\w*)/ },
  { kind: 'property', re: /^\s*(?:public\s+|private\s+|internal\s+|static\s+|lazy\s+)*(?:let|var)\s+(?<name>[A-Za-z_]\w*)\s*[:=]/, memberOnly: true },
];

const CSHARP_PATTERNS: DeclPattern[] = [
  { kind: 'class', re: new RegExp(`^\\s*${JVM_MODIFIERS}(?:partial\\s+)?(?:class|record|struct)\\s+(?<name>[A-Za-z_]\\w*)`) },
  { kind: 'interface', re: new RegExp(`^\\s*${JVM_MODIFIERS}interface\\s+(?<name>[A-Za-z_]\\w*)`) },
  { kind: 'enum', re: new RegExp(`^\\s*${JVM_MODIFIERS}enum\\s+(?<name>[A-Za-z_]\\w*)`) },
  { kind: 'module', re: /^\s*namespace\s+(?<name>[A-Za-z_][\w.]*)/ },
  {
    kind: 'method',
    re: new RegExp(`^\\s*${JVM_MODIFIERS}(?:async\\s+)?[\\w$<>\\[\\],.?\\s]+?\\s+(?<name>[A-Za-z_]\\w*)\\s*\\([^;]*$`),
    memberOnly: true,
    loose: true,
  },
];

const C_PATTERNS: DeclPattern[] = [
  { kind: 'struct', re: /^\s*(?:typedef\s+)?struct\s+(?<name>[A-Za-z_]\w*)/ },
  { kind: 'enum', re: /^\s*(?:typedef\s+)?enum\s+(?<name>[A-Za-z_]\w*)/ },
  { kind: 'class', re: /^\s*class\s+(?<name>[A-Za-z_]\w*)/ },
  { kind: 'module', re: /^\s*namespace\s+(?<name>[A-Za-z_]\w*)/ },
  { kind: 'constant', re: /^\s*#define\s+(?<name>[A-Za-z_]\w*)/ },
  {
    kind: 'function',
    re: /^\s*(?:static\s+|inline\s+|extern\s+|const\s+|unsigned\s+|virtual\s+)*[A-Za-z_][\w:<>,\s*&]*?[\s*&]+(?<name>[A-Za-z_]\w*)\s*\([^;]*$/,
    loose: true,
  },
];

const RUBY_PATTERNS: DeclPattern[] = [
  { kind: 'class', re: /^\s*class\s+(?<name>[A-Z]\w*)/ },
  { kind: 'module', re: /^\s*module\s+(?<name>[A-Z]\w*)/ },
  { kind: 'function', re: /^\s*def\s+(?:self\.)?(?<name>[A-Za-z_]\w*[?!=]?)/ },
  { kind: 'constant', re: /^\s*(?<name>[A-Z][A-Z0-9_]*)\s*=/, loose: true },
];

const PHP_PATTERNS: DeclPattern[] = [
  { kind: 'class', re: /^\s*(?:abstract\s+|final\s+)*class\s+(?<name>[A-Za-z_]\w*)/ },
  { kind: 'interface', re: /^\s*interface\s+(?<name>[A-Za-z_]\w*)/ },
  { kind: 'trait', re: /^\s*trait\s+(?<name>[A-Za-z_]\w*)/ },
  { kind: 'function', re: /^\s*(?:public\s+|private\s+|protected\s+|static\s+|final\s+|abstract\s+)*function\s+&?(?<name>[A-Za-z_]\w*)/ },
  { kind: 'constant', re: /^\s*(?:const\s+(?<name>[A-Za-z_]\w*))/ },
];

const SHELL_PATTERNS: DeclPattern[] = [
  { kind: 'function', re: /^\s*(?:function\s+)?(?<name>[A-Za-z_][\w-]*)\s*\(\)\s*\{/, loose: true },
  { kind: 'function', re: /^\s*function\s+(?<name>[A-Za-z_][\w-]*)/ },
];

const SQL_PATTERNS: DeclPattern[] = [
  {
    kind: 'type',
    re: /^\s*CREATE\s+(?:OR\s+REPLACE\s+)?(?:TABLE|VIEW|MATERIALIZED\s+VIEW)\s+(?:IF\s+NOT\s+EXISTS\s+)?(?<name>[\w."]+)/i,
  },
  {
    kind: 'function',
    re: /^\s*CREATE\s+(?:OR\s+REPLACE\s+)?(?:FUNCTION|PROCEDURE)\s+(?<name>[\w."]+)/i,
  },
];

const CSS_PATTERNS: DeclPattern[] = [
  { kind: 'section', re: /^(?<name>[.#@:a-zA-Z\[][^{};]*?)\s*\{/, loose: true },
];

/** Languages whose blocks are delimited by braces. */
export const BRACE_LANGUAGES: ReadonlySet<LanguageId> = new Set<LanguageId>([
  'typescript',
  'javascript',
  'go',
  'rust',
  'java',
  'kotlin',
  'swift',
  'csharp',
  'c',
  'cpp',
  'php',
  'css',
]);

/** Languages whose blocks are delimited by indentation. */
export const INDENT_LANGUAGES: ReadonlySet<LanguageId> = new Set<LanguageId>(['python', 'ruby']);

const TABLE: Partial<Record<LanguageId, DeclPattern[]>> = {
  typescript: TS_PATTERNS,
  javascript: TS_PATTERNS,
  python: PYTHON_PATTERNS,
  go: GO_PATTERNS,
  rust: RUST_PATTERNS,
  java: JAVA_PATTERNS,
  kotlin: KOTLIN_PATTERNS,
  swift: SWIFT_PATTERNS,
  csharp: CSHARP_PATTERNS,
  c: C_PATTERNS,
  cpp: C_PATTERNS,
  ruby: RUBY_PATTERNS,
  php: PHP_PATTERNS,
  shell: SHELL_PATTERNS,
  sql: SQL_PATTERNS,
  css: CSS_PATTERNS,
};

export function patternsFor(language: LanguageId): DeclPattern[] {
  return TABLE[language] ?? [];
}

/** Keywords that look like declarations but are control flow. */
export const RESERVED_NAMES: ReadonlySet<string> = new Set([
  'if', 'else', 'for', 'while', 'switch', 'case', 'catch', 'try', 'finally', 'do', 'return',
  'with', 'match', 'loop', 'defer', 'go', 'select', 'when', 'guard', 'repeat', 'using',
  'foreach', 'lock', 'unless', 'elif', 'except', 'and', 'or', 'not', 'in', 'is', 'new',
  'typeof', 'await', 'yield', 'throw', 'break', 'continue', 'import', 'export', 'from',
  'require', 'print', 'assert', 'del', 'pass', 'raise', 'sizeof', 'static_assert',
]);
