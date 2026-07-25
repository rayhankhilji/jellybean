/** Server configuration, assembled from CLI flags and environment variables. */

import { resolve } from 'node:path';

export interface JellyBeanConfig {
  /** Absolute path to the indexed workspace. */
  root: string;
  /** Files larger than this are indexed by name only. */
  maxFileBytes: number;
  /** Hard ceiling on indexed files, to keep memory bounded on huge monorepos. */
  maxFiles: number;
  /** Default token budget when a tool call omits one. */
  defaultTokenBudget: number;
  /** Upper bound a caller may request, so one call cannot eat a whole context. */
  maxTokenBudget: number;
  /** Extra ignore globs, on top of .gitignore and the built-in defaults. */
  ignore: string[];
  /**
   * Shell commands `jb_diagnose` may run beyond the checks it discovers itself.
   * Empty by default: the server runs project-declared scripts, not arbitrary
   * shell, unless the operator opts in.
   */
  allowedCommands: string[];
  /** Whether `jb_diagnose` accepts an arbitrary command string. Off by default. */
  allowArbitraryCommands: boolean;
  /** Milliseconds before a diagnose run is killed. */
  commandTimeoutMs: number;
  /** Where cross-session notes are persisted, relative to the root. */
  notesPath: string;
}

const DEFAULTS: Omit<JellyBeanConfig, 'root'> = {
  maxFileBytes: 512 * 1024,
  maxFiles: 20_000,
  defaultTokenBudget: 2_000,
  maxTokenBudget: 25_000,
  ignore: [],
  allowedCommands: [],
  allowArbitraryCommands: false,
  commandTimeoutMs: 120_000,
  notesPath: '.jellybean/notes.json',
};

export interface ParsedArgs {
  config: JellyBeanConfig;
  /** Set when the caller asked for `--help` or `--version`. */
  action?: 'help' | 'version';
}

/**
 * Parse `argv` (without the node/script prefix) into a config.
 *
 * Precedence: CLI flag > environment variable > default. The first positional
 * argument is treated as the workspace root, so `jellybean /path/to/repo` works
 * without any flags.
 */
export function parseArgs(argv: readonly string[], env: NodeJS.ProcessEnv = process.env): ParsedArgs {
  const config: JellyBeanConfig = {
    ...DEFAULTS,
    root: env['JELLYBEAN_ROOT'] ?? process.cwd(),
    maxFileBytes: intFrom(env['JELLYBEAN_MAX_FILE_BYTES'], DEFAULTS.maxFileBytes),
    maxFiles: intFrom(env['JELLYBEAN_MAX_FILES'], DEFAULTS.maxFiles),
    defaultTokenBudget: intFrom(env['JELLYBEAN_TOKEN_BUDGET'], DEFAULTS.defaultTokenBudget),
    ignore: splitList(env['JELLYBEAN_IGNORE']),
    allowedCommands: splitList(env['JELLYBEAN_ALLOW_COMMANDS']),
    allowArbitraryCommands: env['JELLYBEAN_UNSAFE_COMMANDS'] === '1',
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const next = (): string => {
      const value = argv[++i];
      if (value === undefined) throw new Error(`Missing value for ${arg}`);
      return value;
    };

    switch (arg) {
      case '--help':
      case '-h':
        return { config, action: 'help' };
      case '--version':
      case '-v':
        return { config, action: 'version' };
      case '--root':
      case '-r':
        config.root = next();
        break;
      case '--max-file-bytes':
        config.maxFileBytes = intFrom(next(), DEFAULTS.maxFileBytes);
        break;
      case '--max-files':
        config.maxFiles = intFrom(next(), DEFAULTS.maxFiles);
        break;
      case '--token-budget':
        config.defaultTokenBudget = intFrom(next(), DEFAULTS.defaultTokenBudget);
        break;
      case '--ignore':
        config.ignore.push(...splitList(next()));
        break;
      case '--allow-command':
        config.allowedCommands.push(next());
        break;
      case '--unsafe-commands':
        config.allowArbitraryCommands = true;
        break;
      case '--command-timeout':
        config.commandTimeoutMs = intFrom(next(), DEFAULTS.commandTimeoutMs) * 1000;
        break;
      default:
        if (arg.startsWith('-')) throw new Error(`Unknown option: ${arg}`);
        config.root = arg;
    }
  }

  config.root = resolve(config.root);
  config.defaultTokenBudget = Math.min(config.defaultTokenBudget, config.maxTokenBudget);
  return { config };
}

function intFrom(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function splitList(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}
