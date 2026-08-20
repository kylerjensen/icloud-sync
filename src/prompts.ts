import { checkbox, confirm, select } from "@inquirer/prompts";

import type { ConflictStrategy } from "./copy-plan.ts";

export class NonInteractiveError extends Error {
  readonly hint: string[];

  constructor(message: string, hint: string[]) {
    super(message);
    this.name = "NonInteractiveError";
    this.hint = hint;
  }
}

export function isInteractive(
  input: NodeJS.ReadStream = process.stdin,
  output: NodeJS.WriteStream = process.stdout,
): boolean {
  return input.isTTY === true && output.isTTY === true;
}

export interface PromptContext {
  interactive: boolean;
  /** `--yes` pre-answers the outside-`$HOME` confirmation. */
  assumeYes: boolean;
  /** `--on-conflict` pre-answers conflict resolution. */
  conflictStrategy: ConflictStrategy | undefined;
}

/**
 * Ask before linking something outside `$HOME` — almost always a typo, and the
 * only non-conflict case worth interrupting for.
 */
export async function confirmOutsideHome(
  displayedPath: string,
  context: PromptContext,
): Promise<boolean> {
  if (context.assumeYes) return true;
  if (!context.interactive) {
    throw new NonInteractiveError(`${displayedPath} is outside your home directory.`, [
      "Linking paths outside $HOME into iCloud is usually a mistake.",
      "Pass --yes to confirm when running non-interactively.",
    ]);
  }
  return confirm({
    message: "Continue anyway?",
    default: false,
  });
}

/**
 * The one prompt that matters. All conflicts are already collected and tabled,
 * so this asks once and applies the answer to every one of them.
 *
 * There is deliberately no Cancel: the backup and symlink are already in place
 * by this point, and all three answers leave a coherent state — `skip` is the
 * do-nothing option, with the untouched `.bak` and `--restore` as the way out.
 */
export async function askConflictStrategy(context: PromptContext): Promise<ConflictStrategy> {
  if (context.conflictStrategy) return context.conflictStrategy;
  if (!context.interactive) {
    throw new NonInteractiveError("Conflicts need a resolution but stdin is not a TTY.", [
      "Re-run with --on-conflict keep-both|overwrite|skip to choose non-interactively.",
    ]);
  }

  return select<ConflictStrategy>({
    message: "Resolve conflicts and proceed?",
    default: "keep-both",
    choices: [
      {
        name: "Keep both",
        value: "keep-both",
        description: "Write local copies as <filename> (N) (recommended)",
      },
      {
        name: "Overwrite",
        value: "overwrite",
        description: "Replace iCloud versions with local versions",
      },
      {
        name: "Skip",
        value: "skip",
        description: "Leave iCloud versions untouched, leave local versions in .bak",
      },
    ],
  });
}

export interface PickerChoice {
  name: string;
  value: string;
  description: string;
  /** Already-synced entries are shown for context but pre-deselected. */
  checked: boolean;
}

export async function pickManifestEntries(
  choices: PickerChoice[],
  context: PromptContext,
): Promise<string[]> {
  if (!context.interactive) {
    // Non-interactive manifest runs sync everything actionable rather than hanging.
    return choices.filter((choice) => choice.checked).map((choice) => choice.value);
  }

  return checkbox({
    message: "Select what to sync:",
    choices,
  });
}
