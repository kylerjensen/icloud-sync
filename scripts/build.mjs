import { chmod } from "node:fs/promises";
import { build } from "esbuild";

// `.mjs`, not `.js`: the bundle is ESM, and a bare `.js` is only treated as ESM
// when the nearest package.json says `"type": "module"`. The extracted release
// tarball happens to include one, but anything that relocates the bundle on its
// own — a Homebrew `libexec`, a manual copy — would break with
// "Cannot use import statement outside a module". `.mjs` is unambiguous.
const outfile = "dist/icloud-sync.mjs";

/**
 * Bundle to a single self-contained file so the Homebrew formula needs only
 * `node` at runtime — no `node_modules` install on the user's machine.
 *
 * Uses esbuild's JS API rather than its CLI: the CLI is a native binary
 * installed by a postinstall script, and the package-manager shim that wraps it
 * is not reliably regenerated afterward.
 */
await build({
  entryPoints: ["src/cli.ts"],
  bundle: true,
  platform: "node",
  target: "node20",
  format: "esm",
  outfile,
  banner: {
    // Some transitive dependencies are CommonJS and call `require()` at runtime,
    // which an ESM bundle has no definition for. Provide the real one.
    js: [
      "#!/usr/bin/env node",
      'import { createRequire as __nodeCreateRequire } from "node:module";',
      "const require = __nodeCreateRequire(import.meta.url);",
    ].join("\n"),
  },
  legalComments: "none",
});

await chmod(outfile, 0o755);
process.stdout.write(`Bundled ${outfile}\n`);
