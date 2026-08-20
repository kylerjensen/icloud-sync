import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { before, describe, it } from "node:test";

import { makeSandbox, snapshotTree, useSandbox, writeFile } from "./helpers.ts";

const run = promisify(execFile);
const repoRoot = path.resolve(import.meta.dirname, "..");
const bundle = path.join(repoRoot, "dist", "icloud-sync.mjs");

before(async () => {
  await run(process.execPath, [path.join(repoRoot, "scripts", "build.mjs")], { cwd: repoRoot });
});

interface CliRun {
  stdout: string;
  stderr: string;
  code: number;
}

/**
 * Invoke the bundled CLI against a sandbox `$HOME`. stdout is a pipe, not a TTY,
 * which also exercises the non-interactive output path.
 */
async function cli(
  env: NodeJS.ProcessEnv,
  cwd: string,
  args: string[],
): Promise<CliRun> {
  try {
    const result = await run(process.execPath, [bundle, ...args], { cwd, env });
    return { stdout: result.stdout, stderr: result.stderr, code: 0 };
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string; code?: number };
    return {
      stdout: failure.stdout ?? "",
      stderr: failure.stderr ?? "",
      code: failure.code ?? 1,
    };
  }
}

describe("scenario A: local exists, iCloud does not", () => {
  const sandbox = useSandbox();

  it("backs up, links, and copies", async () => {
    const documents = path.join(sandbox.home, "Documents");
    await writeFile(path.join(documents, "a.txt"), "one");
    await writeFile(path.join(documents, "nested", "b.txt"), "two");

    const result = await cli(sandbox.env, sandbox.home, ["Documents"]);
    assert.equal(result.code, 0, result.stderr);

    const linkStats = await fs.lstat(documents);
    assert.ok(linkStats.isSymbolicLink());
    assert.equal(await fs.readlink(documents), path.join(sandbox.icloud, "Documents"));

    assert.equal(await fs.readFile(path.join(sandbox.icloud, "Documents", "a.txt"), "utf8"), "one");
    assert.equal(
      await fs.readFile(path.join(sandbox.icloud, "Documents", "nested", "b.txt"), "utf8"),
      "two",
    );

    // The backup is kept as a safety net, never deleted.
    assert.ok((await fs.lstat(`${documents}.bak`)).isDirectory());
    assert.match(result.stdout, /Backing up/);
    assert.match(result.stdout, /Creating symlink/);
    assert.match(result.stdout, /kept as a backup/);
  });
});

describe("scenario B: already correctly linked", () => {
  const sandbox = useSandbox();

  it("is a no-op and does not nest a second backup", async () => {
    const downloads = path.join(sandbox.home, "Downloads");
    await fs.mkdir(path.join(sandbox.icloud, "Downloads"), { recursive: true });
    await fs.symlink(path.join(sandbox.icloud, "Downloads"), downloads);

    const result = await cli(sandbox.env, sandbox.home, ["Downloads"]);

    assert.equal(result.code, 0);
    assert.match(result.stdout, /already synced/);
    assert.equal(
      await fs.lstat(`${downloads}.bak`).then(
        () => true,
        () => false,
      ),
      false,
    );
  });
});

describe("scenario C: neither side exists", () => {
  const sandbox = useSandbox();

  it("creates the iCloud directory and links to it", async () => {
    const result = await cli(sandbox.env, sandbox.home, ["Screenshots"]);

    assert.equal(result.code, 0, result.stderr);
    assert.ok((await fs.lstat(path.join(sandbox.icloud, "Screenshots"))).isDirectory());
    assert.ok((await fs.lstat(path.join(sandbox.home, "Screenshots"))).isSymbolicLink());
    assert.doesNotMatch(result.stdout, /Backing up/);
  });
});

describe("scenario D: casing mismatch", () => {
  const sandbox = useSandbox();

  it("links using local casing and targets the existing iCloud casing", async () => {
    await writeFile(path.join(sandbox.home, "Notes", "note.txt"), "hi");
    await fs.mkdir(path.join(sandbox.icloud, "NOTES"), { recursive: true });

    const result = await cli(sandbox.env, sandbox.home, ["notes"]);

    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /Resolved "notes"/);
    assert.equal(
      await fs.readlink(path.join(sandbox.home, "Notes")),
      path.join(sandbox.icloud, "NOTES"),
    );
    assert.equal(await fs.readFile(path.join(sandbox.icloud, "NOTES", "note.txt"), "utf8"), "hi");
  });
});

describe("scenario E: target is a file", () => {
  const sandbox = useSandbox();

  it("increments the .bak suffix past existing backups", async () => {
    const gitconfig = path.join(sandbox.home, ".gitconfig");
    await writeFile(gitconfig, "[user]\n");
    await writeFile(`${gitconfig}.bak`, "old");
    await writeFile(`${gitconfig}.bak.1`, "older");

    const result = await cli(sandbox.env, sandbox.home, [".gitconfig"]);

    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /\.gitconfig\.bak\.2/);
    assert.equal(await fs.readFile(`${gitconfig}.bak.2`, "utf8"), "[user]\n");
    assert.equal(await fs.readFile(path.join(sandbox.icloud, ".gitconfig"), "utf8"), "[user]\n");
  });
});

describe("scenario F: outside $HOME", () => {
  const sandbox = useSandbox();

  it("refuses non-interactively without --yes", async () => {
    const outside = await fs.mkdtemp(path.join(sandbox.home, "..", "outside-"));
    try {
      await writeFile(path.join(outside, "assets", "x.txt"), "x");
      const result = await cli(sandbox.env, outside, ["assets"]);

      assert.equal(result.code, 1);
      assert.match(result.stdout, /outside your home directory/);
      assert.match(result.stdout, /--yes/);
      // Nothing was touched.
      assert.ok((await fs.lstat(path.join(outside, "assets"))).isDirectory());
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });

  it("proceeds with --yes", async () => {
    const outside = await fs.mkdtemp(path.join(sandbox.home, "..", "outside-yes-"));
    try {
      await writeFile(path.join(outside, "assets", "x.txt"), "x");
      const result = await cli(sandbox.env, outside, ["assets", "--yes"]);

      assert.equal(result.code, 0, result.stderr);
      assert.ok((await fs.lstat(path.join(outside, "assets"))).isSymbolicLink());
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });
});

describe("scenario G: restore", () => {
  const sandbox = useSandbox();

  it("reverses the link and leaves the iCloud copy alone", async () => {
    const documents = path.join(sandbox.home, "Documents");
    await writeFile(path.join(documents, "a.txt"), "one");

    await cli(sandbox.env, sandbox.home, ["Documents"]);
    const result = await cli(sandbox.env, sandbox.home, ["--restore", "Documents"]);

    assert.equal(result.code, 0, result.stderr);
    const stats = await fs.lstat(documents);
    assert.ok(stats.isDirectory() && !stats.isSymbolicLink());
    assert.equal(await fs.readFile(path.join(documents, "a.txt"), "utf8"), "one");
    // iCloud copy untouched.
    assert.equal(await fs.readFile(path.join(sandbox.icloud, "Documents", "a.txt"), "utf8"), "one");
    assert.match(result.stdout, /left untouched/);
  });

  it("errors when there is nothing to restore", async () => {
    const result = await cli(sandbox.env, sandbox.home, ["--restore", "NeverSynced"]);
    assert.equal(result.code, 1);
    assert.match(result.stdout, /No backup found/);
  });
});

describe("scenario I: foreign symlink", () => {
  const sandbox = useSandbox();

  it("refuses to replace a symlink it did not create", async () => {
    const elsewhere = path.join(sandbox.home, "Library", "CloudStorage", "OneDrive");
    await fs.mkdir(elsewhere, { recursive: true });
    const link = path.join(sandbox.home, "OneDrive - Nutrien");
    await fs.symlink(elsewhere, link);

    const result = await cli(sandbox.env, sandbox.home, ["OneDrive - Nutrien"]);

    assert.equal(result.code, 1);
    assert.match(result.stdout, /already a symlink to/);
    assert.match(result.stdout, /Refusing to replace/);
    assert.equal(await fs.readlink(link), elsewhere);
  });
});

describe("conflict strategies via --on-conflict", () => {
  it("keep-both writes a (2) copy and leaves iCloud intact", async () => {
    const sandbox = await makeSandbox();
    try {
      await writeFile(path.join(sandbox.home, "Docs", "report.pdf"), "local");
      await writeFile(path.join(sandbox.icloud, "Docs", "report.pdf"), "icloud");

      const result = await cli(sandbox.env, sandbox.home, [
        "Docs",
        "--on-conflict",
        "keep-both",
      ]);

      assert.equal(result.code, 0, result.stderr);
      assert.match(result.stdout, /Found 1 conflict/);
      assert.equal(
        await fs.readFile(path.join(sandbox.icloud, "Docs", "report.pdf"), "utf8"),
        "icloud",
      );
      assert.equal(
        await fs.readFile(path.join(sandbox.icloud, "Docs", "report (2).pdf"), "utf8"),
        "local",
      );
    } finally {
      await sandbox.cleanup();
    }
  });

  it("overwrite replaces the iCloud version", async () => {
    const sandbox = await makeSandbox();
    try {
      await writeFile(path.join(sandbox.home, "Docs", "report.pdf"), "local");
      await writeFile(path.join(sandbox.icloud, "Docs", "report.pdf"), "icloud");

      await cli(sandbox.env, sandbox.home, ["Docs", "--on-conflict", "overwrite"]);

      assert.equal(
        await fs.readFile(path.join(sandbox.icloud, "Docs", "report.pdf"), "utf8"),
        "local",
      );
    } finally {
      await sandbox.cleanup();
    }
  });

  it("skip leaves iCloud alone and keeps the local copy in the backup", async () => {
    const sandbox = await makeSandbox();
    try {
      await writeFile(path.join(sandbox.home, "Docs", "report.pdf"), "local");
      await writeFile(path.join(sandbox.icloud, "Docs", "report.pdf"), "icloud");

      await cli(sandbox.env, sandbox.home, ["Docs", "--on-conflict", "skip"]);

      assert.equal(
        await fs.readFile(path.join(sandbox.icloud, "Docs", "report.pdf"), "utf8"),
        "icloud",
      );
      assert.equal(
        await fs.readFile(path.join(sandbox.home, "Docs.bak", "report.pdf"), "utf8"),
        "local",
      );
    } finally {
      await sandbox.cleanup();
    }
  });

  it("errors instead of hanging when conflicts need an answer non-interactively", async () => {
    const sandbox = await makeSandbox();
    try {
      await writeFile(path.join(sandbox.home, "Docs", "report.pdf"), "local");
      await writeFile(path.join(sandbox.icloud, "Docs", "report.pdf"), "icloud");

      const result = await cli(sandbox.env, sandbox.home, ["Docs"]);

      assert.equal(result.code, 1);
      assert.match(result.stdout, /--on-conflict/);
    } finally {
      await sandbox.cleanup();
    }
  });
});

describe("scenario K: --dry-run", () => {
  it("reports the same steps and leaves the filesystem byte-for-byte unchanged", async () => {
    const sandbox = await makeSandbox();
    try {
      await writeFile(path.join(sandbox.home, "Docs", "a.txt"), "one");
      await writeFile(path.join(sandbox.home, "Docs", "report.pdf"), "local");
      await writeFile(path.join(sandbox.icloud, "Docs", "report.pdf"), "icloud");

      const before = await snapshotTree(sandbox.home);
      const result = await cli(sandbox.env, sandbox.home, ["Docs", "--dry-run"]);
      const afterSnapshot = await snapshotTree(sandbox.home);

      assert.equal(result.code, 0, result.stderr);
      assert.deepEqual(afterSnapshot, before);

      assert.match(result.stdout, /Dry run — no changes will be made\./);
      assert.match(result.stdout, /Would back up/);
      assert.match(result.stdout, /Would create symlink/);
      assert.match(result.stdout, /Would copy 2 files, of which 1 conflict/);
      assert.match(result.stdout, /Re-run without --dry-run to apply\./);
      // The report-only path must not ask for a resolution.
      assert.doesNotMatch(result.stdout, /Resolve conflicts/);
    } finally {
      await sandbox.cleanup();
    }
  });

  it("previews a restore without performing it", async () => {
    const sandbox = await makeSandbox();
    try {
      await writeFile(path.join(sandbox.home, "Docs", "a.txt"), "one");
      await cli(sandbox.env, sandbox.home, ["Docs"]);

      const before = await snapshotTree(sandbox.home);
      const result = await cli(sandbox.env, sandbox.home, ["--restore", "Docs", "--dry-run"]);
      const afterSnapshot = await snapshotTree(sandbox.home);

      assert.equal(result.code, 0, result.stderr);
      assert.deepEqual(afterSnapshot, before);
      assert.match(result.stdout, /Would remove symlink/);
      assert.match(result.stdout, /Would restore/);
    } finally {
      await sandbox.cleanup();
    }
  });
});

describe("manifest-driven runs", () => {
  it("records synced entries and replays them on a second machine", async () => {
    const first = await makeSandbox();
    try {
      await writeFile(path.join(first.home, "Docs", "a.txt"), "one");
      await cli(first.env, first.home, ["Docs"]);

      const manifestFile = path.join(first.icloud, ".icloud-sync", "manifest.json");
      const manifest = JSON.parse(await fs.readFile(manifestFile, "utf8")) as {
        entries: Array<{ relativePath: string }>;
      };
      assert.deepEqual(
        manifest.entries.map((entry) => entry.relativePath),
        ["Docs"],
      );

      // Simulate a second Mac: same iCloud contents, no local copy.
      const second = await makeSandbox();
      try {
        await fs.cp(first.icloud, second.icloud, { recursive: true });
        const result = await cli(second.env, second.home, []);

        assert.equal(result.code, 0, result.stderr);
        assert.match(result.stdout, /Found 1 entry in the iCloud Drive manifest/);
        assert.ok((await fs.lstat(path.join(second.home, "Docs"))).isSymbolicLink());
        assert.equal(
          await fs.readFile(path.join(second.home, "Docs", "a.txt"), "utf8"),
          "one",
        );
      } finally {
        await second.cleanup();
      }
    } finally {
      await first.cleanup();
    }
  });

  it("says so when the manifest is empty", async () => {
    const sandbox = await makeSandbox();
    try {
      const result = await cli(sandbox.env, sandbox.home, []);
      assert.equal(result.code, 0);
      assert.match(result.stdout, /No entries in the iCloud Drive manifest yet/);
    } finally {
      await sandbox.cleanup();
    }
  });

  it("removes the entry on restore", async () => {
    const sandbox = await makeSandbox();
    try {
      await writeFile(path.join(sandbox.home, "Docs", "a.txt"), "one");
      await cli(sandbox.env, sandbox.home, ["Docs"]);
      await cli(sandbox.env, sandbox.home, ["--restore", "Docs"]);

      const manifest = JSON.parse(
        await fs.readFile(path.join(sandbox.icloud, ".icloud-sync", "manifest.json"), "utf8"),
      ) as { entries: unknown[] };
      assert.deepEqual(manifest.entries, []);
    } finally {
      await sandbox.cleanup();
    }
  });
});

describe("ad-hoc --source/--target", () => {
  it("links an explicit pair without recording it in the manifest", async () => {
    const sandbox = await makeSandbox();
    try {
      await writeFile(path.join(sandbox.home, "Stuff", "a.txt"), "one");
      const target = path.join(sandbox.icloud, "Elsewhere", "Stuff");

      const result = await cli(sandbox.env, sandbox.home, [
        "--source",
        "Stuff",
        "--target",
        target,
      ]);

      assert.equal(result.code, 0, result.stderr);
      assert.equal(await fs.readlink(path.join(sandbox.home, "Stuff")), target);
      assert.equal(await fs.readFile(path.join(target, "a.txt"), "utf8"), "one");

      const manifestExists = await fs
        .lstat(path.join(sandbox.icloud, ".icloud-sync", "manifest.json"))
        .then(
          () => true,
          () => false,
        );
      assert.equal(manifestExists, false);
    } finally {
      await sandbox.cleanup();
    }
  });
});

describe("argument handling", () => {
  const sandbox = useSandbox();

  it("prints help and version", async () => {
    const help = await cli(sandbox.env, sandbox.home, ["--help"]);
    assert.equal(help.code, 0);
    assert.match(help.stdout, /icloud-sync never needs sudo/);

    const version = await cli(sandbox.env, sandbox.home, ["--version"]);
    assert.equal(version.code, 0);
    assert.match(version.stdout, /^\d+\.\d+\.\d+/);
  });

  it("rejects unknown flags and bad strategies with usage", async () => {
    const unknown = await cli(sandbox.env, sandbox.home, ["--nope"]);
    assert.equal(unknown.code, 2);
    assert.match(unknown.stderr, /Unknown option/);

    const badStrategy = await cli(sandbox.env, sandbox.home, ["Docs", "--on-conflict", "wat"]);
    assert.equal(badStrategy.code, 2);
    assert.match(badStrategy.stderr, /--on-conflict expects/);
  });

  it("requires --source and --target together", async () => {
    const result = await cli(sandbox.env, sandbox.home, ["--source", "Stuff"]);
    assert.equal(result.code, 2);
    assert.match(result.stderr, /must be used together/);
  });
});
