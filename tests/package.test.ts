// The published package, as plain Node sees it.
//
// The package used to point `main` and `exports` at TypeScript sources. Bun
// runs those; Node refuses to strip types inside node_modules
// (ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING), so every Express and Next user
// on Node could not import it — and the root entry imported `elysia`, an
// optional peer, so it failed without Elysia too. None of that shows up in a
// Bun test run, which is why this builds the package and asks Node.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const pkgDir = resolve(import.meta.dir, "..");
const node = Bun.which("node");
/** The build needs tsc — present in the monorepo, not in the public mirror. */
const hasTsc = (() => {
  try {
    Bun.resolveSync("typescript/bin/tsc", pkgDir);
    return true;
  } catch {
    return false;
  }
})();
const run = node && hasTsc ? describe : describe.skip;

let root: string;
let appDir: string;

beforeAll(() => {
  if (!node || !hasTsc) return;
  root = mkdtempSync(join(tmpdir(), "sentrinel-pkg-"));
  const installed = join(root, "app", "node_modules", "@sentrinel", "plugin");
  mkdirSync(installed, { recursive: true });
  const build = Bun.spawnSync([process.execPath, join(pkgDir, "scripts", "build.ts"), join(installed, "dist")], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (build.exitCode !== 0) throw new Error(`build failed: ${build.stderr.toString()}`);
  cpSync(join(pkgDir, "package.json"), join(installed, "package.json"));
  cpSync(join(pkgDir, "src"), join(installed, "src"), { recursive: true });
  appDir = join(root, "app");
  writeFileSync(join(appDir, "package.json"), JSON.stringify({ name: "app", private: true }));
}, 60_000);

afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

const ENTRIES = ["", "/elysia", "/express", "/next", "/next/middleware", "/bun", "/browser", "/tunnel", "/flutter"];

function nodeEval(code: string, type: "module" | "commonjs") {
  const res = Bun.spawnSync(
    [node!, "--input-type", type, "-e", code],
    { cwd: appDir, stdout: "pipe", stderr: "pipe", env: { ...process.env, NODE_OPTIONS: "" } }
  );
  return { code: res.exitCode, out: res.stdout.toString(), err: res.stderr.toString() };
}

run("the built package in plain Node", () => {
  test("every entry imports as ESM, with no elysia installed", () => {
    const code = `for (const e of ${JSON.stringify(ENTRIES)}) await import("@sentrinel/plugin" + e); console.log("ok")`;
    const res = nodeEval(code, "module");
    expect(res.err).toBe("");
    expect(res.out.trim()).toBe("ok");
  });

  test("every entry loads with require()", () => {
    const code = `for (const e of ${JSON.stringify(ENTRIES)}) require("@sentrinel/plugin" + e); console.log("ok")`;
    const res = nodeEval(code, "commonjs");
    expect(res.err).toBe("");
    expect(res.out.trim()).toBe("ok");
  });

  test("entries share one copy of process-wide state", () => {
    // Two copies of the tracer would mean traceSpan() from the root never
    // sees the trace the Express middleware opened.
    const code = `
      const root = await import("@sentrinel/plugin");
      const express = await import("@sentrinel/plugin/express");
      const bun = await import("@sentrinel/plugin/bun");
      console.log(root.sentrinelExpressMiddleware === express.sentrinelExpressMiddleware &&
        root.sentrinelBunMiddleware === bun.sentrinelBunMiddleware);`;
    expect(nodeEval(code, "module").out.trim()).toBe("true");
  });

  test("the browser and Edge entries reach nothing node-only", () => {
    const dist = join(appDir, "node_modules", "@sentrinel", "plugin", "dist");
    for (const file of ["browser.js", "next-middleware.js"]) {
      const text = readFileSync(join(dist, file), "utf8");
      expect(text).not.toMatch(/from\s*["']node:/);
      expect(text).not.toMatch(/from\s*["']\.\/chunks\//);
    }
  });
});
