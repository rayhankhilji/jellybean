/**
 * `jellybean --doctor` — check a setup before blaming the server for it.
 *
 * Almost every "Jelly Bean isn't working" is one of a small number of things,
 * and none of them are visible from inside an agent conversation: the root is
 * pointing somewhere unexpected, the repository is bigger than the file cap, the
 * platform cannot watch the filesystem so every call re-walks the tree, the
 * cache directory is not writable, or `jb_diagnose` is refusing a command that
 * was never declared to it.
 *
 * So this reports what the server would actually see, and says which findings
 * matter. It exits non-zero only for problems that stop the server working —
 * a degraded setup is worth knowing about but is not a failure.
 */

import { access, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, join, parse } from 'node:path';
import { homedir } from 'node:os';
import type { JellyBeanConfig } from './config.js';
import { CodeIndex } from './core/code-index.js';
import { ParseCache } from './core/cache.js';
import { NotesStore } from './core/notes.js';
import { Workspace } from './core/workspace.js';
import { discoverChecks } from './diagnostics/runner.js';
import { plural } from './core/render.js';
import { SERVER_VERSION } from './version.js';

type Level = 'ok' | 'warn' | 'fail';

interface Finding {
  level: Level;
  label: string;
  detail: string;
  /** What to do about it. Omitted when there is nothing to do. */
  fix?: string;
}

const MARK: Record<Level, string> = { ok: '  ok  ', warn: 'warn  ', fail: 'FAIL  ' };

/** Node versions before this cannot watch a directory tree recursively on Linux. */
const RECURSIVE_WATCH_NODE_MAJOR = 20;

export async function runDoctor(config: JellyBeanConfig, out: NodeJS.WritableStream): Promise<number> {
  const findings: Finding[] = [];
  const write = (line: string): void => void out.write(`${line}\n`);

  write(`jellybean ${SERVER_VERSION} — checking ${config.root}`);
  write('');

  findings.push(checkNode());

  const rootFinding = await checkRoot(config.root);
  findings.push(rootFinding);

  // Everything below reads the workspace, which is meaningless if the root is
  // wrong. Report what we have rather than a cascade of consequences.
  if (rootFinding.level === 'fail') {
    return report(findings, write);
  }

  const workspace = new Workspace(config.root, config.ignore);
  const index = new CodeIndex(workspace, config);

  const started = Date.now();
  await index.ensureFresh(true);
  const elapsed = Date.now() - started;

  findings.push(checkIndex(index, config, elapsed));
  findings.push(checkWatching(index));
  findings.push(await checkGit(config.root));
  findings.push(await checkCache(config.root));
  findings.push(await checkNotes(config));
  findings.push(...(await checkDiagnostics(workspace, config)));

  await index.close();
  return report(findings, write);
}

function report(findings: readonly Finding[], write: (line: string) => void): number {
  const width = Math.max(...findings.map((f) => f.label.length));
  for (const finding of findings) {
    write(`  ${MARK[finding.level]}${finding.label.padEnd(width)}  ${finding.detail}`);
    if (finding.fix) write(`        ${' '.repeat(width)}  → ${finding.fix}`);
  }

  const failures = findings.filter((f) => f.level === 'fail').length;
  const warnings = findings.filter((f) => f.level === 'warn').length;
  write('');
  if (failures > 0) write(`${failures} problem${failures === 1 ? '' : 's'} will stop the server working.`);
  else if (warnings > 0) write(`No blocking problems. ${warnings} thing${warnings === 1 ? '' : 's'} worth knowing about.`);
  else write('Everything checks out.');

  return failures > 0 ? 1 : 0;
}

function checkNode(): Finding {
  const major = Number.parseInt(process.versions.node.split('.')[0] ?? '0', 10);
  if (major < 18) {
    return {
      level: 'fail',
      label: 'node',
      detail: `${process.version} — too old`,
      fix: 'Jelly Bean needs Node 18.17 or newer.',
    };
  }
  if (major < RECURSIVE_WATCH_NODE_MAJOR && process.platform === 'linux') {
    return {
      level: 'warn',
      label: 'node',
      detail: `${process.version} — recursive file watching needs Node ${RECURSIVE_WATCH_NODE_MAJOR} on Linux`,
      fix: 'Upgrade Node, or accept periodic rescans instead of instant ones.',
    };
  }
  return { level: 'ok', label: 'node', detail: `${process.version} on ${process.platform}` };
}

async function checkRoot(root: string): Promise<Finding> {
  try {
    const info = await stat(root);
    if (!info.isDirectory()) {
      return { level: 'fail', label: 'workspace', detail: `${root} is not a directory` };
    }
  } catch {
    return {
      level: 'fail',
      label: 'workspace',
      detail: `${root} does not exist`,
      fix: 'Pass the repository path: jellybean /path/to/repo',
    };
  }

  try {
    await access(root, constants.R_OK);
  } catch {
    return { level: 'fail', label: 'workspace', detail: `${root} is not readable` };
  }

  // The classic misconfiguration: the client launched the server with no path,
  // so the root defaulted to wherever the process happened to start. Every
  // answer is then about the wrong code, confidently.
  if (root === homedir() || root === parse(root).root) {
    return {
      level: 'warn',
      label: 'workspace',
      detail: `${root} — that is your ${root === homedir() ? 'home directory' : 'filesystem root'}, almost certainly not what you meant`,
      fix: 'Give the repository path: jellybean /path/to/repo, or set "args" in your MCP client config.',
    };
  }

  return { level: 'ok', label: 'workspace', detail: root };
}

function checkIndex(index: CodeIndex, config: JellyBeanConfig, elapsedMs: number): Finding {
  const files = index.fileCount;
  const detail = `${plural(files, 'file')} indexed in ${elapsedMs} ms`;

  if (files === 0) {
    return {
      level: 'fail',
      label: 'index',
      detail: 'no files were indexed',
      fix: 'Everything here is ignored, binary, or empty. Check .gitignore and --ignore.',
    };
  }
  // Hitting the cap is silent truncation: the server answers confidently about
  // whichever part of the repository it happened to reach first.
  if (files >= config.maxFiles) {
    return {
      level: 'warn',
      label: 'index',
      detail: `${detail} — the ${config.maxFiles}-file cap was reached, so part of the repository is invisible`,
      fix: 'Raise it with --max-files, or point the root at a subdirectory.',
    };
  }
  return { level: 'ok', label: 'index', detail };
}

function checkWatching(index: CodeIndex): Finding {
  const watching = index.startWatching();
  if (watching) return { level: 'ok', label: 'file watching', detail: 'active — the index updates as you edit' };
  return {
    level: 'warn',
    label: 'file watching',
    detail: 'unavailable on this platform or filesystem',
    fix: 'Tools stay correct but fall back to periodic rescans, which are slower on a large repository.',
  };
}

async function checkGit(root: string): Promise<Finding> {
  try {
    const info = await stat(join(root, '.git'));
    if (info.isDirectory() || info.isFile()) {
      return { level: 'ok', label: 'git', detail: 'repository found — jb_changes will work' };
    }
  } catch {
    // Not a repository.
  }
  return {
    level: 'warn',
    label: 'git',
    detail: 'not a git repository',
    fix: 'Everything works except jb_changes, which has no diff to read.',
  };
}

/**
 * Whether a file could be created at this path.
 *
 * Deliberately does not create the directory to find out. A diagnostic that
 * leaves things behind is not a diagnostic — running `--doctor` should be
 * indistinguishable from not having run it.
 */
async function couldWrite(path: string): Promise<boolean> {
  let dir = dirname(path);
  for (let depth = 0; depth < 32; depth++) {
    try {
      await access(dir, constants.W_OK);
      return true;
    } catch {
      const parent = dirname(dir);
      // Either the directory does not exist yet — in which case the question is
      // really about its parent — or it exists and is not writable, which the
      // parent check will not rescue. Both resolve by walking up until we find
      // something that exists.
      try {
        await stat(dir);
        return false; // exists, but not writable
      } catch {
        if (parent === dir) return false;
        dir = parent;
      }
    }
  }
  return false;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

async function checkCache(root: string): Promise<Finding> {
  const cache = ParseCache.forWorkspace(root);
  if (!(await couldWrite(cache.path))) {
    return {
      level: 'warn',
      label: 'parse cache',
      detail: `${cache.path} is not writable`,
      fix: 'Every restart will re-parse the repository. Set XDG_CACHE_HOME somewhere writable.',
    };
  }

  try {
    const info = await stat(cache.path);
    return { level: 'ok', label: 'parse cache', detail: `${formatBytes(info.size)} at ${cache.path}` };
  } catch {
    return { level: 'ok', label: 'parse cache', detail: `will be written to ${cache.path}` };
  }
}

async function checkNotes(config: JellyBeanConfig): Promise<Finding> {
  const store = NotesStore.forWorkspace(config.root, config.notesPath);
  if (await couldWrite(store.path)) return { level: 'ok', label: 'notes', detail: store.path };
  return {
    level: 'warn',
    label: 'notes',
    detail: `${store.path} is not writable`,
    fix: 'jb_notes will fail to save. Everything else is unaffected.',
  };
}

async function checkDiagnostics(workspace: Workspace, config: JellyBeanConfig): Promise<Finding[]> {
  const checks = await discoverChecks(workspace);
  const findings: Finding[] = [];

  if (checks.length === 0) {
    findings.push({
      level: 'warn',
      label: 'jb_diagnose',
      detail: 'this project declares no checks',
      fix: 'Add npm scripts or a Makefile, or permit specific commands with --allow-command.',
    });
  } else {
    findings.push({
      level: 'ok',
      label: 'jb_diagnose',
      detail: `${plural(checks.length, 'check')}: ${checks.map((c) => c.name).join(', ')}`,
    });
  }

  // Worth stating plainly rather than leaving someone to discover it from a
  // refusal: by default nothing but the project's own declared checks can run.
  if (config.allowArbitraryCommands) {
    findings.push({
      level: 'warn',
      label: 'command policy',
      detail: '--unsafe-commands is on — jb_diagnose will run any command it is given',
      fix: 'Prefer --allow-command for the specific commands you want.',
    });
  } else if (config.allowedCommands.length > 0) {
    findings.push({
      level: 'ok',
      label: 'command policy',
      detail: `declared checks, plus: ${config.allowedCommands.join(', ')}`,
    });
  } else {
    findings.push({ level: 'ok', label: 'command policy', detail: 'declared checks only' });
  }

  return findings;
}
