import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before } from "node:test";

export interface Sandbox {
  home: string;
  icloud: string;
  env: NodeJS.ProcessEnv;
  cleanup: () => Promise<void>;
}

/**
 * Create an isolated temp `$HOME` with an iCloud Drive root inside it.
 *
 * The path is realpath'd because `os.tmpdir()` on macOS returns a `/var/...`
 * path that is really a symlink into `/private/var`. The CLI resolves symlinked
 * ancestors, so without this the sandbox and the CLI would disagree about every
 * path they exchange.
 */
export async function makeSandbox(): Promise<Sandbox> {
  const created = await fs.mkdtemp(path.join(os.tmpdir(), "icloud-sync-test-"));
  const home = await fs.realpath(created);
  const icloud = path.join(home, "Library", "Mobile Documents", "com~apple~CloudDocs");
  await fs.mkdir(icloud, { recursive: true });

  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, USER: "testuser" };

  return {
    home,
    icloud,
    env,
    cleanup: async () => {
      await fs.rm(home, { recursive: true, force: true });
    },
  };
}

export async function writeFile(target: string, contents: string): Promise<void> {
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, contents, "utf8");
}

/**
 * Register a per-suite sandbox via `before`/`after` hooks.
 *
 * `describe` callbacks are synchronous, so a suite cannot `await makeSandbox()`
 * directly. The returned object is populated before any test in the suite runs.
 */
export function useSandbox(): Sandbox {
  const holder: Sandbox = {
    home: "",
    icloud: "",
    env: {},
    cleanup: async () => {},
  };

  before(async () => {
    Object.assign(holder, await makeSandbox());
  });
  after(async () => {
    await holder.cleanup();
  });

  return holder;
}

export interface TreeSnapshot {
  [relativePath: string]: string;
}

/**
 * Snapshot a directory tree as `relative path → contents`, following nothing.
 * Used to assert `--dry-run` changes nothing.
 */
export async function snapshotTree(root: string): Promise<TreeSnapshot> {
  const snapshot: TreeSnapshot = {};

  async function walk(current: string, relative: string): Promise<void> {
    const entries = await fs.readdir(current, { withFileTypes: true }).catch(() => []);
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const absolute = path.join(current, entry.name);
      const key = relative === "" ? entry.name : `${relative}/${entry.name}`;

      if (entry.isSymbolicLink()) {
        snapshot[key] = `symlink:${await fs.readlink(absolute)}`;
        continue;
      }
      if (entry.isDirectory()) {
        snapshot[key] = "dir";
        await walk(absolute, key);
        continue;
      }
      snapshot[key] = await fs.readFile(absolute, "utf8").catch(() => "<binary>");
    }
  }

  await walk(root, "");
  return snapshot;
}
