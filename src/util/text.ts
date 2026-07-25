/** Small text helpers shared across indexing, search, and rendering. */

/**
 * Split an identifier into its constituent words.
 *
 * `parseHTTPResponse` → `parse`, `http`, `response`
 * `user_id_map`       → `user`, `id`, `map`
 *
 * Search relies on this so that querying "http response" matches
 * `parseHTTPResponse` without the caller having to guess the casing.
 */
export function splitIdentifier(identifier: string): string[] {
  const parts = identifier
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/);
  return parts.filter((p) => p.length > 0).map((p) => p.toLowerCase());
}

/**
 * Tokenize source text for the search index.
 *
 * Emits both the whole identifier and its sub-words, so `getUserName` is
 * findable as `getusername`, `get`, `user`, and `name`.
 */
export function tokenizeCode(text: string): string[] {
  const out: string[] = [];
  const identifiers = text.match(/[A-Za-z_$][A-Za-z0-9_$]*/g);
  if (!identifiers) return out;

  for (const id of identifiers) {
    if (id.length > 64) continue; // minified blob or base64 payload; not useful
    const lower = id.toLowerCase();
    out.push(lower);
    const parts = splitIdentifier(id);
    if (parts.length > 1) out.push(...parts);
  }
  return out;
}

/** Collapse runs of whitespace into single spaces and trim. */
export function squish(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** Truncate to a character length, adding an ellipsis when shortened. */
export function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  if (maxChars <= 1) return '…';
  return text.slice(0, maxChars - 1).trimEnd() + '…';
}

/**
 * Split text into lines without allocating a trailing empty entry for files
 * that end with a newline (which every well-formed source file does).
 */
export function toLines(text: string): string[] {
  const lines = text.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** Escape a string for safe use inside a regular expression. */
export function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Heuristic binary-content check. Reads only the head of the buffer: a NUL byte
 * in the first 8KB is the standard signal git itself uses.
 */
export function looksBinary(buf: Buffer): boolean {
  const limit = Math.min(buf.length, 8192);
  for (let i = 0; i < limit; i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}
