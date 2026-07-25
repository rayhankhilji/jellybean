/**
 * Check discovery and execution.
 *
 * `jb_diagnose` is the one tool that runs code, so its security posture is
 * explicit: **it never invokes a shell.** Commands are spawned with an argv
 * array and `shell: false`, which means no globbing, no `$(…)`, no `;` chaining
 * — a malicious string in a package.json script name cannot become a command.
 *
 * By default the only runnable things are checks discovered from the project's
 * own manifests (npm scripts, Make targets, cargo, go, pytest). An operator who
 * wants more must opt in with `--allow-command` or `--unsafe-commands`.
 */

import { spawn } from 'node:child_process';
import type { Workspace } from '../core/workspace.js';

export interface Check {
  /** Short name the agent refers to, e.g. `test` or `make:lint`. */
  name: string;
  /** Executable plus arguments. Never a shell string. */
  argv: string[];
  /** Where the check came from, for display. */
  origin: string;
}

export interface RunResult {
  argv: string[];
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  /** Combined stdout and stderr, capped. */
  output: string;
  durationMs: number;
  timedOut: boolean;
  truncated: boolean;
}

/** Cap captured output; anything past this is noise for our purposes. */
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;

/** npm scripts worth surfacing, in the order an agent usually wants them. */
const INTERESTING_SCRIPTS = ['typecheck', 'test', 'lint', 'build', 'check', 'tsc', 'vitest', 'jest'];

/** Discover the checks this project declares. */
export async function discoverChecks(workspace: Workspace): Promise<Check[]> {
  const checks: Check[] = [];

  await addNpmScripts(workspace, checks);
  await addMakeTargets(workspace, checks);
  await addLanguageDefaults(workspace, checks);

  // Stable, useful ordering: the checks an agent reaches for first come first.
  const priority = (check: Check): number => {
    const at = INTERESTING_SCRIPTS.indexOf(check.name.replace(/^.*:/, ''));
    return at === -1 ? INTERESTING_SCRIPTS.length : at;
  };
  return checks.sort((a, b) => priority(a) - priority(b) || a.name.localeCompare(b.name));
}

async function addNpmScripts(workspace: Workspace, out: Check[]): Promise<void> {
  const raw = await workspace.readText('package.json', 1024 * 1024);
  if (raw === null) return;

  let scripts: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(raw) as { scripts?: Record<string, unknown> };
    scripts = parsed.scripts ?? {};
  } catch {
    return; // malformed package.json is the project's problem, not ours
  }

  for (const name of Object.keys(scripts)) {
    // Script names are attacker-controllable in a hostile repo. They are only
    // ever passed as a single argv element, never interpolated into a shell.
    if (!/^[\w:.-]{1,64}$/.test(name)) continue;
    out.push({ name, argv: ['npm', 'run', '--silent', name], origin: 'package.json' });
  }
}

async function addMakeTargets(workspace: Workspace, out: Check[]): Promise<void> {
  const raw = await workspace.readText('Makefile', 512 * 1024);
  if (raw === null) return;

  const seen = new Set<string>();
  for (const line of raw.split('\n')) {
    const m = /^(?<name>[A-Za-z][\w.-]*)\s*:(?!=)/.exec(line);
    const name = m?.groups?.['name'];
    if (!name || seen.has(name) || name === 'PHONY') continue;
    seen.add(name);
    out.push({ name: `make:${name}`, argv: ['make', name], origin: 'Makefile' });
  }
}

async function addLanguageDefaults(workspace: Workspace, out: Check[]): Promise<void> {
  const candidates: Array<[string, string, string[]]> = [
    ['Cargo.toml', 'cargo:test', ['cargo', 'test']],
    ['Cargo.toml', 'cargo:check', ['cargo', 'check', '--message-format=short']],
    ['Cargo.toml', 'cargo:clippy', ['cargo', 'clippy']],
    ['go.mod', 'go:test', ['go', 'test', './...']],
    ['go.mod', 'go:build', ['go', 'build', './...']],
    ['go.mod', 'go:vet', ['go', 'vet', './...']],
    ['pyproject.toml', 'py:test', ['python3', '-m', 'pytest', '-q']],
    ['pytest.ini', 'py:test', ['python3', '-m', 'pytest', '-q']],
    ['setup.cfg', 'py:test', ['python3', '-m', 'pytest', '-q']],
    ['tsconfig.json', 'ts:typecheck', ['npx', '--no-install', 'tsc', '--noEmit']],
  ];

  const names = new Set(out.map((c) => c.name));
  for (const [marker, name, argv] of candidates) {
    if (names.has(name)) continue;
    if ((await workspace.kindOf(marker)) !== 'file') continue;
    names.add(name);
    out.push({ name, argv, origin: marker });
  }
}

/**
 * Split a command string into argv.
 *
 * Handles quoting, and nothing else — deliberately. There is no expansion of
 * `$VAR`, no globbing, no operators. A string containing `rm -rf / ; echo` runs
 * `rm` with the literal arguments `-rf`, `/`, `;`, `echo`, which fails, rather
 * than becoming two commands.
 */
export function splitCommand(command: string): string[] {
  const argv: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let has = false;

  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!;
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      has = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (has || current !== '') argv.push(current);
      current = '';
      has = false;
      continue;
    }
    current += ch;
  }
  if (has || current !== '') argv.push(current);
  return argv;
}

/** Run a command inside the workspace, capturing combined output. */
export function run(argv: readonly string[], cwd: string, timeoutMs: number): Promise<RunResult> {
  const started = Date.now();
  const [command, ...args] = argv;

  return new Promise<RunResult>((resolvePromise) => {
    if (!command) {
      resolvePromise({
        argv: [...argv],
        exitCode: null,
        signal: null,
        output: 'empty command',
        durationMs: 0,
        timedOut: false,
        truncated: false,
      });
      return;
    }

    const child = spawn(command, args, {
      cwd,
      shell: false,
      windowsHide: true,
      // CI=1 makes most test runners disable colour, spinners, and interactive
      // prompts — all of which are pure token waste in captured output.
      env: { ...process.env, CI: '1', NO_COLOR: '1', FORCE_COLOR: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const chunks: Buffer[] = [];
    let bytes = 0;
    let truncated = false;
    let timedOut = false;
    let settled = false;

    const collect = (chunk: Buffer): void => {
      if (bytes >= MAX_OUTPUT_BYTES) {
        truncated = true;
        return;
      }
      const room = MAX_OUTPUT_BYTES - bytes;
      const slice = chunk.length > room ? chunk.subarray(0, room) : chunk;
      chunks.push(slice);
      bytes += slice.length;
      if (slice.length < chunk.length) truncated = true;
    };

    child.stdout?.on('data', collect);
    child.stderr?.on('data', collect);

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    timer.unref?.();

    const settle = (exitCode: number | null, signal: NodeJS.Signals | null, extra = ''): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise({
        argv: [...argv],
        exitCode,
        signal,
        output: Buffer.concat(chunks).toString('utf8') + extra,
        durationMs: Date.now() - started,
        timedOut,
        truncated,
      });
    };

    child.on('error', (error) => {
      settle(null, null, `\nfailed to start ${command}: ${(error as Error).message}`);
    });
    child.on('close', (code, signal) => settle(code, signal));
  });
}

/** Load a project manifest field, used to name the repo in `jb_map`. */
export async function readProjectName(workspace: Workspace): Promise<string | null> {
  const raw = await workspace.readText('package.json', 512 * 1024);
  if (raw !== null) {
    try {
      const parsed = JSON.parse(raw) as { name?: unknown };
      if (typeof parsed.name === 'string' && parsed.name !== '') return parsed.name;
    } catch {
      // fall through
    }
  }
  const cargo = await workspace.readText('Cargo.toml', 512 * 1024);
  const cargoName = cargo && /^\s*name\s*=\s*"([^"]+)"/m.exec(cargo)?.[1];
  if (cargoName) return cargoName;

  const goMod = await workspace.readText('go.mod', 512 * 1024);
  const goName = goMod && /^\s*module\s+(\S+)/m.exec(goMod)?.[1];
  return goName ?? null;
}
