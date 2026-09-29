// Run by process-hooks.test.ts in a child process — the only honest way to test
// what happens when a process crashes or is told to stop.

import { sentrinelBunMiddleware } from "../../src/bun";

const mode = process.argv[2];
const handler = sentrinelBunMiddleware(
  {
    serverUrl: process.env.SENTRINEL_URL!,
    appName: "hooks-child",
    env: "test",
    flushInterval: 1_000_000,
    requestLogging: { enabled: true },
    processHooks: { timeoutMs: 2_000 },
  },
  () => new Response("ok")
);

// Something buffered, so a flush has work to do.
await handler(new Request(`http://child.test/work?mode=${mode}`), null);

if (mode === "uncaught") {
  setTimeout(() => {
    throw new Error("kaboom");
  }, 5);
} else if (mode === "rejection") {
  void Promise.reject(new Error("nobody awaited this"));
  setInterval(() => {}, 1_000);
} else if (mode === "sigterm") {
  setInterval(() => {}, 1_000);
  console.log("ready");
} else if (mode === "exit") {
  // Nothing keeps the loop alive: beforeExit fires and flushes.
}
