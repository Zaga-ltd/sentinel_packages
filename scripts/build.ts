// Build @sentrinel/plugin into dist/ — ESM, CommonJS and type declarations.
//
//   bun run packages/plugin/scripts/build.ts [outDir]
//
// Why a build at all: the package used to point `main`/`exports` at the
// TypeScript sources. Bun runs those; plain Node does not
// (ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING — Node refuses to strip types
// inside node_modules), so every Express and Next user on Node could not import
// it.
//
// Two decisions worth knowing before changing this:
//
//   * **ESM is bundled with code splitting.** Every entry (`.`, `./express`,
//     `./next`, …) must share ONE copy of the modules that hold process-wide
//     state — the trace context, the log sink, the custom-metric registry. Two
//     copies would mean `traceSpan` imported from the root never sees the
//     trace the Express middleware opened. Splitting puts shared modules in
//     shared chunks.
//
//   * **CommonJS is compiled file-for-file** by tsc rather than bundled, for
//     the same reason: bundled per entry, each CJS entry would carry its own
//     copies. `dist/cjs/package.json` marks the directory as CommonJS.
//
// Package imports (elysia, rrweb) stay external. The browser entry pulls in
// nothing node-only; tests/package.test.ts checks both properties on the built
// output.

import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const pkgDir = resolve(import.meta.dir, "..");
const outDir = resolve(process.argv[2] ?? join(pkgDir, "dist"));

export const ENTRIES = [
  "index",
  "elysia",
  "express",
  "next",
  "next-middleware",
  "bun",
  "browser",
  "tunnel",
  "flutter",
] as const;

/**
 * Entries that run outside Node: in a page, or on Next's Edge runtime. Built
 * on their own with `target: "browser"`, so no shared chunk — which carries
 * Bun's node runtime helpers (`createRequire` from `node:module`) — can reach
 * them. They hold no state shared with the server entries, so a separate copy
 * of what they import costs nothing.
 */
const WEB_ENTRIES = new Set<string>(["browser", "next-middleware"]);

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

// ─── ESM ──────────────────────────────────────────────────────────────────────
async function bundle(entries: string[], target: "node" | "browser", splitting: boolean): Promise<void> {
  const result = await Bun.build({
    entrypoints: entries.map((e) => join(pkgDir, "src", `${e}.ts`)),
    outdir: outDir,
    target,
    format: "esm",
    splitting,
    packages: "external",
    naming: { entry: "[name].js", chunk: "chunks/[name]-[hash].js" },
  });
  if (!result.success) {
    for (const log of result.logs) console.error(log);
    process.exit(1);
  }
}

await bundle(ENTRIES.filter((e) => !WEB_ENTRIES.has(e)), "node", true);
for (const entry of WEB_ENTRIES) await bundle([entry], "browser", false);

// ─── CommonJS and declarations, via tsc ──────────────────────────────────────
const tsc = Bun.resolveSync("typescript/bin/tsc", pkgDir);

function runTsc(args: string[]): void {
  const res = Bun.spawnSync([process.execPath, tsc, ...args], { cwd: pkgDir, stdout: "inherit", stderr: "inherit" });
  if (res.exitCode !== 0) process.exit(res.exitCode ?? 1);
}

const common = [
  "--target", "ES2020",
  "--lib", "ES2022,DOM,DOM.Iterable",
  "--types", "bun",
  "--skipLibCheck",
  "--strict",
  "--esModuleInterop",
  ...ENTRIES.map((e) => join(pkgDir, "src", `${e}.ts`)),
];

runTsc([
  ...common,
  "--module", "commonjs",
  "--moduleResolution", "node10",
  "--outDir", join(outDir, "cjs"),
]);
writeFileSync(join(outDir, "cjs", "package.json"), JSON.stringify({ type: "commonjs" }, null, 2) + "\n");

runTsc([
  ...common,
  "--module", "esnext",
  "--moduleResolution", "bundler",
  "--declaration",
  "--emitDeclarationOnly",
  "--outDir", join(outDir, "types"),
]);

// Declarations for an ESM package are read by `moduleResolution: node16`
// consumers too, which require explicit extensions on relative imports.
// `./x.js` resolves to `./x.d.ts` under every resolution mode.
function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}
for (const file of walk(join(outDir, "types"))) {
  if (!file.endsWith(".d.ts")) continue;
  const src = readFileSync(file, "utf8");
  const fixed = src.replace(
    /((?:from|import)\s*\(?\s*["'])(\.{1,2}\/[^"']+?)(["'])/g,
    (whole, pre: string, spec: string, post: string) =>
      /\.(js|mjs|cjs|json)$/.test(spec) ? whole : `${pre}${spec}.js${post}`
  );
  if (fixed !== src) writeFileSync(file, fixed);
}

console.log(`built @sentrinel/plugin → ${outDir}`);
