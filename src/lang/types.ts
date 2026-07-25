/** Shared vocabulary for the language layer. */

export type LanguageId =
  | 'typescript'
  | 'javascript'
  | 'python'
  | 'go'
  | 'rust'
  | 'java'
  | 'kotlin'
  | 'swift'
  | 'ruby'
  | 'php'
  | 'csharp'
  | 'c'
  | 'cpp'
  | 'shell'
  | 'sql'
  | 'markdown'
  | 'json'
  | 'yaml'
  | 'toml'
  | 'html'
  | 'css'
  | 'text';

export type SymbolKind =
  | 'class'
  | 'interface'
  | 'struct'
  | 'enum'
  | 'trait'
  | 'type'
  | 'function'
  | 'method'
  | 'constant'
  | 'variable'
  | 'property'
  | 'module'
  | 'section';

/** A named, addressable region of a file. */
export interface CodeSymbol {
  name: string;
  kind: SymbolKind;
  /** 1-based, inclusive. */
  startLine: number;
  /** 1-based, inclusive. Equals startLine when the extent is unknown. */
  endLine: number;
  /** Nesting depth: 0 for top-level declarations. */
  depth: number;
  /** The declaration line, normalized — no body, no trailing brace. */
  signature: string;
  /** Whether the symbol is exported / public / part of the module's surface. */
  exported: boolean;
  /** First line of an attached doc comment, when one is present. */
  doc?: string;
}

/** A module dependency declared by a file. */
export interface ImportRef {
  /** The raw specifier, e.g. `./core/index.js` or `os.path`. */
  specifier: string;
  /** 1-based line the import appears on. */
  line: number;
  /** Named bindings pulled in, when the syntax makes them cheap to read. */
  names: string[];
}

/** Everything the language layer knows about one file. */
export interface ParsedFile {
  language: LanguageId;
  symbols: CodeSymbol[];
  imports: ImportRef[];
  /** Names this file makes available to others. */
  exports: string[];
}
