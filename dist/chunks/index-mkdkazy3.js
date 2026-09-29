import {
  createServerInstrumentation,
  errorShape,
  flattenNodeHeaders,
  isCapturableBody,
  nodeHeaderGetter
} from "./index-6sz14kdp.js";

// src/node-response.ts
var ERROR_BODY_BYTES = 8 * 1024;
function headerString(value) {
  if (value === undefined || value === null)
    return null;
  return Array.isArray(value) ? String(value[0]) : String(value);
}
function toBuffer(chunk, encoding) {
  if (chunk === undefined || chunk === null || typeof chunk === "function")
    return;
  if (typeof chunk === "string") {
    return Buffer.from(chunk, typeof encoding === "string" ? encoding : "utf8");
  }
  if (Buffer.isBuffer(chunk))
    return chunk;
  if (ArrayBuffer.isView(chunk))
    return Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  return;
}
function decodeChunks(chunks) {
  const total = chunks.reduce((n, c) => n + c.byteLength, 0);
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    joined.set(c, offset);
    offset += c.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: false }).decode(joined);
}
function captureNodeResponse(res, opts) {
  const chunks = [];
  let captured = 0;
  let truncated = false;
  let written = 0;
  const capture = (chunk, encoding) => {
    const buf = toBuffer(chunk, encoding);
    if (!buf)
      return;
    written += buf.length;
    if (truncated)
      return;
    const status = res.statusCode ?? 200;
    if (!opts.logBody && status < 400)
      return;
    if (!isCapturableBody(headerString(res.getHeader("content-type")), headerString(res.getHeader("content-encoding")))) {
      return;
    }
    const limit = opts.logBody ? opts.maxBodySize : ERROR_BODY_BYTES;
    const room = limit - captured;
    if (room <= 0) {
      truncated = true;
      return;
    }
    const piece = buf.length > room ? buf.subarray(0, room) : buf;
    chunks.push(new Uint8Array(piece));
    captured += piece.length;
    if (buf.length > room)
      truncated = true;
  };
  const originalWrite = res.write;
  const originalEnd = res.end;
  res.write = function(chunk, encoding, ...rest) {
    try {
      capture(chunk, encoding);
    } catch {}
    return originalWrite.call(this, chunk, encoding, ...rest);
  };
  res.end = function(chunk, encoding, ...rest) {
    try {
      capture(chunk, encoding);
    } catch {}
    return originalEnd.call(this, chunk, encoding, ...rest);
  };
  return {
    written: () => written,
    body: () => {
      if (!chunks.length)
        return;
      const declared = parseInt(headerString(res.getHeader("content-length")) || "0", 10) || 0;
      return {
        text: decodeChunks(chunks),
        truncated,
        totalBytes: truncated ? written || declared || undefined : undefined,
        contentType: headerString(res.getHeader("content-type"))
      };
    }
  };
}
function onResponseDone(res, record) {
  let done = false;
  const once = (aborted) => {
    if (done)
      return;
    done = true;
    record(aborted);
  };
  res.once("finish", () => once(false));
  res.once("close", () => once(!res.writableFinished));
}

// src/express.ts
var thrownErrors = new WeakMap;
function sentrinelErrorHandler() {
  return function sentrinelErrorHandler2(err, req, _res, next) {
    try {
      if (req && typeof req === "object")
        thrownErrors.set(req, err);
    } catch {}
    next(err);
  };
}
function expressRoute(req) {
  const pattern = req.route?.path;
  if (typeof pattern !== "string")
    return;
  const base = req.baseUrl || "";
  const pathname = (req.originalUrl || req.url || "").split("?")[0];
  if (base && pathname.startsWith(base))
    return `${base}${pattern === "/" ? "" : pattern}` || "/";
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
function parsedNodeBody(body, contentType, maxBodySize) {
  if (body === undefined || body === null)
    return;
  if (Buffer.isBuffer(body)) {
    if (!isCapturableBody(contentType))
      return;
    return {
      text: body.subarray(0, maxBodySize).toString("utf8"),
      truncated: body.length > maxBodySize,
      totalBytes: body.length,
      contentType
    };
  }
  return { value: body, contentType };
}
function sentrinelExpressMiddleware(options) {
  const core = createServerInstrumentation(options, "Express middleware");
  const logResponseBody = !!(options.requestLogging?.enabled && options.requestLogging.logResponseBody);
  const middleware = function sentrinelMiddleware(req, res, next) {
    let url;
    try {
      url = new URL(req.originalUrl || req.url || "/", "http://localhost");
    } catch {
      return next();
    }
    if (core.isExcludedPath(url.pathname))
      return next();
    if (options.excludeRequest) {
      try {
        const host = headerString(req.headers.host) ?? "localhost";
        const webRequest = new Request(`http://${host}${url.pathname}${url.search}`, {
          method: req.method || "GET",
          headers: flattenNodeHeaders(req.headers)
        });
        if (options.excludeRequest(webRequest))
          return next();
      } catch {}
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
        const route = expressRoute(req);
        let consumer = null;
        if (typeof options.consumerIdentifier === "function") {
          try {
            consumer = options.consumerIdentifier({ request: req, req, res });
          } catch {}
        } else {
          consumer = core.consumerFromHeader(headerOf);
        }
        const declared = parseInt(headerString(res.getHeader("content-length")) || "0", 10) || 0;
        core.finish(state, {
          statusCode: aborted ? 499 : res.statusCode || 200,
          route,
          error: thrown !== undefined ? errorShape(thrown) : undefined,
          consumer,
          requestSize: parseInt(headerOf("content-length") || "0", 10) || 0,
          responseSize: capture.written() || declared,
          requestHeaders: () => flattenNodeHeaders(req.headers),
          requestBody: parsedNodeBody(req.body, headerOf("content-type"), core.maxBodySize),
          responseBody: capture.body()
        });
      } catch (err) {
        if (options.debug)
          console.error("[sentrinel] Error recording Express request:", err);
      }
    });
    core.run(state, () => next());
  };
  return Object.assign(middleware, {
    errorHandler: sentrinelErrorHandler(),
    flush: () => core.flush(),
    stop: () => core.stop()
  });
}

export { captureNodeResponse, onResponseDone, sentrinelErrorHandler, expressRoute, parsedNodeBody, sentrinelExpressMiddleware };
