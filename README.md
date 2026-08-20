# icloud-sync

Symlink directories in `$HOME` into iCloud Drive so they sync across machines,
with a safe backup of whatever was there before.

macOS only. Requires `node` at runtime. Never needs `sudo`.

```
icloud-sync Downloads
```

```
Removing deny-delete ACL from ~/Downloads... Done.
Backing up ~/Downloads to ~/Downloads.bak (hidden)... Done.
Creating iCloud Drive/Downloads... Done.
Creating symlink: ~/Downloads → iCloud Drive/Downloads... Done.
Copying 34 files... Done.

✓ ~/Downloads is now synced to iCloud Drive/Downloads.
  The original is kept at ~/Downloads.bak (hidden). Remove it when you are happy:
    rm -rf ~/Downloads.bak
```

## Install

```
brew install kylerjensen/tap/icloud-sync
```

Installing does **not** link anything — see [Why installing doesn't do the
linking](#why-installing-doesnt-do-the-linking).

## Commands

| Command | What it does |
| --- | --- |
| `icloud-sync <Name>` | Sync a path. The name resolves relative to the current directory, case-insensitively, so nested paths work too. |
| `icloud-sync` | Read the manifest from iCloud and offer past entries as a checkbox list. This is how a second Mac gets set up. |
| `icloud-sync --restore <Name>` | Remove the symlink, rename the `.bak` back, clear the hidden flag. The iCloud copy is left alone. |
| `icloud-sync --source <path> --target <path>` | Link an ad-hoc pair. Not recorded in the manifest. |

Options:

| Option | Effect |
| --- | --- |
| `-n`, `--dry-run` | Full read-only analysis, phrased as "would". Touches nothing. |
| `--verbose` | Sizes, item counts, and the full file list. |
| `-y`, `--yes` | Pre-answer the outside-`$HOME` confirmation. |
| `--on-conflict <strategy>` | `keep-both` (default), `overwrite`, or `skip`. |
| `-h`, `--help` / `-v`, `--version` | The usual. |

## What a sync actually does

1. **Preflight**, read-only: resolve the real on-disk casing on both sides,
   check ownership, refuse to run as root, refuse to touch a symlink it did not
   create, confirm if the resolved path is outside `$HOME`.
2. **Inspect the local path.** Already a correct symlink → report success and
   change nothing. Points somewhere else → error. A real directory or file →
   strip the deny-delete ACL if present, rename to `<Name>.bak`, `chflags
   hidden`. Missing → nothing to back up.
3. **Create the iCloud destination** if it does not exist.
4. **Create the symlink.**
5. **Copy the backup's contents up into iCloud**, prompting once if there are
   conflicts.
6. **Record it in the manifest** at `<iCloud>/.icloud-sync/manifest.json`.
7. **Leave `<Name>.bak` in place** and print the `rm -rf` command.

There is no upfront "Proceed?" gate, because every step is non-destructive on
its own: the original is renamed and hidden, never deleted, and nothing in
iCloud is overwritten without an explicit answer. The only two prompts are the
outside-`$HOME` confirmation and conflict resolution.

The symlink is created *before* the copy, so the copy writes through it and
there is never a window where `<Name>` does not exist. The tradeoff is that
there is no clean mid-flight abort, which is why conflict resolution has no
Cancel.

## Conflicts

A conflict is a path present in both the local backup and iCloud with differing
contents. Identical files are skipped silently (compared by size first, then
SHA-256). All conflicts are collected before any writes, tabled together, and
answered with a single prompt:

- **Keep both** (default) — the iCloud version stays and the local version is
  written alongside it Finder-style: `report.pdf` → `report (2).pdf`,
  incrementing. Extensions are preserved.
- **Overwrite** — the local version replaces the iCloud one.
- **Skip** — iCloud is untouched and the local version stays in the hidden
  `.bak`, where `--restore` can still reach it.

## Naming and casing

- A *directory* colliding with an existing `<Name>.bak` merges into it rather
  than nesting. A *file* collision increments: `.bak.1`, `.bak.2`.
- Casing for a new iCloud copy: existing iCloud → existing local → as typed.
- Casing for a new local symlink: existing local → existing iCloud → as typed.
- When the two sides disagree on casing, the resolution is echoed on the first
  line. Silently picking one looks like a bug.

## Non-TTY behavior

`NO_COLOR` is honored. When stdout is not a TTY, output degrades to plain lines
and any prompt that would block becomes an error pointing at the flag that
answers it (`--yes`, or `--on-conflict <strategy>`) rather than hanging.

## Two things worth knowing

### Why installing doesn't do the linking

`brew install` cannot create these symlinks. Homebrew runs `install` and
`post_install` inside a macOS Seatbelt sandbox whose profile ends with
`(deny file-write*)`, and `$HOME` is not on the allowlist. There is no opt-out
for the macOS formula sandbox. So the linking has to be a command you run after
installing, which is what this CLI is.

### Why you don't need sudo

If you have ever tried `mv ~/Downloads ~/Downloads.bak` and watched it fail with
"Operation not permitted", the cause is an inherited ACL:

```
0: group:everyone deny delete
```

That entry blocks renaming *the directory itself*. It looks like a permissions
problem that needs elevation, but it isn't — as the owner you can strip it
unelevated:

```
chmod -a# 0 ~/Downloads
```

`icloud-sync` does this itself and reports it as a step. It also **refuses to
run as root**, because root-owned files in your home directory break later
unelevated operations. If a previous `sudo` run already left root-owned files
behind, preflight detects it and prints the exact `chown` command to fix it.

## Notes on the implementation

- iCloud Drive lives at `~/Library/Mobile Documents/com~apple~CloudDocs` — with
  tildes. The dotted `com.apple.CloudDocs` form does not exist.
- The copy engine is written in TypeScript rather than shelling out. macOS ships
  `openrsync`, which advertises rsync 2.6.9 compatibility but silently ignores
  `--backup`/`--suffix` and skips same-size files, leaving conflicts unmerged
  with no backup. `ditto` merges but silently overwrites.
- Both `$HOME` and iCloud Drive are APFS case-insensitive but case-preserving,
  so `fs.stat` succeeds on the wrong casing while the directory listing shows
  something else. Anything that lands in a symlink target or a printed path
  comes from the listing, not from user input.
- Symlinked ancestors are resolved, because `/tmp` and `/var` are symlinks into
  `/private` on macOS and an unresolved path would compare as being outside
  `$HOME` when it isn't.
- Analysis and execution are separate. The read-only analysis pass decides
  everything that will happen and produces the step list; `--dry-run` renders it
  and stops. Both output modes read their labels from the same place, so dry-run
  output cannot drift from real behavior.

## Development

```
pnpm install
pnpm run typecheck
pnpm test
pnpm run build      # bundles to dist/icloud-sync.js
```

The build produces one self-contained file so the Homebrew formula needs only
`node` at runtime, with no `node_modules` install.

## License

MIT
