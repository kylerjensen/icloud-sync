import type { ConflictStrategy } from "./copy-plan.ts";

export interface CliOptions {
  names: string[];
  dryRun: boolean;
  verbose: boolean;
  assumeYes: boolean;
  restore: boolean;
  help: boolean;
  version: boolean;
  onConflict: ConflictStrategy | undefined;
  source: string | undefined;
  target: string | undefined;
}

export class UsageError extends Error {}

const CONFLICT_STRATEGIES: ConflictStrategy[] = ["keep-both", "overwrite", "skip"];

function parseStrategy(value: string | undefined): ConflictStrategy {
  if (value !== undefined && (CONFLICT_STRATEGIES as string[]).includes(value)) {
    return value as ConflictStrategy;
  }
  throw new UsageError(
    `--on-conflict expects one of ${CONFLICT_STRATEGIES.join("|")}, got ${value ?? "nothing"}.`,
  );
}

export function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    names: [],
    dryRun: false,
    verbose: false,
    assumeYes: false,
    restore: false,
    help: false,
    version: false,
    onConflict: undefined,
    source: undefined,
    target: undefined,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;

    if (arg === "--") {
      options.names.push(...argv.slice(index + 1));
      break;
    }

    if (!arg.startsWith("-")) {
      options.names.push(arg);
      continue;
    }

    const [flag, inlineValue] = arg.includes("=")
      ? [arg.slice(0, arg.indexOf("=")), arg.slice(arg.indexOf("=") + 1)]
      : [arg, undefined];
    const takeValue = (): string => {
      if (inlineValue !== undefined) return inlineValue;
      const next = argv[index + 1];
      if (next === undefined || next.startsWith("-")) {
        throw new UsageError(`${flag} expects a value.`);
      }
      index += 1;
      return next;
    };

    switch (flag) {
      case "-h":
      case "--help":
        options.help = true;
        break;
      case "-v":
      case "--version":
        options.version = true;
        break;
      case "-n":
      case "--dry-run":
        options.dryRun = true;
        break;
      case "--verbose":
        options.verbose = true;
        break;
      case "-y":
      case "--yes":
        options.assumeYes = true;
        break;
      case "--restore":
        options.restore = true;
        break;
      case "--on-conflict":
        options.onConflict = parseStrategy(takeValue());
        break;
      case "--source":
        options.source = takeValue();
        break;
      case "--target":
        options.target = takeValue();
        break;
      default:
        throw new UsageError(`Unknown option: ${flag}`);
    }
  }

  const hasSource = options.source !== undefined;
  const hasTarget = options.target !== undefined;
  if (hasSource !== hasTarget) {
    throw new UsageError("--source and --target must be used together.");
  }
  if (hasSource && options.names.length > 0) {
    throw new UsageError("--source/--target cannot be combined with a name argument.");
  }
  if (options.restore && hasSource) {
    throw new UsageError("--restore does not take --source/--target; pass the local name.");
  }

  return options;
}

export const HELP_TEXT = `icloud-sync — symlink directories in $HOME into iCloud Drive.

Usage:
  icloud-sync <Name>              Sync a path (resolved relative to the current directory)
  icloud-sync                     Sync entries recorded in the iCloud manifest
  icloud-sync --restore <Name>    Undo a sync, leaving the iCloud copy in place
  icloud-sync --source <path> --target <path>
                                  Link an ad-hoc pair outside the manifest

Options:
  -n, --dry-run                   Analyse and report without touching disk
      --verbose                   Show sizes, counts, and every file
  -y, --yes                       Pre-answer the outside-$HOME confirmation
      --on-conflict <strategy>    keep-both (default) | overwrite | skip
  -h, --help                      Show this help
  -v, --version                   Show the version

icloud-sync never needs sudo. The deny-delete ACL that blocks renaming
~/Downloads is stripped by the owner without elevation, and running as root
would leave root-owned files in your home directory.`;
