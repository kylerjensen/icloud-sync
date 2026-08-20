import fs from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

/**
 * iCloud Drive lives at `com~apple~CloudDocs` with tildes. The dotted
 * `com.apple.CloudDocs` form does not exist; using it silently creates a stray
 * local folder that never syncs.
 */
export const ICLOUD_DIR_NAME = "com~apple~CloudDocs";

/**
 * Resolve symlinked ancestors in a path.
 *
 * macOS makes this mandatory rather than cosmetic: `/tmp` and `/var` are
 * symlinks into `/private`, so an unresolved path and an unresolved `$HOME` can
 * describe the same directory yet compare as unrelated, which would make the
 * outside-`$HOME` check fire on paths that are really inside it.
 */
export function realPathSafe(target: string): string {
  try {
    return fs.realpathSync.native(target);
  } catch {
    return target;
  }
}

export function homeDir(env: NodeJS.ProcessEnv = process.env): string {
  return realPathSafe(env.HOME ?? homedir());
}

export function icloudRoot(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(homeDir(env), "Library", "Mobile Documents", ICLOUD_DIR_NAME);
}

export function manifestPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(icloudRoot(env), ".icloud-sync", "manifest.json");
}

/** True when `child` is `parent` itself or nested beneath it. */
export function isInside(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/**
 * Render a path with `$HOME` collapsed to `~` and the iCloud root collapsed to
 * `iCloud Drive`, matching the output format in the plan.
 */
export function displayPath(target: string, env: NodeJS.ProcessEnv = process.env): string {
  const icloud = icloudRoot(env);
  if (isInside(icloud, target)) {
    const rel = path.relative(icloud, target);
    return rel === "" ? "iCloud Drive" : `iCloud Drive/${rel}`;
  }
  const home = homeDir(env);
  if (isInside(home, target)) {
    const rel = path.relative(home, target);
    return rel === "" ? "~" : `~/${rel}`;
  }
  return target;
}

/**
 * Map a local path to its iCloud counterpart, mirroring the location relative
 * to `$HOME` so two different `Notes` folders in different subdirectories
 * cannot collide in iCloud.
 */
export function icloudCounterpart(
  localPath: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const home = homeDir(env);
  const rel = isInside(home, localPath)
    ? path.relative(home, localPath)
    : path.basename(localPath);
  return path.join(icloudRoot(env), rel);
}
