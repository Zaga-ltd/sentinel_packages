// The last window on shutdown, and crashes.
//
// Buffers flush on a timer, so a SIGTERM — the normal end of every deploy —
// threw away up to a full interval of data, and an uncaught exception killed
// the process without a report. Each case runs a real child process, because
// "what does the process do next" is the thing under test.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";

let server: ReturnType<typeof Bun.serve>;
let posts: { path: string; body: any }[] = [];

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      posts.push({ path: new URL(req.url).pathname, body: await req.json() });
      return new Response("{}");
    },
  });
});
afterAll(() => server.stop(true));

const child = join(import.meta.dir, "fixtures", "process-hooks-child.ts");

function run(mode: string) {
  posts = [];
  return Bun.spawn([process.execPath, child, mode], {
    env: { ...process.env, NODE_ENV: "production", SENTRINEL_URL: `http://127.0.0.1:${server.port}` },
    stdout: "pipe",
    stderr: "pipe",
  });
}

const errorsSent = () => posts.filter((p) => p.path === "/api/ingest/errors").flatMap((p) => p.body.errors);
const requestsSent = () => posts.filter((p) => p.path === "/api/ingest/requests").flatMap((p) => p.body.requests);

describe("process hooks", () => {
  test("an uncaught exception is reported, flushed, and still exits 1", async () => {
    const proc = run("uncaught");
    const code = await proc.exited;
    const stderr = await new Response(proc.stderr).text();

    expect(code).toBe(1);
    // Printed as Node would have printed it.
    expect(stderr).toContain("kaboom");
    const [error] = errorsSent();
    expect(error.errorMessage).toBe("kaboom");
    expect(error.statusMessage).toBe("Uncaught exception");
    // The buffered request went out with it.
    expect(requestsSent()).toHaveLength(1);
  }, 15_000);

  test("an unhandled rejection is reported and exits 1, as Node's default does", async () => {
    const proc = run("rejection");
    const code = await proc.exited;
    expect(code).toBe(1);
    expect(errorsSent().map((e) => e.errorMessage)).toContain("nobody awaited this");
  }, 15_000);

  test("SIGTERM flushes what is buffered, then the process still ends", async () => {
    const proc = run("sigterm");
    const reader = proc.stdout.getReader();
    await reader.read(); // "ready"
    proc.kill("SIGTERM");
    await proc.exited;

    expect(proc.signalCode === "SIGTERM" || proc.exitCode === 143).toBe(true);
    expect(requestsSent()).toHaveLength(1);
  }, 15_000);

  test("a script that simply finishes flushes on the way out", async () => {
    const proc = run("exit");
    const code = await proc.exited;
    expect(code).toBe(0);
    expect(requestsSent()).toHaveLength(1);
  }, 15_000);
});
