import fs from "node:fs/promises";
import path from "node:path";

import type { Analysis } from "./analyze.ts";
import { executeCopy } from "./copy-execute.ts";
import { planCopy, totalFileCount, type ConflictStrategy } from "./copy-plan.ts";
import { setHidden, stripDenyDeleteAcl } from "./macos.ts";
import {
  canonicalKey,
  readManifest,
  upsertEntry,
  writeManifest,
  type Manifest,
} from "./manifest.ts";
import { displayPath } from "./paths.ts";
import { askConflictStrategy, type PromptContext } from "./prompts.ts";
import { pluralize, type Reporter } from "./reporter.ts";
import { planSteps } from "./steps.ts";

export interface ExecuteOptions {
  analysis: Analysis;
  reporter: Reporter;
  prompts: PromptContext;
  env: NodeJS.ProcessEnv;
  /** Skip manifest writes for ad-hoc `--source`/`--target` pairs. */
  recordInManifest: boolean;
}

export interface ExecuteOutcome {
  backupPath: string | undefined;
  strategy: ConflictStrategy | undefined;
}

/**
 * Perform the analysed steps, streaming one line each.
 *
 * The symlink is created *before* the copy, so the copy writes through the
 * symlink by the same path the user will use afterward and there is never a
 * window where the local name does not exist.
 */
export async function execute(options: ExecuteOptions): Promise<ExecuteOutcome> {
  const { analysis, reporter, env } = options;
  const steps = planSteps(analysis, env);
  const outcome: ExecuteOutcome = { backupPath: undefined, strategy: undefined };

  let copySource = analysis.localPath;

  for (const step of steps) {
    switch (step.kind) {
      case "strip-acl": {
        reporter.beginStep(step.label);
        const removed = await stripDenyDeleteAcl(analysis.localPath);
        reporter.endStep(`Done. (${pluralize(removed, "entry", "entries")})`);
        if (step.note) reporter.detail(step.note);
        break;
      }

      case "backup": {
        reporter.beginStep(step.label);
        const backup = analysis.backup!;
        if (backup.mergesIntoExisting) {
          await mergeIntoExistingBackup(analysis.localPath, backup.path);
        } else {
          await fs.rename(analysis.localPath, backup.path);
        }
        await setHidden(backup.path, true);
        copySource = backup.path;
        outcome.backupPath = backup.path;
        reporter.endStep();
        if (step.note) reporter.detail(step.note);
        break;
      }

      case "create-icloud-dir": {
        reporter.beginStep(step.label);
        await fs.mkdir(analysis.icloudPath, { recursive: true });
        reporter.endStep();
        break;
      }

      case "symlink": {
        reporter.beginStep(step.label);
        await fs.mkdir(path.dirname(analysis.icloudPath), { recursive: true });
        await fs.mkdir(path.dirname(analysis.localPath), { recursive: true });
        await fs.symlink(analysis.icloudPath, analysis.localPath);
        reporter.endStep();
        break;
      }

      case "copy": {
        // Re-plan against the renamed source: the analysis ran before the move,
        // and re-reading keeps the copy honest if anything shifted underneath.
        const plan = await planCopy(copySource, analysis.icloudPath);
        const fileCount = totalFileCount(plan);
        if (fileCount === 0) break;

        reporter.beginStep(`Copying ${pluralize(fileCount, "file")}`);

        let strategy: ConflictStrategy = "keep-both";
        if (plan.conflicts.length > 0) {
          reporter.endStepRaw(`Found ${pluralize(plan.conflicts.length, "conflict")}.`);
          reporter.conflictTable(plan.conflicts);
          strategy = await askConflictStrategy(options.prompts);
          outcome.strategy = strategy;
          reporter.line();
          reporter.beginStep(`Copying ${pluralize(fileCount, "file")}`);
        }

        const result = await executeCopy(copySource, analysis.icloudPath, plan, strategy);
        reporter.endStep();
        for (const kept of result.keptBoth) {
          reporter.detail(`${kept.relativePath} → ${kept.newName}`);
        }
        if (result.skipped > 0) {
          reporter.detail(`${pluralize(result.skipped, "file")} left in the backup.`);
        }
        if (plan.identicalFiles.length > 0) {
          reporter.detail(
            `${pluralize(plan.identicalFiles.length, "identical file")} skipped.`,
          );
        }
        break;
      }
    }
  }

  if (options.recordInManifest) {
    await recordManifest(analysis, env);
  }

  return outcome;
}

/**
 * A directory colliding with an existing `<Name>.bak` merges into it rather than
 * nesting a second backup, which would bury the first one.
 */
async function mergeIntoExistingBackup(source: string, backup: string): Promise<void> {
  const entries = await fs.readdir(source, { withFileTypes: true });
  for (const entry of entries) {
    const from = path.join(source, entry.name);
    const to = path.join(backup, entry.name);
    try {
      await fs.rename(from, to);
    } catch {
      // Destination exists; keep the existing backup copy and leave the newer
      // one behind under an indexed name rather than overwriting either.
      await fs.cp(from, `${to}.new`, { recursive: true, force: false }).catch(() => undefined);
      await fs.rm(from, { recursive: true, force: true });
    }
  }
  await fs.rmdir(source).catch(() => undefined);
}

async function recordManifest(analysis: Analysis, env: NodeJS.ProcessEnv): Promise<void> {
  const manifest: Manifest = await readManifest(env);
  const relativePath = analysis.relativeToHome;
  const updated = upsertEntry(manifest, {
    key: canonicalKey(relativePath),
    relativePath,
    localName: path.basename(analysis.localPath),
    icloudName: path.basename(analysis.icloudPath),
  });
  await writeManifest(updated, env);
}

export function backupHint(backupPath: string, env: NodeJS.ProcessEnv): string[] {
  const shown = displayPath(backupPath, env);
  return [`${shown} kept as a backup. Remove it with:`, `  rm -rf ${shown.replace(/ /g, "\\ ")}`];
}
