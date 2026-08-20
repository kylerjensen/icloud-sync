import path from "node:path";

import pc from "picocolors";

import type { Conflict } from "./copy-plan.ts";

export interface OutputOptions {
  verbose: boolean;
  dryRun: boolean;
  stream?: NodeJS.WriteStream;
}

const MAX_CONFLICT_ROWS = 5;

export function colorEnabled(
  stream: NodeJS.WriteStream = process.stdout,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== "") return false;
  return stream.isTTY === true;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unitIndex]}`;
}

export function formatDate(mtimeMs: number): string {
  const date = new Date(mtimeMs);
  const month = date.toLocaleString("en-US", { month: "short" });
  return `${month} ${date.getDate()}`;
}

export function formatDuration(ms: number): string {
  const totalSeconds = Math.max(1, Math.round(ms / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m ${seconds}s`;
}

export function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

/**
 * Renders the streaming step output.
 *
 * Steps print their label immediately and are completed in place with
 * `... Done.`, so a slow copy shows what it is doing rather than going quiet.
 * When stdout is not a TTY there is no cursor to rewrite, so the label and its
 * outcome are emitted as one line on completion instead.
 */
export class Reporter {
  private readonly options: OutputOptions;
  private readonly stream: NodeJS.WriteStream;
  private readonly color: boolean;
  private readonly interactive: boolean;
  private pendingLabel: string | undefined;

  constructor(options: OutputOptions) {
    this.options = options;
    this.stream = options.stream ?? process.stdout;
    this.color = colorEnabled(this.stream);
    this.interactive = this.stream.isTTY === true;
  }

  get isVerbose(): boolean {
    return this.options.verbose;
  }

  private paint(text: string, painter: (input: string) => string): string {
    return this.color ? painter(text) : text;
  }

  line(text = ""): void {
    this.stream.write(`${text}\n`);
  }

  detail(text: string): void {
    if (this.options.verbose) this.line(`  ${this.paint(text, pc.dim)}`);
  }

  /** Begin a step. In dry-run mode the label is already phrased as "Would …". */
  beginStep(label: string): void {
    this.pendingLabel = label;
    if (this.interactive && !this.options.dryRun) {
      this.stream.write(`${label}... `);
    }
  }

  /** Complete the current step, optionally with an outcome other than `Done.` */
  endStep(outcome = "Done."): void {
    const label = this.pendingLabel;
    this.pendingLabel = undefined;

    if (this.options.dryRun) {
      this.line(`${label}.`);
      this.line();
      return;
    }

    if (this.interactive) {
      this.line(this.paint(outcome, pc.green));
    } else {
      this.line(`${label}... ${outcome}`);
    }
    this.line();
  }

  /** Complete the current step without the `Done.` framing (e.g. found conflicts). */
  endStepRaw(outcome: string): void {
    const label = this.pendingLabel;
    this.pendingLabel = undefined;
    if (this.interactive && !this.options.dryRun) {
      this.line(outcome);
    } else {
      this.line(`${label}... ${outcome}`);
    }
    this.line();
  }

  success(text: string): void {
    this.line(`${this.paint("✓", pc.green)} ${text}`);
  }

  warn(text: string): void {
    this.line(`${this.paint("⚠", pc.yellow)} ${text}`);
  }

  error(text: string): void {
    this.line(`${this.paint("✗", pc.red)} ${text}`);
  }

  conflictTable(conflicts: Conflict[]): void {
    const shown = this.options.verbose ? conflicts : conflicts.slice(0, MAX_CONFLICT_ROWS);
    const hidden = conflicts.length - shown.length;

    const rows = shown.map((conflict) => {
      const localNewer = conflict.local.mtimeMs > conflict.icloud.mtimeMs;
      const icloudNewer = conflict.icloud.mtimeMs > conflict.local.mtimeMs;
      return [
        // A single-file sync has an empty relative path; fall back to the name
        // rather than rendering a blank cell.
        conflict.relativePath === "" ? path.basename(conflict.localPath) : conflict.relativePath,
        `${formatBytes(conflict.local.size)} ${formatDate(conflict.local.mtimeMs)}${localNewer ? " (newer)" : ""}`,
        `${formatBytes(conflict.icloud.size)} ${formatDate(conflict.icloud.mtimeMs)}${icloudNewer ? " (newer)" : ""}`,
      ];
    });

    const header = ["Name", "Local Version", "iCloud Version"];
    const widths = header.map((cell, column) =>
      Math.max(cell.length, ...rows.map((row) => row[column]!.length)),
    );
    const border = `  |${widths.map((width) => "-".repeat(width + 2)).join("|")}|`;
    const renderRow = (cells: string[]): string =>
      `  | ${cells.map((cell, column) => cell.padEnd(widths[column]!)).join(" | ")} |`;

    this.line(border);
    this.line(renderRow(header));
    this.line(border);
    for (const row of rows) this.line(renderRow(row));
    this.line(border);
    if (hidden > 0) {
      this.line(`  ${this.paint(`… and ${hidden} more (use --verbose to see all)`, pc.dim)}`);
    }
    this.line();
  }
}
