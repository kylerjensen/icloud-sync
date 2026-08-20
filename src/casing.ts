import fs from "node:fs/promises";
import path from "node:path";

import { realPathSafe } from "./paths.ts";

/**
 * Find the real on-disk casing of `name` inside `dir`.
 *
 * Both `$HOME` and iCloud Drive are APFS case-insensitive but case-preserving,
 * so `fs.stat` succeeds on the wrong casing while the directory listing shows
 * something else. Anything that ends up in a symlink target or a printed path
 * has to come from the listing, not from user input.
 *
 * Returns the actual entry name, or `undefined` when nothing matches.
 */
export async function resolveCasing(dir: string, name: string): Promise<string | undefined> {
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return undefined;
  }
  if (entries.includes(name)) return name;
  const lowered = name.toLowerCase();
  return entries.find((entry) => entry.toLowerCase() === lowered);
}

export interface ResolvedName {
  /** Casing to use for the local symlink: existing local → existing iCloud → as typed. */
  localName: string;
  /** Casing to use for the iCloud copy: existing iCloud → existing local → as typed. */
  icloudName: string;
  /** Whether the two sides disagree, which is worth echoing to the user. */
  mismatch: boolean;
  existingLocalName: string | undefined;
  existingIcloudName: string | undefined;
}

/**
 * Apply the casing priority rules from the plan. The two sides can legitimately
 * differ (local `Notes` alongside iCloud `NOTES`); when they do, callers echo
 * the resolution so it does not look like a bug.
 */
export async function resolveNameCasing(
  localParent: string,
  icloudParent: string,
  typedName: string,
): Promise<ResolvedName> {
  const [existingLocalName, existingIcloudName] = await Promise.all([
    resolveCasing(localParent, typedName),
    resolveCasing(icloudParent, typedName),
  ]);

  const localName = existingLocalName ?? existingIcloudName ?? typedName;
  const icloudName = existingIcloudName ?? existingLocalName ?? typedName;

  return {
    localName,
    icloudName,
    mismatch: localName !== icloudName,
    existingLocalName,
    existingIcloudName,
  };
}

/**
 * Resolve a user-supplied name relative to `cwd`, correcting the casing of every
 * segment that already exists on disk. Supports nested paths (`work/assets`) as
 * well as bare names.
 *
 * Symlinked *ancestors* are resolved (macOS `/tmp` → `/private/tmp`) so the
 * result can be compared against `$HOME`, but the final segment is left as-is:
 * whether it is a symlink, and where it points, is exactly what the caller needs
 * to inspect.
 */
export async function resolveExistingPath(cwd: string, input: string): Promise<string> {
  const absolute = path.resolve(realPathSafe(cwd), input);
  const parent = realPathSafe(path.dirname(absolute));
  const root = path.parse(parent).root;
  const segments = parent.slice(root.length).split(path.sep).filter(Boolean);

  let current = root;
  for (const segment of segments) {
    const actual = await resolveCasing(current, segment);
    current = path.join(current, actual ?? segment);
  }

  const base = path.basename(absolute);
  return path.join(current, (await resolveCasing(current, base)) ?? base);
}
