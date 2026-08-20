import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { after, describe, it } from "node:test";

import {
  canonicalKey,
  emptyManifest,
  MANIFEST_VERSION,
  readManifest,
  removeEntry,
  upsertEntry,
  writeManifest,
} from "../src/manifest.ts";
import { manifestPath } from "../src/paths.ts";
import { makeSandbox, writeFile } from "./helpers.ts";

const sandbox = await makeSandbox();
after(sandbox.cleanup);

describe("canonicalKey", () => {
  it("lowercases and normalises separators so keys match across machines", () => {
    assert.equal(canonicalKey("Work/Assets"), "work/assets");
    assert.equal(canonicalKey("Downloads"), "downloads");
  });
});

describe("manifest round-trip", () => {
  it("writes and reads back an entry, creating the directory", async () => {
    const manifest = upsertEntry(emptyManifest(), {
      key: "downloads",
      relativePath: "Downloads",
      localName: "Downloads",
      icloudName: "Downloads",
    });

    await writeManifest(manifest, sandbox.env);
    const readBack = await readManifest(sandbox.env);

    assert.equal(readBack.version, MANIFEST_VERSION);
    assert.equal(readBack.entries.length, 1);
    assert.equal(readBack.entries[0]?.relativePath, "Downloads");
    assert.ok(readBack.entries[0]?.createdAt);
    assert.ok(readBack.entries[0]?.updatedAt);
  });

  it("preserves createdAt but refreshes updatedAt on upsert", () => {
    const first = upsertEntry(
      emptyManifest(),
      { key: "docs", relativePath: "Docs", localName: "Docs", icloudName: "Docs" },
      new Date("2026-01-01T00:00:00Z"),
    );
    const second = upsertEntry(
      first,
      { key: "docs", relativePath: "Docs", localName: "Docs", icloudName: "DOCS" },
      new Date("2026-06-01T00:00:00Z"),
    );

    assert.equal(second.entries.length, 1);
    assert.equal(second.entries[0]?.createdAt, "2026-01-01T00:00:00.000Z");
    assert.equal(second.entries[0]?.updatedAt, "2026-06-01T00:00:00.000Z");
    assert.equal(second.entries[0]?.icloudName, "DOCS");
  });

  it("removes an entry by key", () => {
    const manifest = upsertEntry(emptyManifest(), {
      key: "notes",
      relativePath: "Notes",
      localName: "Notes",
      icloudName: "Notes",
    });
    assert.equal(removeEntry(manifest, "notes").entries.length, 0);
    assert.equal(removeEntry(manifest, "other").entries.length, 1);
  });
});

describe("manifest resilience", () => {
  it("returns empty when the manifest does not exist", async () => {
    const fresh = await makeSandbox();
    try {
      const manifest = await readManifest(fresh.env);
      assert.deepEqual(manifest.entries, []);
    } finally {
      await fresh.cleanup();
    }
  });

  it("returns empty rather than throwing on a corrupt manifest", async () => {
    const fresh = await makeSandbox();
    try {
      await writeFile(manifestPath(fresh.env), "{ not json");
      assert.deepEqual((await readManifest(fresh.env)).entries, []);
    } finally {
      await fresh.cleanup();
    }
  });

  it("drops malformed entries but keeps valid ones", async () => {
    const fresh = await makeSandbox();
    try {
      await writeFile(
        manifestPath(fresh.env),
        JSON.stringify({
          version: 1,
          entries: [
            { key: "ok", relativePath: "Ok", localName: "Ok", icloudName: "Ok" },
            { nonsense: true },
          ],
        }),
      );
      const manifest = await readManifest(fresh.env);
      assert.equal(manifest.entries.length, 1);
      assert.equal(manifest.entries[0]?.key, "ok");
    } finally {
      await fresh.cleanup();
    }
  });

  it("writes JSON with a trailing newline", async () => {
    const raw = await fs.readFile(manifestPath(sandbox.env), "utf8");
    assert.ok(raw.endsWith("\n"));
  });
});
