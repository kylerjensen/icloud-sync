import fs from "node:fs/promises";
import path from "node:path";

import { setHidden } from "./macos.ts";
import { canonicalKey, readManifest, removeEntry, writeManifest } from "./manifest.ts";
import { listBackups } from "./naming.ts";
import { displayPath, homeDir, icloudCounterpart } from "./paths.ts";
import type { Reporter } from "./reporter.ts";

export interface RestoreAnalysis {
  localPath: string;
  symlinkTarget: string | undefined;
  backupPath: string | undefined;
  error: { message: string; hint: string[] } | undefined;
}

/** Read-only analysis for `--restore`, mirroring the sync side. */
export async function analyzeRestore(
  localPath: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<RestoreAnalysis> {
  const stats = await fs.lstat(localPath).catch(() => undefined);
  const symlinkTarget = stats?.isSymbolicLink()
    ? path.resolve(path.dirname(localPath), await fs.readlink(localPath))
    : undefined;

  const backups = await listBackups(localPath);
  // Most recent backup wins; earlier ones stay untouched.
  const backupPath = backups.at(-1);

  if (!backupPath) {
    return {
      localPath,
      symlinkTarget,
      backupPath: undefined,
      error: {
        message: `No backup found for ${displayPath(localPath, env)}.`,
        hint: [
          "Restore needs a <Name>.bak to put back, and guessing would risk data loss.",
          "The iCloud Drive copy is still there if you want it.",
        ],
      },
    };
  }

  if (stats && !stats.isSymbolicLink()) {
    return {
      localPath,
      symlinkTarget,
      backupPath,
      error: {
        message: `${displayPath(localPath, env)} is not a symlink.`,
        hint: ["Refusing to overwrite a real file or directory during restore."],
      },
    };
  }

  return { localPath, symlinkTarget, backupPath, error: undefined };
}

export interface RestoreStep {
  label: string;
  dryLabel: string;
}

export function planRestoreSteps(
  analysis: RestoreAnalysis,
  env: NodeJS.ProcessEnv = process.env,
): RestoreStep[] {
  const local = displayPath(analysis.localPath, env);
  const steps: RestoreStep[] = [];

  if (analysis.symlinkTarget) {
    steps.push({
      label: `Removing symlink ${local}`,
      dryLabel: `Would remove symlink ${local}`,
    });
  }

  if (analysis.backupPath) {
    const backup = displayPath(analysis.backupPath, env);
    steps.push({
      label: `Restoring ${backup} to ${local} (unhidden)`,
      dryLabel: `Would restore ${backup} to ${local} (unhidden)`,
    });
  }

  return steps;
}

export async function executeRestore(
  analysis: RestoreAnalysis,
  reporter: Reporter,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const steps = planRestoreSteps(analysis, env);

  for (const [index, step] of steps.entries()) {
    reporter.beginStep(step.label);
    if (index === 0 && analysis.symlinkTarget) {
      await fs.unlink(analysis.localPath);
    } else {
      await fs.rename(analysis.backupPath!, analysis.localPath);
      await setHidden(analysis.localPath, false);
    }
    reporter.endStep();
  }

  const home = homeDir(env);
  const relativePath = path.relative(home, analysis.localPath);
  const manifest = await readManifest(env);
  await writeManifest(removeEntry(manifest, canonicalKey(relativePath)), env);
}

/** Where the iCloud copy for a restored path lives, for the closing message. */
export function icloudCopyFor(localPath: string, env: NodeJS.ProcessEnv = process.env): string {
  return icloudCounterpart(localPath, env);
}
