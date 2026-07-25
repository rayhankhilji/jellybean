/** Maps file extensions and names to languages and their syntax profiles. */

import {
  SYNTAX_C_LIKE,
  SYNTAX_HASH,
  SYNTAX_JS,
  SYNTAX_PYTHON,
  SYNTAX_RUST,
  type SyntaxProfile,
} from './scanner.js';
import type { LanguageId } from './types.js';

const BY_EXTENSION: Record<string, LanguageId> = {
  ts: 'typescript',
  tsx: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  py: 'python',
  pyi: 'python',
  go: 'go',
  rs: 'rust',
  java: 'java',
  kt: 'kotlin',
  kts: 'kotlin',
  swift: 'swift',
  rb: 'ruby',
  php: 'php',
  cs: 'csharp',
  c: 'c',
  h: 'c',
  cc: 'cpp',
  cpp: 'cpp',
  cxx: 'cpp',
  hpp: 'cpp',
  hh: 'cpp',
  sh: 'shell',
  bash: 'shell',
  zsh: 'shell',
  sql: 'sql',
  md: 'markdown',
  mdx: 'markdown',
  json: 'json',
  jsonc: 'json',
  yaml: 'yaml',
  yml: 'yaml',
  toml: 'toml',
  html: 'html',
  htm: 'html',
  vue: 'html',
  svelte: 'html',
  css: 'css',
  scss: 'css',
  less: 'css',
};

const BY_FILENAME: Record<string, LanguageId> = {
  dockerfile: 'shell',
  makefile: 'shell',
  '.bashrc': 'shell',
  '.zshrc': 'shell',
  'cargo.toml': 'toml',
  'go.mod': 'text',
};

const SYNTAX: Partial<Record<LanguageId, SyntaxProfile>> = {
  typescript: SYNTAX_JS,
  javascript: SYNTAX_JS,
  python: SYNTAX_PYTHON,
  go: SYNTAX_C_LIKE,
  rust: SYNTAX_RUST,
  java: SYNTAX_C_LIKE,
  kotlin: { ...SYNTAX_C_LIKE, nestedBlockComment: true, templates: true },
  swift: { ...SYNTAX_C_LIKE, nestedBlockComment: true },
  ruby: SYNTAX_HASH,
  php: { lineComment: ['//', '#'], blockComment: ['/*', '*/'], quotes: ['"', "'"] },
  csharp: SYNTAX_C_LIKE,
  c: SYNTAX_C_LIKE,
  cpp: SYNTAX_C_LIKE,
  shell: SYNTAX_HASH,
  sql: { lineComment: ['--'], blockComment: ['/*', '*/'], quotes: ['"', "'"] },
  yaml: SYNTAX_HASH,
  toml: SYNTAX_HASH,
  css: { lineComment: [], blockComment: ['/*', '*/'], quotes: ['"', "'"] },
};

/** A profile that masks nothing, for formats where quoting carries meaning. */
const SYNTAX_NONE: SyntaxProfile = { lineComment: [], quotes: [] };

/** Identify the language of a path. Returns `text` when unrecognized. */
export function detectLanguage(relPath: string): LanguageId {
  const base = relPath.slice(relPath.lastIndexOf('/') + 1).toLowerCase();

  const byName = BY_FILENAME[base];
  if (byName) return byName;

  const dot = base.lastIndexOf('.');
  if (dot <= 0) return 'text';
  return BY_EXTENSION[base.slice(dot + 1)] ?? 'text';
}

/** The masking profile for a language. */
export function syntaxFor(language: LanguageId): SyntaxProfile {
  return SYNTAX[language] ?? SYNTAX_NONE;
}

/** Whether a language has a symbol extractor worth running. */
export function isStructured(language: LanguageId): boolean {
  return language !== 'text' && language !== 'json';
}
