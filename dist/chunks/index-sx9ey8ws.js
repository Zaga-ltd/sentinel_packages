import {
  createServerInstrumentation,
  errorShape,
  peekBody
} from "./index-6sz14kdp.js";

// src/bun.ts
var ERROR_BODY_BYTES = 8 * 1024;
function sentrinelBunMiddleware(options, handler) {
  const core = createServerInstrumentation(options, "Bun middleware");
  const logging = options.requestLogging;
  const logRequestBody = !!(logging?.enabled && logging.logRequestBody);
  const logResponseBody = !!(logging?.enabled && logging.logResponseBody);
  const instrumentedFetch = async function instrumentedFetch2(req, server) {
    let url;
    try {
      url = new URL(req.url);
    } catch {
      return handler(req, server);
    }
    if (core.isExcludedPath(url.pathname))
      return handler(req, server);
    try {
      if (options.excludeRequest?.(req))
        return handler(req, server);
    } catch {}
    const header = (name) => req.headers.get(name);
    const state = core.begin(req.method, url, header);
    const requestBody = logRequestBody ? await peekBody(req, core.maxBodySize) : undefined;
    let consumer = null;
    if (typeof options.consumerIdentifier === "function") {
      try {
        consumer = options.consumerIdentifier({ request: req });
      } catch {}
    } else {
      consumer = core.consumerFromHeader(header);
    }
    const requestSize = parseInt(req.headers.get("content-length") || "0", 10) || 0;
    const base = {
      consumer,
      requestSize,
      requestHeaders: () => {
        const raw = {};
        req.headers.forEach((value, key) => {
          raw[key] = value;
        });
        return raw;
      },
      requestBody: requestBody ? {
        text: requestBody.text,
        truncated: requestBody.truncated,
        totalBytes: requestSize || undefined,
        contentType: req.headers.get("content-type")
      } : undefined
    };
    let response;
    try {
      response = await core.run(state, () => handler(req, server));
    } catch (err) {
      core.finish(state, { ...base, statusCode: 500, error: errorShape(err) });
      throw err;
    }
    const statusCode = response?.status || 200;
    const responseSize = parseInt(response?.headers?.get("content-length") || "0", 10) || 0;
    const wantBody = logResponseBody || statusCode >= 400;
    if (!wantBody || !response) {
      core.finish(state, { ...base, statusCode, responseSize });
      return response;
    }
    peekBody(response, logResponseBody ? core.maxBodySize : ERROR_BODY_BYTES).catch(() => {
      return;
    }).then((captured) => {
      core.finish(state, {
        ...base,
        statusCode,
        responseSize,
        responseBody: captured ? {
          text: captured.text,
          truncated: captured.truncated,
          totalBytes: responseSize || undefined,
          contentType: response.headers.get("content-type")
        } : undefined
      });
    });
    return response;
  };
  return Object.assign(instrumentedFetch, {
    flush: () => core.flush(),
    stop: () => core.stop()
  });
}

export { sentrinelBunMiddleware };
