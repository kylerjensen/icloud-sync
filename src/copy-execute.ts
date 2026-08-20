import fs from "node:fs/promises";
import path from "node:path";

import type { ConflictStrategy, CopyPlan } from "./copy-plan.ts";
import { nextAvailableCopyName } from "./naming.ts";

export interface CopyResult {
  copied: number;
  skipped: number;
  overwritten: number;
  /** `keep both` renames, as `relativePath → new name`, for `--verbose`. */
  keptBoth: Array<{ relativePath: string; newName: string }>;
}

async function copyEntry(source: string, destination: string): Promise<void> {
  const stats = await fs.lstat(source);
  if (stats.isSymbolicLink()) {
    const link = await fs.readlink(source);
    await fs.rm(destination, { force: true });
    await fs.symlink(link, destination);
    return;
  }
  await fs.copyFile(source, destination);
  // Preserve mtime so a later run does not see a spurious difference.
  await fs.utimes(destination, stats.atime, stats.mtime);
}

/**
 * Apply a `CopyPlan`. New files always copy; conflicts follow the single chosen
 * strategy. Nothing is deleted, and `skip` leaves the local version in the
 * hidden `.bak` where `--restore` can still reach it.
 */
export async function executeCopy(
  source: string,
  destination: string,
  plan: CopyPlan,
  strategy: ConflictStrategy,
): Promise<CopyResult> {
  const result: CopyResult = { copied: 0, skipped: 0, overwritten: 0, keptBoth: [] };

  const sourceStats = await fs.lstat(source).catch(() => undefined);
  const sourceIsDirectory = sourceStats?.isDirectory() ?? false;

  if (sourceIsDirectory) {
    await fs.mkdir(destination, { recursive: true });
    for (const relativeDir of plan.directories) {
      await fs.mkdir(path.join(destination, relativeDir), { recursive: true });
    }
  } else {
    await fs.mkdir(path.dirname(destination), { recursive: true });
  }

  const resolve = (relativePath: string): [string, string] =>
    relativePath === ""
      ? [source, destination]
      : [path.join(source, relativePath), path.join(destination, relativePath)];

  for (const relativePath of plan.newFiles) {
    const [from, to] = resolve(relativePath);
    await copyEntry(from, to);
    result.copied += 1;
  }

  for (const conflict of plan.conflicts) {
    const [from, to] = resolve(conflict.relativePath);

    if (strategy === "skip") {
      result.skipped += 1;
      continue;
    }

    if (strategy === "overwrite") {
      await copyEntry(from, to);
      result.overwritten += 1;
      result.copied += 1;
      continue;
    }

    const directory = path.dirname(to);
    const newName = await nextAvailableCopyName(directory, path.basename(to));
    await copyEntry(from, path.join(directory, newName));
    result.keptBoth.push({ relativePath: conflict.relativePath, newName });
    result.copied += 1;
  }

  return result;
}
