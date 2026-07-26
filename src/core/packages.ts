/**
 * Package boundaries.
 *
 * A monorepo is not a flat tree of files, and treating it as one loses the most
 * architecturally interesting fact available: which dependencies cross a package
 * boundary. Inside a package, one file importing another is unremarkable. Across
 * packages it is a coupling decision someone made, and the thing a reviewer
 * actually wants flagged.
 *
 * Detection is by manifest — `package.json`, `Cargo.toml`, `go.mod`,
 * `pyproject.toml` — because that is what every ecosystem's own tooling uses.
 */

import type { Workspace } from './workspace.js';

export interface PackageInfo {
  /** Declared name, or the directory name when the manifest has none. */
  name: string;
  /** Directory relative to the root. Empty string for a root-level package. */
  dir: string;
}

/** Manifests that mark a directory as a package root. */
const MANIFESTS = ['package.json', 'Cargo.toml', 'go.mod', 'pyproject.toml'];

/** Directories that conventionally hold packages in a monorepo. */
const WORKSPACE_DIRS = ['packages', 'apps', 'services', 'libs', 'modules', 'crates', 'plugins'];

export class PackageMap {
  private packages: PackageInfo[] = [];
  /** Longest-first, so the most specific package wins a prefix match. */
  private sorted: PackageInfo[] = [];

  /**
   * Discover packages from a set of indexed paths.
   *
   * Takes the already-walked path list rather than walking again — the index has
   * one, and a second traversal of a large monorepo is not free.
   */
  async discover(workspace: Workspace, paths: readonly string[]): Promise<void> {
    const manifestDirs = new Set<string>();

    for (const path of paths) {
      const slash = path.lastIndexOf('/');
      const dir = slash === -1 ? '' : path.slice(0, slash);
      const name = path.slice(slash + 1);
      if (!MANIFESTS.includes(name)) continue;

      // A manifest at the root describes the repository, not a sub-package;
      // include it only so root-level files are still attributed somewhere.
      manifestDirs.add(dir);
    }

    // A workspace directory that contains manifests is the strongest signal that
    // this is a monorepo. Without one, a single root manifest means it is not.
    const isMonorepo = [...manifestDirs].some(
      (dir) => dir !== '' && WORKSPACE_DIRS.some((w) => dir === w || dir.startsWith(`${w}/`) || dir.includes(`/${w}/`)),
    );
    if (!isMonorepo) {
      this.packages = [];
      this.sorted = [];
      return;
    }

    const found: PackageInfo[] = [];
    for (const dir of manifestDirs) {
      const name = (await readName(workspace, dir)) ?? (dir === '' ? '(root)' : dir.slice(dir.lastIndexOf('/') + 1));
      found.push({ name, dir });
    }

    this.packages = found.sort((a, b) => a.dir.localeCompare(b.dir));
    this.sorted = [...found].sort((a, b) => b.dir.length - a.dir.length);
  }

  /** Whether this workspace looks like a monorepo at all. */
  get isMonorepo(): boolean {
    return this.packages.length > 1;
  }

  get count(): number {
    return this.packages.length;
  }

  all(): readonly PackageInfo[] {
    return this.packages;
  }

  /**
   * The package owning a path. Undefined outside any package, and outside a
   * monorepo — where the concept adds nothing.
   */
  owner(path: string): PackageInfo | undefined {
    if (!this.isMonorepo) return undefined;
    for (const info of this.sorted) {
      if (info.dir === '') continue;
      if (path === info.dir || path.startsWith(`${info.dir}/`)) return info;
    }
    // Fall back to a root-level package, if one was declared.
    return this.sorted.find((info) => info.dir === '');
  }

  /** Whether two paths sit in different packages — the interesting case. */
  crossesBoundary(from: string, to: string): boolean {
    const a = this.owner(from);
    const b = this.owner(to);
    if (!a || !b) return false;
    return a.dir !== b.dir;
  }
}

async function readName(workspace: Workspace, dir: string): Promise<string | null> {
  const at = (file: string): string => (dir === '' ? file : `${dir}/${file}`);

  const json = await workspace.readText(at('package.json'), 512 * 1024);
  if (json !== null) {
    try {
      const parsed = JSON.parse(json) as { name?: unknown };
      if (typeof parsed.name === 'string' && parsed.name !== '') return parsed.name;
    } catch {
      // Malformed manifest; fall through to the directory name.
    }
  }

  const cargo = await workspace.readText(at('Cargo.toml'), 512 * 1024);
  const cargoName = cargo && /^\s*name\s*=\s*"([^"]+)"/m.exec(cargo)?.[1];
  if (cargoName) return cargoName;

  const goMod = await workspace.readText(at('go.mod'), 512 * 1024);
  const goName = goMod && /^\s*module\s+(\S+)/m.exec(goMod)?.[1];
  if (goName) return goName;

  const pyproject = await workspace.readText(at('pyproject.toml'), 512 * 1024);
  const pyName = pyproject && /^\s*name\s*=\s*"([^"]+)"/m.exec(pyproject)?.[1];
  return pyName ?? null;
}
