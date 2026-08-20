import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { after, describe, it } from "node:test";

import { executeCopy } from "../src/copy-execute.ts";
import { planCopy, totalFileCount } from "../src/copy-plan.ts";
import { makeSandbox, writeFile } from "./helpers.ts";

const sandbox = await makeSandbox();
after(sandbox.cleanup);

async function scenario(name: string): Promise<{ source: string; destination: string }> {
  const source = path.join(sandbox.home, name, "source");
  const destination = path.join(sandbox.home, name, "destination");
  await fs.mkdir(source, { recursive: true });
  await fs.mkdir(destination, { recursive: true });
  return { source, destination };
}

describe("planCopy", () => {
  it("classifies new, identical, and conflicting files", async () => {
    const { source, destination } = await scenario("classify");

    await writeFile(path.join(source, "new.txt"), "fresh");
    await writeFile(path.join(source, "same.txt"), "identical");
    await writeFile(path.join(destination, "same.txt"), "identical");
    await writeFile(path.join(source, "differs.txt"), "local version");
    await writeFile(path.join(destination, "differs.txt"), "icloud version");

    const plan = await planCopy(source, destination);

    assert.deepEqual(plan.newFiles, ["new.txt"]);
    assert.deepEqual(plan.identicalFiles, ["same.txt"]);
    assert.deepEqual(
      plan.conflicts.map((conflict) => conflict.relativePath),
      ["differs.txt"],
    );
    assert.equal(totalFileCount(plan), 2);
  });

  it("treats same-size but different-content files as conflicts", async () => {
    const { source, destination } = await scenario("same-size");
    await writeFile(path.join(source, "a.txt"), "AAAA");
    await writeFile(path.join(destination, "a.txt"), "BBBB");

    const plan = await planCopy(source, destination);
    assert.equal(plan.conflicts.length, 1);
    assert.equal(plan.identicalFiles.length, 0);
  });

  it("recurses into subdirectories and reports relative paths", async () => {
    const { source, destination } = await scenario("nested");
    await writeFile(path.join(source, "deep", "inner", "file.txt"), "x");

    const plan = await planCopy(source, destination);
    assert.deepEqual(plan.newFiles, [path.join("deep", "inner", "file.txt")]);
    assert.ok(plan.directories.includes("deep"));
    assert.ok(plan.directories.includes(path.join("deep", "inner")));
  });

  it("handles a single file source", async () => {
    const base = path.join(sandbox.home, "single");
    const source = path.join(base, ".gitconfig");
    const destination = path.join(base, "cloud", ".gitconfig");
    await writeFile(source, "[user]");

    const plan = await planCopy(source, destination);
    assert.deepEqual(plan.newFiles, [""]);
  });

  it("returns an empty plan when the source does not exist", async () => {
    const plan = await planCopy(path.join(sandbox.home, "absent"), sandbox.icloud);
    assert.equal(totalFileCount(plan), 0);
  });
});

describe("executeCopy", () => {
  it("keeps both by writing a Finder-style (N) copy", async () => {
    const { source, destination } = await scenario("keep-both");
    await writeFile(path.join(source, "report.pdf"), "local");
    await writeFile(path.join(destination, "report.pdf"), "icloud");

    const plan = await planCopy(source, destination);
    const result = await executeCopy(source, destination, plan, "keep-both");

    assert.equal(await fs.readFile(path.join(destination, "report.pdf"), "utf8"), "icloud");
    assert.equal(await fs.readFile(path.join(destination, "report (2).pdf"), "utf8"), "local");
    assert.deepEqual(result.keptBoth, [{ relativePath: "report.pdf", newName: "report (2).pdf" }]);
  });

  it("increments past an existing (2) copy", async () => {
    const { source, destination } = await scenario("keep-both-increment");
    await writeFile(path.join(source, "report.pdf"), "local");
    await writeFile(path.join(destination, "report.pdf"), "icloud");
    await writeFile(path.join(destination, "report (2).pdf"), "taken");

    const plan = await planCopy(source, destination);
    await executeCopy(source, destination, plan, "keep-both");

    assert.equal(await fs.readFile(path.join(destination, "report (3).pdf"), "utf8"), "local");
  });

  it("overwrites the iCloud version when asked", async () => {
    const { source, destination } = await scenario("overwrite");
    await writeFile(path.join(source, "a.txt"), "local");
    await writeFile(path.join(destination, "a.txt"), "icloud");

    const plan = await planCopy(source, destination);
    const result = await executeCopy(source, destination, plan, "overwrite");

    assert.equal(await fs.readFile(path.join(destination, "a.txt"), "utf8"), "local");
    assert.equal(result.overwritten, 1);
  });

  it("leaves the iCloud version untouched when skipping", async () => {
    const { source, destination } = await scenario("skip");
    await writeFile(path.join(source, "a.txt"), "local");
    await writeFile(path.join(destination, "a.txt"), "icloud");

    const plan = await planCopy(source, destination);
    const result = await executeCopy(source, destination, plan, "skip");

    assert.equal(await fs.readFile(path.join(destination, "a.txt"), "utf8"), "icloud");
    assert.equal(result.skipped, 1);
    // The local copy stays in the backup, recoverable via --restore.
    assert.equal(await fs.readFile(path.join(source, "a.txt"), "utf8"), "local");
  });

  it("copies new files regardless of the chosen strategy", async () => {
    const { source, destination } = await scenario("new-with-skip");
    await writeFile(path.join(source, "new.txt"), "fresh");
    await writeFile(path.join(source, "conflict.txt"), "local");
    await writeFile(path.join(destination, "conflict.txt"), "icloud");

    const plan = await planCopy(source, destination);
    await executeCopy(source, destination, plan, "skip");

    assert.equal(await fs.readFile(path.join(destination, "new.txt"), "utf8"), "fresh");
  });

  it("recreates symlinks as links rather than copying through them", async () => {
    const { source, destination } = await scenario("symlink");
    await writeFile(path.join(source, "real.txt"), "data");
    await fs.symlink("real.txt", path.join(source, "link.txt"));

    const plan = await planCopy(source, destination);
    await executeCopy(source, destination, plan, "keep-both");

    const stats = await fs.lstat(path.join(destination, "link.txt"));
    assert.ok(stats.isSymbolicLink());
    assert.equal(await fs.readlink(path.join(destination, "link.txt")), "real.txt");
  });
});
