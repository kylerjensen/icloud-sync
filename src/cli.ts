import path from "node:path";

import { HELP_TEXT, parseArgs, UsageError, type CliOptions } from "./args.ts";
import { analyze, type Analysis } from "./analyze.ts";
import { resolveExistingPath } from "./casing.ts";
import { totalFileCount } from "./copy-plan.ts";
import { backupHint, execute } from "./execute.ts";
import { readManifest } from "./manifest.ts";
import { displayPath, homeDir } from "./paths.ts";
import {
  confirmOutsideHome,
  isInteractive,
  NonInteractiveError,
  pickManifestEntries,
  type PromptContext,
} from "./prompts.ts";
import { formatDuration, pluralize, Reporter } from "./reporter.ts";
import {
  analyzeRestore,
  executeRestore,
  icloudCopyFor,
  planRestoreSteps,
} from "./restore.ts";
import { planSteps } from "./steps.ts";

export const VERSION = "0.1.0";

interface RunContext {
  options: CliOptions;
  reporter: Reporter;
  prompts: PromptContext;
  env: NodeJS.ProcessEnv;
  cwd: string;
}

export async function main(argv: string[]): Promise<number> {
  let options: CliOptions;
  try {
    options = parseArgs(argv);
  } catch (error) {
    if (error instanceof UsageError) {
      process.stderr.write(`${error.message}\n\n${HELP_TEXT}\n`);
      return 2;
    }
    throw error;
  }

  if (options.help) {
    process.stdout.write(`${HELP_TEXT}\n`);
    return 0;
  }
  if (options.version) {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }

  const reporter = new Reporter({ verbose: options.verbose, dryRun: options.dryRun });
  const context: RunContext = {
    options,
    reporter,
    env: process.env,
    cwd: process.cwd(),
    prompts: {
      interactive: isInteractive(),
      assumeYes: options.assumeYes,
      conflictStrategy: options.onConflict,
    },
  };

  if (options.dryRun) {
    reporter.line("Dry run — no changes will be made.");
    reporter.line();
  }

  try {
    if (options.restore) return await runRestore(context);
    if (options.source !== undefined) return await runAdHoc(context);
    if (options.names.length === 0) return await runManifest(context);
    return await runSync(context, options.names);
  } catch (error) {
    if (error instanceof NonInteractiveError) {
      reporter.error(error.message);
      for (const line of error.hint) reporter.line(`  ${line}`);
      return 1;
    }
    throw error;
  }
}

async function runSync(context: RunContext, names: string[]): Promise<number> {
  let worstExit = 0;
  for (const [index, name] of names.entries()) {
    if (index > 0) context.reporter.line();
    const localPath = await resolveExistingPath(context.cwd, name);
    const exit = await syncOne(context, name, localPath, undefined);
    worstExit = Math.max(worstExit, exit);
  }
  return worstExit;
}

async function runAdHoc(context: RunContext): Promise<number> {
  const { options } = context;
  const localPath = await resolveExistingPath(context.cwd, options.source!);
  const icloudPath = path.resolve(context.cwd, options.target!);
  return syncOne(context, options.source!, localPath, icloudPath);
}

async function syncOne(
  context: RunContext,
  typedName: string,
  localPath: string,
  explicitIcloudPath: string | undefined,
): Promise<number> {
  const { reporter, env, options } = context;
  const started = Date.now();

  const analysis = await analyze({
    typedName,
    localPath,
    explicitIcloudPath,
    env,
  });

  if (analysis.problem) {
    reporter.error(analysis.problem.message);
    for (const line of analysis.problem.hint ?? []) reporter.line(`  ${line}`);
    return 1;
  }

  if (analysis.noop) {
    reporter.success(
      `${displayPath(analysis.localPath, env)} is already synced to ${displayPath(analysis.icloudPath, env)}. Nothing to do.`,
    );
    return 0;
  }

  if (analysis.outsideHome) {
    reporter.warn(`${analysis.localPath} is outside your home directory.`);
    reporter.line("  Linking paths outside $HOME into iCloud is usually a mistake.");
    reporter.line();
    if (options.dryRun) {
      reporter.line("Would ask for confirmation before continuing.");
      reporter.line();
    } else if (!(await confirmOutsideHome(analysis.localPath, context.prompts))) {
      return 0;
    }
  }

  if (analysis.casingMismatch) {
    reporter.line(
      `Resolved "${typedName}" → local ${displayPath(analysis.localPath, env)}, ${displayPath(analysis.icloudPath, env)}.`,
    );
    reporter.line();
  }

  if (options.dryRun) {
    renderDryRun(context, analysis);
    return 0;
  }

  const outcome = await execute({
    analysis,
    reporter,
    prompts: context.prompts,
    env,
    recordInManifest: explicitIcloudPath === undefined,
  });

  reporter.line(`Process completed in ${formatDuration(Date.now() - started)}.`);

  if (outcome.backupPath) {
    reporter.line();
    for (const line of backupHint(outcome.backupPath, env)) reporter.line(line);
  }

  return 0;
}

function renderDryRun(context: RunContext, analysis: Analysis): void {
  const { reporter, env } = context;
  const steps = planSteps(analysis, env);
  const conflicts = analysis.copy?.conflicts ?? [];

  for (const step of steps) {
    if (step.kind === "copy" && conflicts.length > 0) {
      const fileCount = totalFileCount(analysis.copy!);
      reporter.line(
        `Would copy ${pluralize(fileCount, "file")}, of which ${conflicts.length} conflict:`,
      );
      reporter.line();
      reporter.conflictTable(conflicts);
      continue;
    }
    reporter.line(`${step.dryLabel}.`);
    if (step.note) reporter.detail(step.note);
    reporter.line();
  }

  reporter.line("Re-run without --dry-run to apply.");
}

async function runRestore(context: RunContext): Promise<number> {
  const { reporter, env, options } = context;
  let worstExit = 0;

  if (options.names.length === 0) {
    reporter.error("--restore needs a name.");
    return 2;
  }

  for (const [index, name] of options.names.entries()) {
    if (index > 0) reporter.line();
    const started = Date.now();
    const localPath = await resolveExistingPath(context.cwd, name);
    const analysis = await analyzeRestore(localPath, env);

    if (analysis.error) {
      reporter.error(analysis.error.message);
      for (const line of analysis.error.hint) reporter.line(`  ${line}`);
      worstExit = Math.max(worstExit, 1);
      continue;
    }

    if (options.dryRun) {
      for (const step of planRestoreSteps(analysis, env)) {
        reporter.line(`${step.dryLabel}.`);
        reporter.line();
      }
      reporter.line("Re-run without --dry-run to apply.");
      continue;
    }

    await executeRestore(analysis, reporter, env);
    reporter.line(`Process completed in ${formatDuration(Date.now() - started)}.`);
    reporter.line();
    reporter.line(`The ${displayPath(icloudCopyFor(localPath, env), env)} copy was left untouched.`);
  }

  return worstExit;
}

/**
 * No-argument run: replay the manifest. Because the manifest lives in iCloud it
 * is shared across machines, which is what makes this useful for setting up a
 * second Mac.
 */
async function runManifest(context: RunContext): Promise<number> {
  const { reporter, env } = context;
  const manifest = await readManifest(env);

  if (manifest.entries.length === 0) {
    reporter.line("No entries in the iCloud Drive manifest yet.");
    reporter.line("Run icloud-sync <Name> to sync something first.");
    return 0;
  }

  reporter.line(
    `Found ${pluralize(manifest.entries.length, "entry", "entries")} in the iCloud Drive manifest.`,
  );
  reporter.line();

  const home = homeDir(env);
  const choices = await Promise.all(
    manifest.entries.map(async (entry) => {
      const localPath = path.join(home, entry.relativePath);
      const analysis = await analyze({ typedName: entry.relativePath, localPath, env });
      const alreadySynced = analysis.noop;
      const description = alreadySynced
        ? "already synced"
        : analysis.problem
          ? analysis.problem.message.split("\n")[0]!
          : analysis.backup
            ? "iCloud copy exists, local copy will be backed up + merged"
            : "iCloud copy exists, no local copy";
      return {
        name: entry.relativePath,
        value: entry.relativePath,
        description,
        checked: !alreadySynced && analysis.problem === undefined,
      };
    }),
  );

  const selected = await pickManifestEntries(choices, context.prompts);
  if (selected.length === 0) {
    reporter.line("Nothing selected.");
    return 0;
  }

  reporter.line();
  let worstExit = 0;
  for (const [index, relativePath] of selected.entries()) {
    if (index > 0) reporter.line();
    const localPath = path.join(home, relativePath);
    const exit = await syncOne(context, relativePath, localPath, undefined);
    worstExit = Math.max(worstExit, exit);
  }
  return worstExit;
}

const isDirectRun = process.argv[1] !== undefined;
if (isDirectRun) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`icloud-sync: ${message}\n`);
      process.exitCode = 1;
    });
}
