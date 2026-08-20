import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { after, describe, it } from "node:test";

import {
  listBackups,
  nextAvailableCopyName,
  resolveBackupTarget,
  splitExtension,
  withCopyIndex,
} from "../src/naming.ts";
import { makeSandbox, writeFile } from "./helpers.ts";

const sandbox = await makeSandbox();
after(sandbox.cleanup);

describe("splitExtension", () => {
  it("splits a normal filename", () => {
    assert.deepEqual(splitExtension("report.pdf"), ["report", ".pdf"]);
  });

  it("treats a leading dot as part of the stem", () => {
    assert.deepEqual(splitExtension(".gitconfig"), [".gitconfig", ""]);
  });

  it("uses only the final dot", () => {
    assert.deepEqual(splitExtension("archive.tar.gz"), ["archive.tar", ".gz"]);
  });

  it("handles no extension at all", () => {
    assert.deepEqual(splitExtension("Makefile"), ["Makefile", ""]);
  });
});

describe("withCopyIndex", () => {
  it("inserts the index before the extension so the file still opens", () => {
    assert.equal(withCopyIndex("report.pdf", 2), "report (2).pdf");
    assert.equal(withCopyIndex("report.pdf", 10), "report (10).pdf");
  });

  it("appends for dotfiles and extensionless names", () => {
    assert.equal(withCopyIndex(".gitconfig", 2), ".gitconfig (2)");
    assert.equal(withCopyIndex("Makefile", 3), "Makefile (3)");
  });
});

describe("nextAvailableCopyName", () => {
  it("starts at (2) and skips taken names", async () => {
    const dir = path.join(sandbox.home, "copies");
    await fs.mkdir(dir, { recursive: true });

    assert.equal(await nextAvailableCopyName(dir, "a.txt"), "a (2).txt");

    await writeFile(path.join(dir, "a (2).txt"), "x");
    await writeFile(path.join(dir, "a (3).txt"), "x");
    assert.equal(await nextAvailableCopyName(dir, "a.txt"), "a (4).txt");
  });
});

describe("resolveBackupTarget", () => {
  it("uses a plain .bak when nothing is in the way", async () => {
    const target = path.join(sandbox.home, "Fresh");
    await fs.mkdir(target, { recursive: true });

    const backup = await resolveBackupTarget(target, true);
    assert.equal(backup.path, `${target}.bak`);
    assert.equal(backup.mergesIntoExisting, false);
    assert.deepEqual(backup.existingSuffixes, []);
  });

  it("merges a directory into an existing .bak rather than nesting", async () => {
    const target = path.join(sandbox.home, "Docs");
    await fs.mkdir(target, { recursive: true });
    await fs.mkdir(`${target}.bak`, { recursive: true });

    const backup = await resolveBackupTarget(target, true);
    assert.equal(backup.path, `${target}.bak`);
    assert.equal(backup.mergesIntoExisting, true);
  });

  it("increments for a file collision, reporting the taken suffixes", async () => {
    const target = path.join(sandbox.home, ".gitconfig");
    await writeFile(target, "current");
    await writeFile(`${target}.bak`, "old");
    await writeFile(`${target}.bak.1`, "older");

    const backup = await resolveBackupTarget(target, false);
    assert.equal(backup.path, `${target}.bak.2`);
    assert.equal(backup.mergesIntoExisting, false);
    assert.deepEqual(backup.existingSuffixes, [".bak", ".bak.1"]);
  });

  it("increments when a directory's .bak is occupied by a file", async () => {
    const target = path.join(sandbox.home, "Mixed");
    await fs.mkdir(target, { recursive: true });
    await writeFile(`${target}.bak`, "a file, not a dir");

    const backup = await resolveBackupTarget(target, true);
    assert.equal(backup.path, `${target}.bak.1`);
    assert.equal(backup.mergesIntoExisting, false);
  });
});

describe("listBackups", () => {
  it("lists existing backups in suffix order", async () => {
    const target = path.join(sandbox.home, "Listed");
    await writeFile(target, "x");
    await writeFile(`${target}.bak`, "1");
    await writeFile(`${target}.bak.1`, "2");

    assert.deepEqual(await listBackups(target), [`${target}.bak`, `${target}.bak.1`]);
  });

  it("returns empty when there is nothing to restore", async () => {
    assert.deepEqual(await listBackups(path.join(sandbox.home, "NeverBackedUp")), []);
  });
});
