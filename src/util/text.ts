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
/**
 * Below this length V8 copies a substring outright; at or above it, it does not.
 * The exact threshold is an implementation detail, so this is only ever used to
 * skip work that would be pointless, never to decide correctness.
 */
const MIN_SLICED_LENGTH = 13;

/**
 * A copy of `text` that does not retain whatever it was cut out of.
 *
 * V8 represents a substring as a pointer into its parent rather than a copy, so
 * a thirty-character import specifier extracted from a forty-kilobyte source
 * file keeps that entire file alive for as long as the specifier is held. The
 * index holds hundreds of thousands of such fragments, which is how a repository
 * whose text is 400MB ends up costing 900MB of heap to describe.
 *
 * The round trip through UTF-16 bytes is the cheapest exact copy available:
 * cheaper than JSON, and unlike UTF-8 it survives an unpaired surrogate — which
 * can appear in source and must not be silently rewritten.
 */
export function detachString(text: string): string {
  if (text.length < MIN_SLICED_LENGTH) return text;
  return Buffer.from(text, 'utf16le').toString('utf16le');
}

export function tokenizeCode(text: string): string[] {
  const out: string[] = [];
  countCodeTerms(text, (term) => {
    out.push(term);
  });
  return out;
}

/**
 * Stream the search terms of `text` to a callback.
 *
 * The array-returning form above is convenient but allocates one string per
 * identifier *per sub-word* — on a large repository that is tens of millions of
 * short-lived strings, and it dominated indexing time. Indexing uses this
 * instead and increments a frequency map directly.
 *
 * Character scanning rather than `String.match` for the same reason: `match`
 * with a global regex materialises every identifier in the file at once.
 */
export function countCodeTerms(text: string, emit: (term: string) => void): void {
  const length = text.length;
  let start = -1;

  for (let i = 0; i <= length; i++) {
    const code = i < length ? text.charCodeAt(i) : 0;
    const isWord =
      (code >= 97 && code <= 122) || // a-z
      (code >= 65 && code <= 90) || // A-Z
      (code >= 48 && code <= 57) || // 0-9
      code === 95 || // _
      code === 36; // $

    if (isWord) {
      if (start === -1) start = i;
      continue;
    }
    if (start === -1) continue;

    // An identifier cannot begin with a digit; if it does, this is a numeric
    // literal and not worth indexing.
    const first = text.charCodeAt(start);
    const numeric = first >= 48 && first <= 57;
    const size = i - start;

    // Skip minified blobs and base64 payloads — never useful as search terms.
    if (!numeric && size <= 64) {
      const identifier = text.slice(start, i);
      emit(identifier.toLowerCase());
      emitSubWords(identifier, emit);
    }
    start = -1;
  }
}

/**
 * Emit the sub-words of an identifier, splitting on case changes and
 * separators, without the two regex replacements the readable version uses.
 */
function emitSubWords(identifier: string, emit: (term: string) => void): void {
  const length = identifier.length;

  // -1 means "not currently inside a sub-word", which is the state after a
  // separator. Tracking it explicitly is what keeps `__dunder__` from emitting
  // the underscores as parts of their own.
  let start = -1;

  const flush = (end: number): void => {
    if (start === -1 || end <= start) return;
    // A part spanning the whole identifier is the identifier, already emitted.
    if (start === 0 && end === length) return;
    emit(identifier.slice(start, end).toLowerCase());
  };

  for (let i = 0; i < length; i++) {
    const current = identifier.charCodeAt(i);

    if (current === 95 || current === 36) {
      // `_` or `$`
      flush(i);
      start = -1;
      continue;
    }
    if (start === -1) {
      start = i;
      continue;
    }

    const previous = identifier.charCodeAt(i - 1);
    const lowerToUpper = previous >= 97 && previous <= 122 && current >= 65 && current <= 90;
    const digitToUpper = previous >= 48 && previous <= 57 && current >= 65 && current <= 90;
    if (lowerToUpper || digitToUpper) {
      flush(i);
      start = i;
      continue;
    }

    // `HTTPResponse` splits before the `R`, not after the `P`.
    if (previous >= 65 && previous <= 90 && current >= 97 && current <= 122 && i - 1 > start) {
      flush(i - 1);
      start = i - 1;
    }
  }
  flush(length);
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
