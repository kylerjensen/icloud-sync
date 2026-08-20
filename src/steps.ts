import type { Analysis } from "./analyze.ts";
import { totalFileCount } from "./copy-plan.ts";
import { displayPath } from "./paths.ts";
import { pluralize } from "./reporter.ts";

export type StepKind = "create-icloud-dir" | "strip-acl" | "backup" | "symlink" | "copy";

export interface Step {
  kind: StepKind;
  /** Imperative present-participle label for a real run: "Backing up …". */
  label: string;
  /** Same step phrased for `--dry-run`: "Would back up …". */
  dryLabel: string;
  /** Optional dim second line, e.g. which `.bak` suffixes were already taken. */
  note?: string;
}

/**
 * Derive the step list from an analysis.
 *
 * Both output modes read from here, which is the mechanism that keeps `--dry-run`
 * honest — a step cannot appear in one and not the other.
 */
export function planSteps(analysis: Analysis, env: NodeJS.ProcessEnv = process.env): Step[] {
  const steps: Step[] = [];
  const local = displayPath(analysis.localPath, env);
  const icloud = displayPath(analysis.icloudPath, env);

  if (analysis.needsAclStrip) {
    steps.push({
      kind: "strip-acl",
      label: `Removing deny-delete ACL from ${local}`,
      dryLabel: `Would remove the deny-delete ACL from ${local}`,
      note: "This is why the rename previously appeared to need sudo.",
    });
  }

  if (analysis.backup) {
    const backup = displayPath(analysis.backup.path, env);
    const verb = analysis.backup.mergesIntoExisting ? "Merging" : "Backing up";
    const dryVerb = analysis.backup.mergesIntoExisting ? "Would merge" : "Would back up";
    const preposition = analysis.backup.mergesIntoExisting ? "into" : "to";
    steps.push({
      kind: "backup",
      label: `${verb} ${local} ${preposition} ${backup} (hidden)`,
      dryLabel: `${dryVerb} ${local} ${preposition} ${backup} (hidden)`,
      note:
        analysis.backup.existingSuffixes.length > 0 && !analysis.backup.mergesIntoExisting
          ? `${analysis.backup.existingSuffixes.join(" and ")} already exist.`
          : undefined,
    });
  }

  if (analysis.needsIcloudDir) {
    steps.push({
      kind: "create-icloud-dir",
      label: `Creating ${icloud}`,
      dryLabel: `Would create ${icloud}`,
    });
  }

  steps.push({
    kind: "symlink",
    label: `Creating symlink: ${local} → ${icloud}`,
    dryLabel: `Would create symlink: ${local} → ${icloud}`,
  });

  const fileCount = analysis.copy ? totalFileCount(analysis.copy) : 0;
  if (fileCount > 0) {
    steps.push({
      kind: "copy",
      label: `Copying ${pluralize(fileCount, "file")}`,
      dryLabel: `Would copy ${pluralize(fileCount, "file")}`,
    });
  }

  return steps;
}
