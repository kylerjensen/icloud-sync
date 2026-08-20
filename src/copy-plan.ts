import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export type ConflictStrategy = "keep-both" | "overwrite" | "skip";

export interface FileFacts {
  size: number;
  mtimeMs: number;
}

export interface Conflict {
  /** Path relative to the copy root, so it reads the same on both sides. */
  relativePath: string;
  /** Absolute local path, used for display when the copy root is a single file. */
  localPath: string;
  local: FileFacts;
  icloud: FileFacts;
}

export interface CopyPlan {
  /** Files present locally but not in iCloud — copied unconditionally. */
  newFiles: string[];
  /** Present on both sides with identical contents — skipped silently. */
  identicalFiles: string[];
  /** Present on both sides with differing contents — one prompt covers all. */
  conflicts: Conflict[];
  /** Directories that must exist before copying. */
  directories: string[];
}

export function totalFileCount(plan: CopyPlan): number {
  return plan.newFiles.length + plan.conflicts.length;
}

async function hashFile(target: string): Promise<string> {
  const hash = createHash("sha256");
  hash.update(await fs.readFile(target));
  return hash.digest("hex");
}

/**
 * Cheap-first content comparison: differing sizes cannot be identical, so only
 * same-size pairs get hashed.
 */
async function sameContents(a: string, aFacts: FileFacts, b: string, bFacts: FileFacts): Promise<boolean> {
  if (aFacts.size !== bFacts.size) return false;
  const [hashA, hashB] = await Promise.all([hashFile(a), hashFile(b)]);
  return hashA === hashB;
}

/**
 * Walk the local source and classify every file against the iCloud destination.
 *
 * This is a pure read pass — nothing is written. That is what lets the caller
 * collect *all* conflicts, show them in one table, and ask a single question,
 * instead of interrupting repeatedly mid-copy.
 */
export async function planCopy(source: string, destination: string): Promise<CopyPlan> {
  const plan: CopyPlan = {
    newFiles: [],
    identicalFiles: [],
    conflicts: [],
    directories: [],
  };

  const sourceStats = await fs.lstat(source).catch(() => undefined);
  if (!sourceStats) return plan;

  if (!sourceStats.isDirectory()) {
    await classifyFile(source, destination, "", plan);
    return plan;
  }

  await walk(source, destination, "", plan);
  return plan;
}

async function walk(
  sourceDir: string,
  destinationDir: string,
  relativeDir: string,
  plan: CopyPlan,
): Promise<void> {
  const entries = await fs.readdir(sourceDir, { withFileTypes: true }).catch(() => []);

  for (const entry of entries) {
    const relativePath = relativeDir === "" ? entry.name : path.join(relativeDir, entry.name);
    const sourcePath = path.join(sourceDir, entry.name);
    const destinationPath = path.join(destinationDir, entry.name);

    if (entry.isDirectory()) {
      plan.directories.push(relativePath);
      await walk(sourcePath, destinationPath, relativePath, plan);
      continue;
    }

    // Symlinks are copied as links; treat them as opaque files for planning.
    await classifyFile(sourcePath, destinationPath, relativePath, plan);
  }
}

async function classifyFile(
  sourcePath: string,
  destinationPath: string,
  relativePath: string,
  plan: CopyPlan,
): Promise<void> {
  const [sourceStats, destinationStats] = await Promise.all([
    fs.lstat(sourcePath).catch(() => undefined),
    fs.lstat(destinationPath).catch(() => undefined),
  ]);
  if (!sourceStats) return;

  if (!destinationStats) {
    plan.newFiles.push(relativePath);
    return;
  }

  const local: FileFacts = { size: sourceStats.size, mtimeMs: sourceStats.mtimeMs };
  const icloud: FileFacts = { size: destinationStats.size, mtimeMs: destinationStats.mtimeMs };

  const bothPlainFiles = sourceStats.isFile() && destinationStats.isFile();
  if (bothPlainFiles && (await sameContents(sourcePath, local, destinationPath, icloud))) {
    plan.identicalFiles.push(relativePath);
    return;
  }

  plan.conflicts.push({ relativePath, localPath: sourcePath, local, icloud });
}
