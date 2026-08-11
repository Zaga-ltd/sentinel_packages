// The rolling buffer is the whole feature, and its one rule is easy to break:
// a chunk that does not begin with a full snapshot cannot be played back at
// all. rrweb rebuilds the DOM forward from a snapshot, so trimming past the
// last one turns every later mutation into a diff against nothing — and the
// failure is silent until someone opens the recording.

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { startReplay, type ReplayEvent, type ReplayUpload } from "../src/replay";

const FULL_SNAPSHOT = 2;
const INCREMENTAL = 3;
const META = 4;

/** A stand-in for rrweb: hands us its emit callback so tests can drive it. */
function fakeRecorder() {
  let emit: ((e: ReplayEvent) => void) | null = null;
  let stopped = false;
  return {
    record(opts: any) {
      emit = opts.emit;
      return () => {
        stopped = true;
      };
    },
    fire(event: ReplayEvent) {
      emit?.(event);
    },
    get options() {
      return capturedOptions;
    },
    get stopped() {
      return stopped;
    },
  };
}

let capturedOptions: any = null;

function recorderCapturingOptions() {
  let emit: ((e: ReplayEvent) => void) | null = null;
  return {
    record(opts: any) {
      capturedOptions = opts;
      emit = opts.emit;
      return () => {};
    },
    fire(e: ReplayEvent) {
      emit?.(e);
    },
  };
}

const ev = (type: number, timestamp: number): ReplayEvent => ({ type, timestamp, data: {} });

let uploads: ReplayUpload[];

beforeEach(() => {
  uploads = [];
  capturedOptions = null;
  // startReplay bails without a DOM.
  (globalThis as any).window = (globalThis as any).window ?? {};
  (globalThis as any).document = (globalThis as any).document ?? {};
});

afterEach(() => {
  capturedOptions = null;
});

async function start(opts: any = {}) {
  const rec = opts.recorder ?? fakeRecorder();
  const controller = await startReplay(
    { enabled: true, tailSeconds: 0, ...opts, recorder: rec },
    (u) => uploads.push(u),
    () => "session-abc"
  );
  return { controller: controller!, rec: rec as any };
}

describe("nothing is uploaded without a reason", () => {
  test("a healthy session sends nothing at all", async () => {
    const { rec } = await start();
    rec.fire(ev(FULL_SNAPSHOT, Date.now()));
    rec.fire(ev(INCREMENTAL, Date.now() + 100));
    await Bun.sleep(20);
    expect(uploads).toHaveLength(0);
  });

  test("an error uploads what was buffered, tagged as an error", async () => {
    const { controller, rec } = await start();
    rec.fire(ev(FULL_SNAPSHOT, Date.now()));
    rec.fire(ev(INCREMENTAL, Date.now() + 100));

    controller.onError("TypeError: x is not a function");
    await Bun.sleep(30);

    expect(uploads).toHaveLength(1);
    expect(uploads[0].trigger).toBe("error");
    expect(uploads[0].errorId).toBe("TypeError: x is not a function");
    expect(uploads[0].sessionId).toBe("session-abc");
    expect(uploads[0].events.length).toBe(2);
  });

  test("a burst of errors produces one upload, not one each", async () => {
    const { controller, rec } = await start({ tailSeconds: 0.05 });
    rec.fire(ev(FULL_SNAPSHOT, Date.now()));

    controller.onError("first");
    controller.onError("second");
    controller.onError("third");
    await Bun.sleep(120);

    expect(uploads).toHaveLength(1);
    // The first error is the one that armed the timer, so it is the one named.
    expect(uploads[0].errorId).toBe("first");
  });
});

describe("the buffer never trims away its snapshot", () => {
  test("old events are dropped but the snapshot they depend on is kept", async () => {
    const { controller, rec } = await start({ bufferSeconds: 1 });
    const old = Date.now() - 60_000;

    // A snapshot far outside the window, then recent mutations that need it.
    rec.fire(ev(FULL_SNAPSHOT, old));
    rec.fire(ev(INCREMENTAL, old + 10));
    rec.fire(ev(INCREMENTAL, Date.now()));

    controller.onError();
    await Bun.sleep(30);

    expect(uploads).toHaveLength(1);
    // Whatever else was dropped, the chunk still starts with a snapshot —
    // without it the recording is unplayable.
    expect(uploads[0].events[0].type).toBe(FULL_SNAPSHOT);
  });

  test("a newer snapshot lets everything before it go", async () => {
    const { controller, rec } = await start({ bufferSeconds: 1 });
    const old = Date.now() - 60_000;

    rec.fire(ev(FULL_SNAPSHOT, old));
    rec.fire(ev(INCREMENTAL, old + 10));
    rec.fire(ev(FULL_SNAPSHOT, Date.now()));
    rec.fire(ev(INCREMENTAL, Date.now() + 5));

    controller.onError();
    await Bun.sleep(30);

    const events = uploads[0].events;
    expect(events[0].type).toBe(FULL_SNAPSHOT);
    // The stale snapshot and its mutation are gone; only the recent pair remain.
    expect(events).toHaveLength(2);
    expect(events[0].timestamp).toBeGreaterThan(old + 1000);
  });
});

describe("the viewport survives trimming", () => {
  // rrweb emits Meta before the first snapshot, so "keep from the last
  // snapshot" drops it. Without it the Replayer has no dimensions and renders
  // the recording into a zero-width iframe — a player that looks broken.
  test("every chunk begins with the meta event", async () => {
    const { controller, rec } = await start({ bufferSeconds: 1 });
    const old = Date.now() - 60_000;

    rec.fire(ev(META, old));
    rec.fire(ev(FULL_SNAPSHOT, old + 1));
    rec.fire(ev(INCREMENTAL, Date.now()));

    controller.onError();
    await Bun.sleep(30);

    const events = uploads[0].events;
    expect(events[0].type).toBe(META);
    expect(events[1].type).toBe(FULL_SNAPSHOT);
  });

  test("a later chunk still carries the viewport", async () => {
    const { controller, rec } = await start({ bufferSeconds: 1, tailSeconds: 0 });

    rec.fire(ev(META, Date.now()));
    rec.fire(ev(FULL_SNAPSHOT, Date.now()));
    controller.onError();
    await Bun.sleep(20);

    // Second chunk, long after the meta event was emitted.
    rec.fire(ev(INCREMENTAL, Date.now()));
    controller.onError();
    await Bun.sleep(20);

    expect(uploads).toHaveLength(2);
    expect(uploads[1].events[0].type).toBe(META);
  });
});

describe("privacy defaults", () => {
  test("text and inputs are masked unless explicitly opted out", async () => {
    await start({ recorder: recorderCapturingOptions() });

    expect(capturedOptions.maskAllInputs).toBe(true);
    // "*" is the point: the default is that nothing on the page is legible.
    expect(capturedOptions.maskTextSelector).toBe("*");
    expect(capturedOptions.unmaskTextSelector).toBe("[data-sentrinel-unmask]");
  });

  test("the unmask selector is configurable, and masking stays on", async () => {
    await start({ recorder: recorderCapturingOptions(), unmaskSelector: ".safe" });
    expect(capturedOptions.unmaskTextSelector).toBe(".safe");
    expect(capturedOptions.maskAllInputs).toBe(true);
  });
});

describe("lifecycle", () => {
  test("stop() releases the buffer and sends nothing", async () => {
    const { controller, rec } = await start();
    rec.fire(ev(FULL_SNAPSHOT, Date.now()));
    controller.stop();

    controller.onError("too late");
    await Bun.sleep(30);

    expect(uploads).toHaveLength(0);
    expect(controller.recording).toBe(false);
  });

  test("flush() sends a pending error chunk immediately", async () => {
    const { controller, rec } = await start({ tailSeconds: 60 });
    rec.fire(ev(FULL_SNAPSHOT, Date.now()));

    controller.onError("unloading");
    expect(uploads).toHaveLength(0); // still waiting for the tail

    controller.flush();
    expect(uploads).toHaveLength(1);
    expect(uploads[0].errorId).toBe("unloading");
  });

  test("disabled means no recorder at all", async () => {
    const controller = await startReplay({ enabled: false }, (u) => uploads.push(u));
    expect(controller).toBeNull();
  });
});
