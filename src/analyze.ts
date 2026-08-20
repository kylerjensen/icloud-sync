import fs from "node:fs/promises";
import path from "node:path";

import { resolveNameCasing } from "./casing.ts";
import { planCopy, type CopyPlan } from "./copy-plan.ts";
import { hasDenyDeleteAcl, ownershipOf } from "./macos.ts";
import { resolveBackupTarget, type BackupTarget } from "./naming.ts";
import { displayPath, homeDir, icloudRoot, isInside } from "./paths.ts";

export type LocalState =
  | { kind: "missing" }
  | { kind: "already-linked"; target: string }
  | { kind: "foreign-symlink"; target: string }
  | { kind: "directory" }
  | { kind: "file" };

export interface BlockingProblem {
  code: "root-user" | "root-owned" | "foreign-symlink" | "outside-home-declined";
  message: string;
  hint?: string[];
}

export interface Analysis {
  typedName: string;
  localPath: string;
  icloudPath: string;
  relativeToHome: string;
  outsideHome: boolean;
  casingMismatch: boolean;
  localState: LocalState;
  icloudExists: boolean;
  needsIcloudDir: boolean;
  needsAclStrip: boolean;
  backup: BackupTarget | undefined;
  copy: CopyPlan | undefined;
  /** True when the run would change nothing. */
  noop: boolean;
  problem: BlockingProblem | undefined;
}

async function lstatOrUndefined(target: string) {
  try {
    return await fs.lstat(target);
  } catch {
    return undefined;
  }
}

async function inspectLocal(localPath: string, icloudPath: string): Promise<LocalState> {
  const stats = await lstatOrUndefined(localPath);
  if (!stats) return { kind: "missing" };

  if (stats.isSymbolicLink()) {
    const rawTarget = await fs.readlink(localPath);
    const target = path.resolve(path.dirname(localPath), rawTarget);
    // Case-insensitive comparison: the volume is, so a casing-only difference
    // still points at the same directory and must not be called foreign.
    const matches = target.toLowerCase() === icloudPath.toLowerCase();
    return matches ? { kind: "already-linked", target } : { kind: "foreign-symlink", target };
  }

  return stats.isDirectory() ? { kind: "directory" } : { kind: "file" };
}

/**
 * Verify the path is owned by the current user.
 *
 * A previous `sudo mv` can leave root-owned items in `$HOME`, which break later
 * unelevated operations in confusing ways. Catching it here lets us print the
 * exact `chown` instead of failing mid-run.
 */
async function checkOwnership(
  target: string,
  env: NodeJS.ProcessEnv,
): Promise<BlockingProblem | undefined> {
  const stats = await lstatOrUndefined(target);
  if (!stats) return undefined;

  const currentUid = process.getuid?.() ?? stats.uid;
  if (stats.uid === currentUid) return undefined;

  const owner = await ownershipOf(target);
  const expectedUser = env.USER ?? String(currentUid);
  return {
    code: "root-owned",
    message: `${displayPath(target, env)} is owned by ${owner.userName}:${owner.groupName}, not ${expectedUser}:staff.`,
    hint: [
      "This usually means it was moved with sudo. Fix it with:",
      `  sudo chown -R ${expectedUser}:staff ${displayPath(target, env)}`,
      "Then re-run. icloud-sync itself never needs sudo.",
    ],
  };
}

export interface AnalyzeInput {
  typedName: string;
  /** Absolute local path, already casing-corrected for existing segments. */
  localPath: string;
  /** Explicit iCloud target, for `--source`/`--target`. Otherwise derived. */
  explicitIcloudPath?: string;
  env?: NodeJS.ProcessEnv;
}

/**
 * The read-only analysis pass.
 *
 * Everything that decides *what will happen* lives here, so `--dry-run` and a
 * real run cannot disagree: dry-run renders this and stops, a real run hands it
 * to the executor.
 */
export async function analyze(input: AnalyzeInput): Promise<Analysis> {
  const env = input.env ?? process.env;
  const home = homeDir(env);
  const localParent = path.dirname(input.localPath);
  const typedBase = path.basename(input.localPath);

  const derivedIcloudParent = input.explicitIcloudPath
    ? path.dirname(input.explicitIcloudPath)
    : path.join(icloudRoot(env), path.relative(home, localParent));

  const casing = await resolveNameCasing(localParent, derivedIcloudParent, typedBase);

  const localPath = path.join(localParent, casing.localName);
  const icloudPath =
    input.explicitIcloudPath ?? path.join(derivedIcloudParent, casing.icloudName);

  const outsideHome = !isInside(home, localPath);
  const localState = await inspectLocal(localPath, icloudPath);
  const icloudStats = await lstatOrUndefined(icloudPath);
  const icloudExists = icloudStats !== undefined;

  const analysis: Analysis = {
    typedName: input.typedName,
    localPath,
    icloudPath,
    relativeToHome: path.relative(home, localPath),
    outsideHome,
    casingMismatch: casing.mismatch && casing.existingLocalName !== undefined && casing.existingIcloudName !== undefined,
    localState,
    icloudExists,
    // A file's iCloud counterpart is created by the copy, not by mkdir —
    // mkdir'ing it would turn the destination into a directory and make the
    // file look like a conflict against it.
    needsIcloudDir: !icloudExists && localState.kind !== "file",
    needsAclStrip: false,
    backup: undefined,
    copy: undefined,
    noop: false,
    problem: undefined,
  };

  if (process.getuid?.() === 0) {
    analysis.problem = {
      code: "root-user",
      message: "icloud-sync must not be run as root.",
      hint: [
        "Running as root creates root-owned files in your home directory.",
        "Re-run without sudo — the deny-delete ACL is stripped without elevation.",
      ],
    };
    return analysis;
  }

  if (localState.kind === "foreign-symlink") {
    analysis.problem = {
      code: "foreign-symlink",
      message: `${displayPath(localPath, env)} is already a symlink to:\n    ${localState.target}`,
      hint: [
        "Refusing to replace a symlink this tool did not create.",
        "Use --restore first if you want to change it.",
      ],
    };
    return analysis;
  }

  if (localState.kind === "already-linked") {
    analysis.noop = true;
    return analysis;
  }

  const ownershipProblem = await checkOwnership(localPath, env);
  if (ownershipProblem) {
    analysis.problem = ownershipProblem;
    return analysis;
  }

  if (localState.kind === "directory" || localState.kind === "file") {
    analysis.needsAclStrip = await hasDenyDeleteAcl(localPath);
    analysis.backup = await resolveBackupTarget(localPath, localState.kind === "directory");
    // Conflicts are computed against the post-rename source, but the contents
    // are identical to the current path, so plan against it directly.
    analysis.copy = await planCopy(localPath, icloudPath);
  }

  return analysis;
}
