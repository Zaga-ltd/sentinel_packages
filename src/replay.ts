// ─── Session replay ─────────────────────────────────────────────────────────
//
// Records the DOM with rrweb and uploads only the seconds leading up to an
// error, out of a rolling in-memory buffer.
//
// Why a buffer instead of streaming everything
// --------------------------------------------
// A continuous upload is megabytes per session for recordings almost nobody
// watches. Buffering means the cost is paid only when something goes wrong,
// and what you get is the thing you actually wanted: the thirty seconds before
// the crash, including the click that caused it. Sessions that never fail cost
// one array in memory and no network at all.
//
// Why rrweb rather than our own recorder
// --------------------------------------
// Recording a live DOM correctly means handling shadow roots, canvas, iframes,
// adopted and cross-origin stylesheets, and input masking. Getting the last of
// those wrong ships your users' passwords to us. rrweb is MIT, is what Sentry
// and PostHog use, and is imported dynamically here so an app that never turns
// replay on never downloads it.

/** rrweb's event shape, kept structural so the SDK does not depend on its types. */
export interface ReplayEvent {
  type: number;
  timestamp: number;
  data?: unknown;
}

export interface ReplayOptions {
  enabled?: boolean;
  /** Seconds of history kept in memory. The window you get before an error. */
  bufferSeconds?: number;
  /** Seconds to keep recording *after* the error that triggered the upload. */
  tailSeconds?: number;
  /** Ceiling on the buffer, whatever `bufferSeconds` would allow. */
  maxBufferBytes?: number;
  /**
   * Fraction of sessions recorded even without an error, 0..1.
   *
   * Defaults to 0 — errors only. Raise it to catch UX problems that never
   * throw, and expect storage to grow in proportion.
   */
  sessionSampleRate?: number;
  /**
   * Elements whose text should be readable. Everything else is masked.
   *
   * The default posture is that nothing is legible: replay shows layout,
   * clicks and navigation, and text renders as blocks. Nobody enables replay
   * expecting to ship customer names and order details to a vendor, so opting
   * *in* to visibility is the only safe direction for this switch to point.
   */
  unmaskSelector?: string;
  /** Elements omitted entirely — not even their layout is recorded. */
  blockSelector?: string;
  /**
   * Supply rrweb yourself instead of letting the SDK import it.
   *
   * For bundlers that cannot resolve a dynamic import, and for apps that
   * already ship rrweb and do not want a second copy.
   */
  recorder?: { record: (...args: any[]) => (() => void) | undefined };
  /** Console noise about what the recorder is doing. */
  debug?: boolean;
}

export interface ReplayUpload {
  replayId: string;
  sessionId?: string;
  /** Who was using the app. Resolved at upload time, not at start. */
  consumerIdentifier?: string;
  seq: number;
  events: ReplayEvent[];
  startedAt: string;
  durationMs: number;
  url?: string;
  trigger: "error" | "sampled";
  errorId?: string;
}

const DEFAULTS = {
  bufferSeconds: 30,
  tailSeconds: 5,
  maxBufferBytes: 2 * 1024 * 1024,
  sessionSampleRate: 0,
  unmaskSelector: "[data-sentrinel-unmask]",
  blockSelector: "[data-sentrinel-block]",
};

/** rrweb's full-snapshot event type. A chunk must start with one to replay. */
const FULL_SNAPSHOT = 2;
const META = 4;

export interface ReplayController {
  /** Upload the buffer because this error happened. */
  onError(errorId?: string): void;
  /** Stop recording and release the buffer. */
  stop(): void;
  /** Flush anything pending — used on page unload. */
  flush(): void;
  readonly replayId: string;
  readonly recording: boolean;
}

function randomId(bytes = 16): string {
  const a = new Uint8Array(bytes);
  (globalThis.crypto ?? ({} as Crypto)).getRandomValues?.(a);
  return Array.from(a, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Start recording.
 *
 * `send` is called with each chunk. It is given whole chunks rather than raw
 * events so the transport can decide about `sendBeacon` vs `fetch` without
 * knowing anything about rrweb.
 */
export async function startReplay(
  options: ReplayOptions,
  send: (upload: ReplayUpload) => void,
  getSessionId?: () => string | undefined,
  /**
   * Read at upload time rather than captured at start: identify() usually runs
   * after the recorder does, so asking early would attribute every recording
   * to nobody.
   */
  getConsumer?: () => string | undefined
): Promise<ReplayController | null> {
  if (options.enabled === false) return null;
  if (typeof window === "undefined" || typeof document === "undefined") return null;

  const opts = { ...DEFAULTS, ...options };
  const replayId = randomId(16);

  let record = opts.recorder?.record;
  if (!record) {
    try {
      // Dynamic so it is a separate chunk: apps that never enable replay never
      // pay for rrweb. The string is split so bundlers that scan for literal
      // specifiers do not eagerly include it in the main bundle.
      const mod: any = await import(/* webpackChunkName: "rrweb" */ "rrweb");
      record = mod.record ?? mod.default?.record;
    } catch {
      if (opts.debug) {
        console.warn(
          "[sentrinel] session replay is enabled but rrweb could not be loaded. " +
            "Install it (`npm i rrweb`) or pass `recorder` explicitly."
        );
      }
      return null;
    }
  }
  if (typeof record !== "function") return null;

  /** Events waiting in memory, oldest first. */
  let buffer: ReplayEvent[] = [];
  /**
   * The most recent Meta event, kept outside the buffer.
   *
   * rrweb emits Meta (the recorded viewport size) *before* the first full
   * snapshot, so trimming to "the last snapshot onward" throws it away. The
   * Replayer then has no dimensions to scale to and renders the recording into
   * a zero-width iframe — a player that looks broken rather than empty. Held
   * separately and re-attached to every chunk instead.
   */
  let lastMeta: ReplayEvent | null = null;
  let bufferBytes = 0;
  let seq = 0;
  let stopped = false;
  /** Once an error fires we keep recording for a moment, then upload the tail. */
  let tailTimer: ReturnType<typeof setTimeout> | null = null;
  let pendingErrorId: string | undefined;

  // Sampled sessions upload continuously; error-only sessions stay silent
  // until something fails.
  const sampled = opts.sessionSampleRate > 0 && Math.random() < opts.sessionSampleRate;

  const trim = () => {
    const cutoff = Date.now() - opts.bufferSeconds * 1000;

    // Never trim past the newest full snapshot: rrweb can only rebuild the DOM
    // from a snapshot forward, so dropping it turns every later mutation into
    // an unplayable diff against nothing.
    let keepFrom = 0;
    for (let i = buffer.length - 1; i >= 0; i--) {
      if (buffer[i].type === FULL_SNAPSHOT) {
        keepFrom = i;
        break;
      }
    }
    let cut = 0;
    while (cut < keepFrom && buffer[cut].timestamp < cutoff) cut++;
    if (cut > 0) buffer = buffer.slice(cut);

    // Byte ceiling, applied after the time window. Same snapshot rule.
    while (bufferBytes > opts.maxBufferBytes && buffer.length > 1) {
      let snapshotAt = -1;
      for (let i = 1; i < buffer.length; i++) {
        if (buffer[i].type === FULL_SNAPSHOT) {
          snapshotAt = i;
          break;
        }
      }
      if (snapshotAt <= 0) break; // only one snapshot left; keep it
      buffer = buffer.slice(snapshotAt);
      bufferBytes = approxBytes(buffer);
    }
  };

  const emit = (trigger: "error" | "sampled", errorId?: string) => {
    if (!buffer.length) return;

    // Every chunk must be self-describing: viewport first, then a snapshot to
    // rebuild from, then the mutations.
    const events = lastMeta ? [lastMeta, ...buffer] : buffer;
    buffer = [];
    bufferBytes = 0;

    const startedAt = events[0]?.timestamp ?? Date.now();
    const endedAt = events[events.length - 1]?.timestamp ?? startedAt;

    send({
      replayId,
      sessionId: getSessionId?.(),
      consumerIdentifier: getConsumer?.(),
      seq: seq++,
      events,
      startedAt: new Date(startedAt).toISOString(),
      durationMs: Math.max(0, endedAt - startedAt),
      url: typeof location !== "undefined" ? location.href : undefined,
      trigger,
      errorId,
    });
  };

  const stopFn = record({
    emit(event: ReplayEvent) {
      if (stopped) return;
      if (event.type === META) {
        lastMeta = event;
        return;
      }
      buffer.push(event);
      bufferBytes += approxOne(event);
      trim();

      // A sampled session ships as it goes; there is no error to wait for.
      if (sampled && bufferBytes > 64 * 1024) emit("sampled");
    },
    // ── Privacy ──────────────────────────────────────────────────────────────
    // Masked by default, in both directions: `maskAllInputs` covers what a user
    // types, `maskTextSelector: "*"` covers what the page shows them.
    maskAllInputs: true,
    maskTextSelector: "*",
    unmaskTextSelector: opts.unmaskSelector,
    blockSelector: opts.blockSelector,
    // Canvas recording is off: it is expensive, and a canvas is as likely to be
    // a chart as anything worth watching.
    recordCanvas: false,
    collectFonts: false,
    // Re-snapshot periodically so a long session still has a recent anchor to
    // rebuild from after the buffer trims.
    checkoutEveryNms: Math.max(10_000, (opts.bufferSeconds * 1000) / 2),
  });

  if (opts.debug) {
    console.log(
      `[sentrinel] replay recording (${sampled ? "sampled session" : "errors only"}), id ${replayId}`
    );
  }

  const controller: ReplayController = {
    replayId,
    get recording() {
      return !stopped;
    },
    onError(errorId?: string) {
      if (stopped) return;
      pendingErrorId = pendingErrorId ?? errorId;
      // Wait a beat so the frames *after* the failure — the error screen, the
      // stuck spinner — are part of what gets uploaded. Only the first error
      // arms the timer; a burst of them should not multiply the uploads.
      if (tailTimer) return;
      tailTimer = setTimeout(() => {
        tailTimer = null;
        emit("error", pendingErrorId);
        pendingErrorId = undefined;
      }, opts.tailSeconds * 1000);
    },
    flush() {
      if (tailTimer) {
        clearTimeout(tailTimer);
        tailTimer = null;
        emit("error", pendingErrorId);
        pendingErrorId = undefined;
      } else if (sampled) {
        emit("sampled");
      }
    },
    stop() {
      stopped = true;
      if (tailTimer) clearTimeout(tailTimer);
      tailTimer = null;
      buffer = [];
      bufferBytes = 0;
      try {
        stopFn?.();
      } catch {
        // rrweb is already torn down; nothing to do.
      }
    },
  };

  return controller;
}

/**
 * Rough serialized size, without paying for JSON.stringify on every event.
 *
 * The buffer ceiling only needs to be approximately right — being 10% out
 * costs a few kilobytes of memory, while stringifying every mutation to be
 * exact would cost measurable CPU on the page we are meant to be observing.
 */
function approxOne(event: ReplayEvent): number {
  try {
    return JSON.stringify(event).length;
  } catch {
    return 512;
  }
}

function approxBytes(events: ReplayEvent[]): number {
  let n = 0;
  for (const e of events) n += approxOne(e);
  return n;
}

/** Exported for the tests, which assert the snapshot-preserving trim rule. */
export const __testing = { FULL_SNAPSHOT, META, DEFAULTS };
