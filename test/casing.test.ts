import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { after, describe, it } from "node:test";

import { resolveCasing, resolveExistingPath, resolveNameCasing } from "../src/casing.ts";
import { makeSandbox, writeFile } from "./helpers.ts";

const sandbox = await makeSandbox();
after(sandbox.cleanup);

describe("resolveCasing", () => {
  it("returns the real on-disk casing for a differently-cased request", async () => {
    await fs.mkdir(path.join(sandbox.home, "Notes"), { recursive: true });
    assert.equal(await resolveCasing(sandbox.home, "notes"), "Notes");
    assert.equal(await resolveCasing(sandbox.home, "NOTES"), "Notes");
    assert.equal(await resolveCasing(sandbox.home, "Notes"), "Notes");
  });

  it("prefers an exact match over a case-insensitive one", async () => {
    const dir = path.join(sandbox.home, "exact");
    await fs.mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "File"), "a");
    assert.equal(await resolveCasing(dir, "File"), "File");
  });

  it("returns undefined when nothing matches or the dir is missing", async () => {
    assert.equal(await resolveCasing(sandbox.home, "nope"), undefined);
    assert.equal(await resolveCasing(path.join(sandbox.home, "missing"), "x"), undefined);
  });
});

describe("resolveNameCasing", () => {
  it("uses local casing for the symlink and iCloud casing for the destination", async () => {
    await fs.mkdir(path.join(sandbox.home, "Docs"), { recursive: true });
    await fs.mkdir(path.join(sandbox.icloud, "DOCS"), { recursive: true });

    const resolved = await resolveNameCasing(sandbox.home, sandbox.icloud, "docs");
    assert.equal(resolved.localName, "Docs");
    assert.equal(resolved.icloudName, "DOCS");
    assert.equal(resolved.mismatch, true);
  });

  it("falls back across sides, then to the typed name", async () => {
    await fs.mkdir(path.join(sandbox.home, "OnlyLocal"), { recursive: true });
    const localOnly = await resolveNameCasing(sandbox.home, sandbox.icloud, "onlylocal");
    assert.equal(localOnly.localName, "OnlyLocal");
    assert.equal(localOnly.icloudName, "OnlyLocal");
    assert.equal(localOnly.mismatch, false);

    await fs.mkdir(path.join(sandbox.icloud, "OnlyCloud"), { recursive: true });
    const cloudOnly = await resolveNameCasing(sandbox.home, sandbox.icloud, "onlycloud");
    assert.equal(cloudOnly.localName, "OnlyCloud");
    assert.equal(cloudOnly.icloudName, "OnlyCloud");

    const neither = await resolveNameCasing(sandbox.home, sandbox.icloud, "Fresh");
    assert.equal(neither.localName, "Fresh");
    assert.equal(neither.icloudName, "Fresh");
  });
});

describe("resolveExistingPath", () => {
  it("corrects casing on every existing segment of a nested path", async () => {
    await fs.mkdir(path.join(sandbox.home, "Work", "Assets"), { recursive: true });
    const resolved = await resolveExistingPath(sandbox.home, "work/assets");
    assert.equal(resolved, path.join(sandbox.home, "Work", "Assets"));
  });

  it("keeps the typed casing for segments that do not exist yet", async () => {
    const resolved = await resolveExistingPath(sandbox.home, "Brand/New");
    assert.equal(resolved, path.join(sandbox.home, "Brand", "New"));
  });

  it("resolves relative to the given directory, not the process cwd", async () => {
    const nested = path.join(sandbox.home, "Work");
    const resolved = await resolveExistingPath(nested, "assets");
    assert.equal(resolved, path.join(nested, "Assets"));
  });
});
