import fs from "node:fs/promises";
import path from "node:path";

import { manifestPath } from "./paths.ts";

export const MANIFEST_VERSION = 1;

export interface ManifestEntry {
  /** Canonical key, lowercased, used for lookup across machines. */
  key: string;
  /** Path relative to `$HOME`, so the entry is portable between Macs. */
  relativePath: string;
  /** Resolved on-disk casing for each side; they can legitimately differ. */
  localName: string;
  icloudName: string;
  createdAt: string;
  updatedAt: string;
}

export interface Manifest {
  version: number;
  entries: ManifestEntry[];
}

export function emptyManifest(): Manifest {
  return { version: MANIFEST_VERSION, entries: [] };
}

export function canonicalKey(relativePath: string): string {
  return relativePath.split(path.sep).join("/").toLowerCase();
}

/**
 * Read the manifest, tolerating absence and corruption.
 *
 * It lives in iCloud so it is shared across machines, which also means it can be
 * mid-sync or partially written. A bad manifest must not break a sync, so this
 * falls back to empty rather than throwing.
 */
export async function readManifest(env: NodeJS.ProcessEnv = process.env): Promise<Manifest> {
  try {
    const raw = await fs.readFile(manifestPath(env), "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      !Array.isArray((parsed as Manifest).entries)
    ) {
      return emptyManifest();
    }
    const manifest = parsed as Manifest;
    return {
      version: typeof manifest.version === "number" ? manifest.version : MANIFEST_VERSION,
      entries: manifest.entries.filter(
        (entry): entry is ManifestEntry =>
          typeof entry?.relativePath === "string" && typeof entry?.key === "string",
      ),
    };
  } catch {
    return emptyManifest();
  }
}

export async function writeManifest(
  manifest: Manifest,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const target = manifestPath(env);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

export function upsertEntry(
  manifest: Manifest,
  entry: Omit<ManifestEntry, "createdAt" | "updatedAt">,
  now: Date = new Date(),
): Manifest {
  const timestamp = now.toISOString();
  const existingIndex = manifest.entries.findIndex((candidate) => candidate.key === entry.key);

  if (existingIndex === -1) {
    return {
      ...manifest,
      entries: [...manifest.entries, { ...entry, createdAt: timestamp, updatedAt: timestamp }],
    };
  }

  const existing = manifest.entries[existingIndex]!;
  const entries = [...manifest.entries];
  entries[existingIndex] = { ...existing, ...entry, updatedAt: timestamp };
  return { ...manifest, entries };
}

export function removeEntry(manifest: Manifest, key: string): Manifest {
  return { ...manifest, entries: manifest.entries.filter((entry) => entry.key !== key) };
}
