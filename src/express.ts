// ─── Sentrinel Express.js Middleware — `@sentrinel/plugin/express` ───────────
//
//   app.use(sentrinelExpressMiddleware({ ... }));   // first, before routes
//   app.use(routes);
//   app.use(sentrinelErrorHandler());               // after routes, before your own error handlers
//
// Two things the previous version got wrong, and why the shape is what it is:
//
//   * **Thrown errors were never captured.** It wrapped `next` in a local
//     variable, but Express does not route errors through the `next` a
//     middleware was given — it walks its own stack to the next *error*
//     middleware. The only place an Express app hands over a thrown error is a
//     four-argument error middleware, so that is what `sentrinelErrorHandler`
//     is. Without it errors are still recorded from their status, just without
//     a stack trace.
//
//   * **The route was read before routing.** `req.route` does not exist until
//     a route has matched, so reading it on entry always fell back to the raw
//     URL. Everything is now read on `finish`, when routing is over.
//
// The rest of the chain runs inside the request's trace context, so
// `traceSpan()` and `getLogger()` inside handlers attach to this request.

import { isCapturableBody } from "./body";
import {
  createServerInstrumentation,
  errorShape,
  flattenNodeHeaders,
  nodeHeaderGetter,
  type CapturedBody,
} from "./core";
import { captureNodeResponse, headerString, onResponseDone, type NodeResponseLike } from "./node-response";
import type { SentrinelPluginOptions } from "./types";

// Structural types — no `import type from "express"` needed.
interface Request {
  headers: Record<string, string | string[] | undefined>;
  method?: string;
  path?: string;
  url?: string;
  originalUrl?: string;
  baseUrl?: string;
  route?: { path?: string | RegExp | (string | RegExp)[] };
  query?: unknown;
  body?: unknown;
}
interface Response extends NodeResponseLike {
  setHeader(name: string, value: string): void;
}
type NextFunction = (err?: unknown) => void;

/** Errors handed to `sentrinelErrorHandler`, keyed by the request they belong to. */
const thrownErrors = new WeakMap<object, unknown>();

/**
 * Express error middleware that records the thrown error, then passes it on.
 *
 * Add it after your routes and before any error handler of your own that
 * sends a response — a handler that responds without calling `next(err)`
 * stops the chain before this runs. It never responds itself.
 */
export function sentrinelErrorHandler() {
  // Four parameters, exactly: Express tells error middleware apart by arity.
  return function sentrinelErrorHandler(err: unknown, req: Request, _res: Response, next: NextFunction) {
    try {
      if (req && typeof req === "object") thrownErrors.set(req, err);
    } catch {
      // Recording must never be the thing that fails.
    }
    next(err);
  };
}

/**
 * The matched route, with the mount path of any router it lives in.
 *
 * `req.baseUrl + req.route.path` is right while the request is inside its
 * router — but when an error leaves the router, Express restores `baseUrl` to
 * the parent's before the error middleware runs, so by `finish` an errored
 * `/api/boom/:id` reads as `/boom/:id`. The mount prefix is then rebuilt from
 * the URL: whatever precedes the segments the route pattern matched.
 */
export function expressRoute(req: Request): string | undefined {
  const pattern = req.route?.path;
  if (typeof pattern !== "string") return undefined;
  const base = req.baseUrl || "";
  const pathname = (req.originalUrl || req.url || "").split("?")[0];
  if (base && pathname.startsWith(base)) return `${base}${pattern === "/" ? "" : pattern}` || "/";

  // Only plain `/segment/:param` patterns can be counted segment for segment.
  if (!/[*?()+[\]]/.test(pattern)) {
    const n = pattern.split("/").filter(Boolean).length;
    const segments = pathname.split("/").filter(Boolean);
    if (segments.length >= n) {
      const prefix = segments.slice(0, segments.length - n);
      const route = `${prefix.length ? `/${prefix.join("/")}` : ""}${pattern === "/" ? "" : pattern}`;
      return route || "/";
    }
  }
  return `${base}${pattern}` || undefined;
}

/** A parsed `req.body` (from body-parser, multer, …) as a capturable body. */
export function parsedNodeBody(
  body: unknown,
  contentType: string | null | undefined,
  maxBodySize: number
): CapturedBody | undefined {
  if (body === undefined || body === null) return undefined;
  if (Buffer.isBuffer(body)) {
    // express.raw(): bytes. Only text types are worth reading.
    if (!isCapturableBody(contentType)) return undefined;
    return {
      text: body.subarray(0, maxBodySize).toString("utf8"),
      truncated: body.length > maxBodySize,
      totalBytes: body.length,
      contentType,
    };
  }
  return { value: body, contentType };
}

export function sentrinelExpressMiddleware(options: SentrinelPluginOptions) {
  const core = createServerInstrumentation(options, "Express middleware");
  const logResponseBody = !!(options.requestLogging?.enabled && options.requestLogging.logResponseBody);

  const middleware = function sentrinelMiddleware(req: Request, res: Response, next: NextFunction) {
    let url: URL;
    try {
      url = new URL(req.originalUrl || req.url || "/", "http://localhost");
    } catch {
      return next();
    }

    if (core.isExcludedPath(url.pathname)) return next();
    if (options.excludeRequest) {
      try {
        const host = headerString(req.headers.host) ?? "localhost";
        const webRequest = new Request(`http://${host}${url.pathname}${url.search}`, {
          method: req.method || "GET",
          headers: flattenNodeHeaders(req.headers),
        });
        if (options.excludeRequest(webRequest)) return next();
      } catch {
        // A predicate that throws excludes nothing.
      }
    }

    const headerOf = nodeHeaderGetter(req.headers);
    const state = core.begin(req.method || "GET", url, headerOf);

    try {
      if (!res.headersSent) {
        res.setHeader("traceparent", `00-${state.trace.traceId}-${state.trace.rootSpanId}-01`);
        res.setHeader("x-trace-id", state.trace.traceId);
      }
    } catch {}

    const capture = captureNodeResponse(res, { logBody: logResponseBody, maxBodySize: core.maxBodySize });

    onResponseDone(res, (aborted) => {
      try {
        const thrown = thrownErrors.get(req);
        // Read now, after routing: `route.path` only exists once a route has
        // matched.
        const route = expressRoute(req);

        let consumer: any = null;
        if (typeof options.consumerIdentifier === "function") {
          try {
            consumer = options.consumerIdentifier({ request: req, req, res });
          } catch {}
        } else {
          consumer = core.consumerFromHeader(headerOf);
        }

        const declared = parseInt(headerString(res.getHeader("content-length")) || "0", 10) || 0;
        core.finish(state, {
          // A client that hung up before the response finished: 499, the
          // convention for "client closed request", rather than a status
          // nobody sent.
          statusCode: aborted ? 499 : res.statusCode || 200,
          route,
          error: thrown !== undefined ? errorShape(thrown) : undefined,
          consumer,
          requestSize: parseInt(headerOf("content-length") || "0", 10) || 0,
          responseSize: capture.written() || declared,
          requestHeaders: () => flattenNodeHeaders(req.headers),
          requestBody: parsedNodeBody(req.body, headerOf("content-type"), core.maxBodySize),
          responseBody: capture.body(),
        });
      } catch (err) {
        if (options.debug) console.error("[sentrinel] Error recording Express request:", err);
      }
    });

    // The rest of the chain — every later middleware and the route handler —
    // runs inside this request's scopes. Express calls them synchronously from
    // `next()`, so their async work inherits the context.
    core.run(state, () => next());
  };

  return Object.assign(middleware, {
    /** The error middleware to add after your routes — see sentrinelErrorHandler. */
    errorHandler: sentrinelErrorHandler(),
    /** Send what is buffered now. */
    flush: () => core.flush(),
    /** Final flush and stop the timer — for your own shutdown handler. */
    stop: () => core.stop(),
  });
}
