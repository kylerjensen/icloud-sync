import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import { promisify } from "node:util";

const run = promisify(execFile);

export interface ExecResult {
  stdout: string;
  stderr: string;
}

async function tryRun(file: string, args: string[]): Promise<ExecResult | undefined> {
  try {
    return await run(file, args);
  } catch {
    return undefined;
  }
}

/**
 * List ACL entries for a path, in the `ls -le` numbered form.
 *
 * `~/Downloads` and friends ship with an inherited `group:everyone deny delete`
 * entry. That entry blocks *renaming the directory itself*, which is why
 * `mv ~/Downloads ~/Downloads.bak` fails with `Permission denied` even though
 * the user owns it — and why this originally looked like it needed `sudo`.
 */
export async function listAclEntries(target: string): Promise<string[]> {
  const result = await tryRun("/bin/ls", ["-lde", target]);
  if (!result) return [];
  return result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /^\d+:\s/.test(line));
}

export function isDenyDeleteEntry(entry: string): boolean {
  return /\bdeny\b/.test(entry) && /\bdelete\b/.test(entry);
}

export async function hasDenyDeleteAcl(target: string): Promise<boolean> {
  return (await listAclEntries(target)).some(isDenyDeleteEntry);
}

/**
 * Remove every deny-delete ACL entry from `target`.
 *
 * The owner can do this without elevation (`chmod -a# <index>`), which is what
 * makes the whole tool `sudo`-free. Entries are removed highest-index-first
 * because removing one renumbers the rest.
 */
export async function stripDenyDeleteAcl(target: string): Promise<number> {
  const entries = await listAclEntries(target);
  const indexes: number[] = [];
  for (const entry of entries) {
    const match = /^(\d+):\s/.exec(entry);
    if (match?.[1] !== undefined && isDenyDeleteEntry(entry)) {
      indexes.push(Number(match[1]));
    }
  }

  let removed = 0;
  for (const index of indexes.sort((a, b) => b - a)) {
    if (await tryRun("/bin/chmod", [`-a#`, String(index), target])) removed += 1;
  }
  return removed;
}

export async function setHidden(target: string, hidden: boolean): Promise<void> {
  await tryRun("/usr/bin/chflags", [hidden ? "hidden" : "nohidden", target]);
}

export async function isHidden(target: string): Promise<boolean> {
  const stats = await fs.lstat(target);
  const UF_HIDDEN = 0x8000;
  // Node exposes BSD file flags via st_flags on Darwin.
  const flags = (stats as unknown as { flags?: number }).flags ?? 0;
  return (flags & UF_HIDDEN) !== 0;
}

export interface OwnershipInfo {
  uid: number;
  gid: number;
  userName: string;
  groupName: string;
}

const userNameCache = new Map<number, string>();
const groupNameCache = new Map<number, string>();

async function lookupName(
  cache: Map<number, string>,
  database: "Users" | "Groups",
  idKey: "uid" | "gid",
  id: number,
): Promise<string> {
  const cached = cache.get(id);
  if (cached !== undefined) return cached;

  const result = await tryRun("/usr/bin/dscl", [".", "-search", `/${database}`, idKey, String(id)]);
  const name = result?.stdout.split(/\s+/)[0] ?? String(id);
  cache.set(id, name);
  return name;
}

export async function ownershipOf(target: string): Promise<OwnershipInfo> {
  const stats = await fs.lstat(target);
  const [userName, groupName] = await Promise.all([
    lookupName(userNameCache, "Users", "uid", stats.uid),
    lookupName(groupNameCache, "Groups", "gid", stats.gid),
  ]);
  return { uid: stats.uid, gid: stats.gid, userName, groupName };
}
