import fs from "node:fs/promises";
import path from "node:path";

async function exists(target: string): Promise<boolean> {
  try {
    await fs.lstat(target);
    return true;
  } catch {
    return false;
  }
}

/**
 * Split a filename into the stem and the extension that a Finder-style `(N)`
 * suffix must be inserted before. Leading dots are part of the stem, so
 * `.gitconfig` becomes `[".gitconfig", ""]` rather than `["", ".gitconfig"]`.
 */
export function splitExtension(name: string): [stem: string, extension: string] {
  const dotIndex = name.lastIndexOf(".");
  if (dotIndex <= 0) return [name, ""];
  return [name.slice(0, dotIndex), name.slice(dotIndex)];
}

/** `report.pdf` → `report (2).pdf`, preserving the extension so it still opens. */
export function withCopyIndex(name: string, index: number): string {
  const [stem, extension] = splitExtension(name);
  return `${stem} (${index})${extension}`;
}

/**
 * Pick the `keep both` destination for a conflicting file: the first
 * `name (N)` that is not taken, starting at `(2)`, Finder-style.
 */
export async function nextAvailableCopyName(dir: string, name: string): Promise<string> {
  for (let index = 2; ; index += 1) {
    const candidate = withCopyIndex(name, index);
    if (!(await exists(path.join(dir, candidate)))) return candidate;
  }
}

export interface BackupTarget {
  /** Absolute path the original should be renamed to. */
  path: string;
  /** True when an existing `.bak` directory will be merged into rather than replaced. */
  mergesIntoExisting: boolean;
  /** Suffixes already taken, for the explanatory second output line. */
  existingSuffixes: string[];
}

/**
 * Decide where `<Name>` gets backed up to.
 *
 * A *directory* colliding with an existing `<Name>.bak` merges into it — nesting
 * a second backup would bury the first. A *file* collision increments instead
 * (`.bak.1`, `.bak.2`), since files have no merge semantics.
 */
export async function resolveBackupTarget(
  target: string,
  isDirectory: boolean,
): Promise<BackupTarget> {
  const base = `${target}.bak`;
  const baseExists = await exists(base);

  if (!baseExists) {
    return { path: base, mergesIntoExisting: false, existingSuffixes: [] };
  }

  if (isDirectory) {
    const baseStats = await fs.lstat(base);
    if (baseStats.isDirectory() && !baseStats.isSymbolicLink()) {
      return { path: base, mergesIntoExisting: true, existingSuffixes: [".bak"] };
    }
  }

  const existingSuffixes = [".bak"];
  for (let index = 1; ; index += 1) {
    const candidate = `${base}.${index}`;
    if (!(await exists(candidate))) {
      return { path: candidate, mergesIntoExisting: false, existingSuffixes };
    }
    existingSuffixes.push(`.bak.${index}`);
  }
}

/**
 * List existing backups for a path, newest suffix last. Used by `--restore` to
 * pick the most recent one and to report when there is nothing to restore.
 */
export async function listBackups(target: string): Promise<string[]> {
  const found: string[] = [];
  const base = `${target}.bak`;
  if (await exists(base)) found.push(base);
  for (let index = 1; ; index += 1) {
    const candidate = `${base}.${index}`;
    if (!(await exists(candidate))) break;
    found.push(candidate);
  }
  return found;
}
