/**
 * Diagnostic parsing.
 *
 * A failing `npm test` can emit four thousand lines describing eleven distinct
 * problems. Handing that to a model costs a fortune and buries the signal. This
 * module extracts the problems: file, line, severity, code, message — deduped,
 * ranked, and typically under thirty lines.
 *
 * Every parser is tolerant: unrecognised output degrades to a generic scan
 * rather than returning nothing, because "I found no errors" is a dangerous
 * answer when the command clearly failed.
 */

export type Severity = 'error' | 'warning' | 'info';

export interface Diagnostic {
  severity: Severity;
  /** Workspace-relative path when we could determine one. */
  file?: string;
  line?: number;
  column?: number;
  /** Tool-specific code, e.g. `TS2345`, `E0308`, `no-unused-vars`. */
  code?: string;
  message: string;
  /** Which parser produced this, for debugging output shape surprises. */
  source: string;
}

/** Parse a command's combined stdout/stderr into diagnostics. */
export function parseDiagnostics(output: string): Diagnostic[] {
  const lines = output.split('\n');

  const found: Diagnostic[] = [
    ...scanTypeScript(lines),
    ...scanEslint(lines),
    ...scanCargo(lines),
    ...scanPythonTracebacks(lines),
    ...scanPytest(lines),
    ...scanJest(lines),
    ...scanGo(lines),
    ...scanMaven(lines),
    ...scanGeneric(lines),
  ];

  return rank(dedupe(found));
}

// ---------------------------------------------------------------------------
// Individual parsers
// ---------------------------------------------------------------------------

/** `src/a.ts(12,5): error TS2345: msg` and `src/a.ts:12:5 - error TS2345: msg` */
function scanTypeScript(lines: readonly string[]): Diagnostic[] {
  const parens = /^(?<file>[^\s(][^(]*?)\((?<line>\d+),(?<col>\d+)\):\s*(?<sev>error|warning)\s+(?<code>TS\d+):\s*(?<msg>.+)$/;
  const colons = /^(?<file>[^\s:][^:]*?):(?<line>\d+):(?<col>\d+)\s*-\s*(?<sev>error|warning)\s+(?<code>TS\d+):\s*(?<msg>.+)$/;

  const out: Diagnostic[] = [];
  for (const raw of lines) {
    const m = parens.exec(raw.trim()) ?? colons.exec(raw.trim());
    if (!m) continue;
    const g = m.groups!;
    out.push({
      severity: g['sev'] === 'warning' ? 'warning' : 'error',
      file: g['file']!,
      line: Number(g['line']),
      column: Number(g['col']),
      code: g['code']!,
      message: g['msg']!.trim(),
      source: 'tsc',
    });
  }
  return out;
}

/**
 * ESLint's stylish reporter puts the file on its own line, then indents each
 * problem beneath it — so this parser has to remember which file it is in.
 */
function scanEslint(lines: readonly string[]): Diagnostic[] {
  const fileLine = /^(?<file>(?:\/|\.{0,2}\/|[A-Za-z]:\\)?[\w./\\@-]+\.[a-z]{1,4})$/;
  const problem = /^\s+(?<line>\d+):(?<col>\d+)\s+(?<sev>error|warning)\s+(?<msg>.+?)(?:\s\s+(?<rule>[\w@/-]+))?$/;

  const out: Diagnostic[] = [];
  let current: string | undefined;

  for (const raw of lines) {
    const file = fileLine.exec(raw.trimEnd());
    if (file) {
      current = file.groups!['file'];
      continue;
    }
    const m = problem.exec(raw.trimEnd());
    if (!m || !current) continue;
    const g = m.groups!;
    const diagnostic: Diagnostic = {
      severity: g['sev'] === 'warning' ? 'warning' : 'error',
      file: current,
      line: Number(g['line']),
      column: Number(g['col']),
      message: g['msg']!.trim(),
      source: 'eslint',
    };
    if (g['rule']) diagnostic.code = g['rule'];
    out.push(diagnostic);
  }
  return out;
}

/** Rust puts the message first and the location on the following `-->` line. */
function scanCargo(lines: readonly string[]): Diagnostic[] {
  const head = /^(?<sev>error|warning)(?:\[(?<code>E\d+)\])?:\s*(?<msg>.+)$/;
  const location = /^\s*-->\s*(?<file>[^\s:]+):(?<line>\d+):(?<col>\d+)/;

  const out: Diagnostic[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = head.exec(lines[i]!.trim());
    if (!m) continue;
    const g = m.groups!;
    const diagnostic: Diagnostic = {
      severity: g['sev'] === 'warning' ? 'warning' : 'error',
      message: g['msg']!.trim(),
      source: 'cargo',
    };
    if (g['code']) diagnostic.code = g['code'];

    // The location follows within a couple of lines, if it is given at all.
    for (let j = i + 1; j < Math.min(i + 4, lines.length); j++) {
      const loc = location.exec(lines[j]!);
      if (!loc) continue;
      diagnostic.file = loc.groups!['file']!;
      diagnostic.line = Number(loc.groups!['line']);
      diagnostic.column = Number(loc.groups!['col']);
      break;
    }
    out.push(diagnostic);
  }
  return out;
}

/**
 * Python tracebacks: report the *deepest frame inside the project* plus the
 * exception, since the top frame is usually library code the agent cannot fix.
 */
function scanPythonTracebacks(lines: readonly string[]): Diagnostic[] {
  const frame = /^\s*File\s+"(?<file>[^"]+)",\s+line\s+(?<line>\d+)(?:,\s+in\s+(?<fn>.+))?/;
  const exception = /^(?<type>[A-Z][\w.]*(?:Error|Exception|Warning|Exit)):\s*(?<msg>.*)$/;

  const out: Diagnostic[] = [];
  let lastFrame: { file: string; line: number; fn?: string } | undefined;
  let inTraceback = false;

  for (const raw of lines) {
    if (/^\s*Traceback \(most recent call last\)/.test(raw)) {
      inTraceback = true;
      lastFrame = undefined;
      continue;
    }

    const f = frame.exec(raw);
    if (f) {
      const file = f.groups!['file']!;
      // Prefer project frames over site-packages, which we cannot act on.
      if (!/site-packages|dist-packages|[/\\]lib[/\\]python/.test(file)) {
        lastFrame = { file, line: Number(f.groups!['line']) };
        const fn = f.groups!['fn'];
        if (fn) lastFrame.fn = fn.trim();
      }
      continue;
    }

    const e = exception.exec(raw.trim());
    if (!e || !inTraceback) continue;
    const diagnostic: Diagnostic = {
      severity: 'error',
      code: e.groups!['type']!,
      message: e.groups!['msg']!.trim() || e.groups!['type']!,
      source: 'python',
    };
    if (lastFrame) {
      diagnostic.file = lastFrame.file;
      diagnostic.line = lastFrame.line;
      if (lastFrame.fn) diagnostic.message += ` (in ${lastFrame.fn})`;
    }
    out.push(diagnostic);
    inTraceback = false;
    lastFrame = undefined;
  }
  return out;
}

/** `FAILED tests/test_x.py::test_name - AssertionError: msg` */
function scanPytest(lines: readonly string[]): Diagnostic[] {
  const failed = /^FAILED\s+(?<file>[^\s:]+)(?<rest>::[^\s]+)?(?:\s+-\s+(?<msg>.+))?$/;
  const errorAt = /^(?<file>[^\s:]+\.py):(?<line>\d+):\s+(?<msg>[A-Z]\w*(?:Error|Exception).*)$/;

  const out: Diagnostic[] = [];
  for (const raw of lines) {
    const trimmed = raw.trim();

    const f = failed.exec(trimmed);
    if (f) {
      const g = f.groups!;
      out.push({
        severity: 'error',
        file: g['file']!,
        code: (g['rest'] ?? '').replace(/^::/, '') || undefined,
        message: g['msg']?.trim() ?? 'test failed',
        source: 'pytest',
      });
      continue;
    }

    const e = errorAt.exec(trimmed);
    if (e) {
      out.push({
        severity: 'error',
        file: e.groups!['file']!,
        line: Number(e.groups!['line']),
        message: e.groups!['msg']!.trim(),
        source: 'pytest',
      });
    }
  }
  return out;
}

/**
 * Jest and Vitest report a failure title, then a stack. Pair each title with
 * the first project frame beneath it.
 */
function scanJest(lines: readonly string[]): Diagnostic[] {
  const title = /^\s*(?:●|×|✕|✗|FAIL)\s+(?<name>.+?)\s*$/;
  const frame = /^\s*(?:at\s+.*?\()?(?<file>[^\s()]+\.[jt]sx?):(?<line>\d+):(?<col>\d+)\)?/;

  const out: Diagnostic[] = [];
  for (let i = 0; i < lines.length; i++) {
    const t = title.exec(lines[i]!);
    if (!t) continue;
    const name = t.groups!['name']!.trim();
    if (name === '' || /^Console$/i.test(name)) continue;

    const diagnostic: Diagnostic = { severity: 'error', message: name, source: 'jest' };
    for (let j = i + 1; j < Math.min(i + 25, lines.length); j++) {
      const f = frame.exec(lines[j]!);
      if (!f) continue;
      const file = f.groups!['file']!;
      if (/node_modules/.test(file)) continue;
      diagnostic.file = file;
      diagnostic.line = Number(f.groups!['line']);
      diagnostic.column = Number(f.groups!['col']);
      break;
    }
    out.push(diagnostic);
  }
  return out;
}

/** `./pkg/a.go:12:5: message` and `--- FAIL: TestThing` */
function scanGo(lines: readonly string[]): Diagnostic[] {
  const compile = /^(?<file>[^\s:]+\.go):(?<line>\d+)(?::(?<col>\d+))?:\s*(?<msg>.+)$/;
  const testFail = /^\s*---\s+FAIL:\s+(?<name>\S+)/;

  const out: Diagnostic[] = [];
  for (const raw of lines) {
    const trimmed = raw.trim();

    const c = compile.exec(trimmed);
    if (c) {
      const g = c.groups!;
      const diagnostic: Diagnostic = {
        severity: 'error',
        file: g['file']!.replace(/^\.\//, ''),
        line: Number(g['line']),
        message: g['msg']!.trim(),
        source: 'go',
      };
      if (g['col']) diagnostic.column = Number(g['col']);
      out.push(diagnostic);
      continue;
    }

    const t = testFail.exec(raw);
    if (t) {
      out.push({ severity: 'error', code: t.groups!['name']!, message: `test failed: ${t.groups!['name']}`, source: 'go' });
    }
  }
  return out;
}

/** `[ERROR] /src/Main.java:[12,5] message` */
function scanMaven(lines: readonly string[]): Diagnostic[] {
  const re = /^\[(?<sev>ERROR|WARNING)\]\s+(?<file>[^\s:]+\.(?:java|kt)):\[(?<line>\d+),(?<col>\d+)\]\s*(?<msg>.+)$/;
  const out: Diagnostic[] = [];
  for (const raw of lines) {
    const m = re.exec(raw.trim());
    if (!m) continue;
    const g = m.groups!;
    out.push({
      severity: g['sev'] === 'WARNING' ? 'warning' : 'error',
      file: g['file']!,
      line: Number(g['line']),
      column: Number(g['col']),
      message: g['msg']!.trim(),
      source: 'maven',
    });
  }
  return out;
}

/**
 * Last resort: `path:line:col: severity: message` covers gcc, clang, ruff,
 * flake8, shellcheck, and most linters written since. Also picks up bare
 * `Error: …` lines so a failed run never reports zero problems.
 */
function scanGeneric(lines: readonly string[]): Diagnostic[] {
  const located = /^(?<file>[^\s:][^:]*?):(?<line>\d+)(?::(?<col>\d+))?:\s*(?:(?<sev>error|warning|note)(?:\[(?<code>[^\]]+)\])?:\s*)?(?<msg>.+)$/i;
  const bare = /^(?:\S+\s)?(?<sev>Error|FATAL|Exception)\s*:\s*(?<msg>.+)$/;

  const out: Diagnostic[] = [];
  for (const raw of lines) {
    const trimmed = raw.trim();
    if (trimmed === '') continue;

    const m = located.exec(trimmed);
    if (m) {
      const g = m.groups!;
      // Without an explicit severity word this is probably just a log line
      // mentioning a colon-delimited number; require one to avoid noise.
      if (!g['sev']) continue;
      const diagnostic: Diagnostic = {
        severity: normalizeSeverity(g['sev']),
        file: g['file']!,
        line: Number(g['line']),
        message: g['msg']!.trim(),
        source: 'generic',
      };
      if (g['col']) diagnostic.column = Number(g['col']);
      if (g['code']) diagnostic.code = g['code'];
      out.push(diagnostic);
      continue;
    }

    const b = bare.exec(trimmed);
    if (b) {
      out.push({ severity: 'error', message: b.groups!['msg']!.trim(), source: 'generic' });
    }
  }
  return out;
}

function normalizeSeverity(word: string | undefined): Severity {
  const lower = (word ?? '').toLowerCase();
  if (lower === 'warning') return 'warning';
  if (lower === 'note') return 'info';
  return 'error';
}

// ---------------------------------------------------------------------------
// Merge
// ---------------------------------------------------------------------------

/**
 * Collapse duplicates. Parsers overlap by design — the generic scan sees much
 * of what the specific ones do — so a specific parser's richer result wins.
 */
function dedupe(found: readonly Diagnostic[]): Diagnostic[] {
  const byKey = new Map<string, Diagnostic>();
  for (const diagnostic of found) {
    const key = `${diagnostic.file ?? ''}:${diagnostic.line ?? 0}:${normalizeMessage(diagnostic.message)}`;
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, diagnostic);
      continue;
    }
    if (existing.source === 'generic' && diagnostic.source !== 'generic') byKey.set(key, diagnostic);
    else if (!existing.file && diagnostic.file) byKey.set(key, diagnostic);
  }
  return [...byKey.values()];
}

function normalizeMessage(message: string): string {
  return message.toLowerCase().replace(/\s+/g, ' ').slice(0, 120);
}

/** Errors before warnings, located before unlocated — the fixable ones first. */
function rank(found: Diagnostic[]): Diagnostic[] {
  const weight = { error: 0, warning: 1, info: 2 } as const;
  return found.sort((a, b) => {
    const bySeverity = weight[a.severity] - weight[b.severity];
    if (bySeverity !== 0) return bySeverity;
    const byLocated = Number(b.file !== undefined) - Number(a.file !== undefined);
    if (byLocated !== 0) return byLocated;
    return 0;
  });
}
