import {
  captureNodeResponse,
  onResponseDone,
  parsedNodeBody
} from "./index-mkdkazy3.js";
import {
  createServerInstrumentation,
  errorShape,
  flattenNodeHeaders,
  nodeHeaderGetter,
  peekBody
} from "./index-6sz14kdp.js";

// src/next-middleware.ts
function nextPassThrough() {
  return new Response(null, { headers: { "x-middleware-next": "1" } });
}
function sentrinelNextMiddleware(_options) {
  let warned = false;
  const middleware = async (_request) => {
    const opts = _options;
    if (opts?.debug && !warned) {
      warned = true;
      console.warn("[sentrinel] sentrinelNextMiddleware records nothing — wrap your route handlers " + "with withSentrinel() from @sentrinel/plugin/next instead.");
    }
    return nextPassThrough();
  };
  return Object.assign(middleware, {
    recordResponse: (_request, _response) => {},
    stop: async () => {}
  });
}

// src/next.ts
var ERROR_BODY_BYTES = 8 * 1024;
var CORES = Symbol.for("sentrinel.next.cores");
function coreFor(options) {
  const g = globalThis;
  const cache = g[CORES] ??= new Map;
  const key = [options.serverUrl, options.appName, options.env ?? "", options.module ?? "", options.apiKey ?? ""].join("|");
  let core = cache.get(key);
  if (!core) {
    core = createServerInstrumentation(options, "Next.js");
    cache.set(key, core);
  }
  return core;
}
function routeFromParams(pathname, params) {
  if (!params || typeof params !== "object")
    return;
  const entries = Object.entries(params).filter(([, v]) => v !== undefined && v !== "");
  if (!entries.length)
    return;
  const segments = pathname.split("/");
  const decode = (s) => {
    try {
      return decodeURIComponent(s);
    } catch {
      return s;
    }
  };
  const matches = (slot, value) => typeof slot === "string" && decode(slot) === String(value);
  for (const [name, value] of entries) {
    if (!Array.isArray(value) || !value.length)
      continue;
    for (let i = 1;i + value.length <= segments.length; i++) {
      if (value.every((v, j) => matches(segments[i + j], v))) {
        segments.splice(i, value.length, { placeholder: `[...${name}]` });
        break;
      }
    }
  }
  for (const [name, value] of entries) {
    if (Array.isArray(value))
      continue;
    const idx = segments.findIndex((s, i) => i > 0 && matches(s, value));
    if (idx > 0)
      segments[idx] = { placeholder: `[${name}]` };
  }
  const route = segments.map((s) => typeof s === "string" ? s : s.placeholder).join("/");
  return route === pathname ? undefined : route;
}
function navigationStatus(err) {
  const digest = err?.digest;
  if (typeof digest !== "string")
    return;
  if (digest.startsWith("NEXT_REDIRECT")) {
    const code = Number(digest.split(";")[3]);
    return Number.isFinite(code) && code >= 300 && code < 400 ? code : 307;
  }
  if (digest === "NEXT_NOT_FOUND")
    return 404;
  if (digest.startsWith("NEXT_HTTP_ERROR_FALLBACK;")) {
    const code = Number(digest.split(";")[1]);
    return Number.isFinite(code) ? code : 404;
  }
  return;
}
function isPagesCall(args) {
  const res = args[1];
  return !!res && typeof res.setHeader === "function" && typeof res.end === "function";
}
async function handleAppRoute(core, handler, routeOptions, request, context, rest) {
  const options = core.options;
  let url;
  try {
    url = new URL(request.url);
  } catch {
    return handler(request, context, ...rest);
  }
  if (core.isExcludedPath(url.pathname))
    return handler(request, context, ...rest);
  try {
    if (options.excludeRequest?.(request))
      return handler(request, context, ...rest);
  } catch {}
  const header = (name) => request.headers.get(name);
  const state = core.begin(request.method, url, header);
  const logging = options.requestLogging;
  const logResponseBody = !!(logging?.enabled && logging.logResponseBody);
  const requestBody = logging?.enabled && logging.logRequestBody ? await peekBody(request, core.maxBodySize) : undefined;
  const resolveRoute = async () => {
    if (routeOptions?.route)
      return routeOptions.route;
    try {
      const params = await context?.params;
      return routeFromParams(url.pathname, params);
    } catch {
      return;
    }
  };
  const consumerOf = () => {
    if (typeof options.consumerIdentifier === "function") {
      try {
        return options.consumerIdentifier({ request, context });
      } catch {
        return null;
      }
    }
    return core.consumerFromHeader(header);
  };
  const requestSize = parseInt(request.headers.get("content-length") || "0", 10) || 0;
  const base = () => ({
    consumer: consumerOf(),
    requestSize,
    requestHeaders: () => {
      const raw = {};
      request.headers.forEach((value, key) => {
        raw[key] = value;
      });
      return raw;
    },
    requestBody: requestBody ? {
      text: requestBody.text,
      truncated: requestBody.truncated,
      totalBytes: requestSize || undefined,
      contentType: request.headers.get("content-type")
    } : undefined
  });
  let response;
  try {
    response = await core.run(state, () => handler(request, context, ...rest));
  } catch (err) {
    const nav = navigationStatus(err);
    core.finish(state, {
      ...base(),
      statusCode: nav ?? 500,
      route: await resolveRoute(),
      error: nav ? undefined : errorShape(err)
    });
    throw err;
  }
  const route = await resolveRoute();
  const isResponse = typeof Response !== "undefined" && response instanceof Response;
  const statusCode = isResponse ? response.status || 200 : 200;
  const responseSize = isResponse ? parseInt(response.headers.get("content-length") || "0", 10) || 0 : 0;
  if (!isResponse || !(logResponseBody || statusCode >= 400)) {
    core.finish(state, { ...base(), statusCode, route, responseSize });
    return response;
  }
  const outcome = base();
  peekBody(response, logResponseBody ? core.maxBodySize : ERROR_BODY_BYTES).catch(() => {
    return;
  }).then((captured) => {
    core.finish(state, {
      ...outcome,
      statusCode,
      route,
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
}
async function handlePagesRoute(core, handler, routeOptions, req, res, rest) {
  const options = core.options;
  let url;
  try {
    url = new URL(req.url || "/", "http://localhost");
  } catch {
    return handler(req, res, ...rest);
  }
  if (core.isExcludedPath(url.pathname))
    return handler(req, res, ...rest);
  const headerOf = nodeHeaderGetter(req.headers);
  const state = core.begin(req.method || "GET", url, headerOf);
  const logResponseBody = !!(options.requestLogging?.enabled && options.requestLogging.logResponseBody);
  const capture = captureNodeResponse(res, { logBody: logResponseBody, maxBodySize: core.maxBodySize });
  try {
    if (!res.headersSent) {
      res.setHeader("traceparent", `00-${state.trace.traceId}-${state.trace.rootSpanId}-01`);
      res.setHeader("x-trace-id", state.trace.traceId);
    }
  } catch {}
  let thrown;
  onResponseDone(res, (aborted) => {
    try {
      let route = routeOptions?.route;
      if (!route && req.query) {
        const params = {};
        for (const [k, v] of Object.entries(req.query))
          if (!url.searchParams.has(k))
            params[k] = v;
        route = routeFromParams(url.pathname, params);
      }
      let consumer = null;
      if (typeof options.consumerIdentifier === "function") {
        try {
          consumer = options.consumerIdentifier({ request: req, req, res });
        } catch {}
      } else {
        consumer = core.consumerFromHeader(headerOf);
      }
      const nav = thrown !== undefined ? navigationStatus(thrown) : undefined;
      core.finish(state, {
        statusCode: aborted ? 499 : res.statusCode || 200,
        route,
        error: thrown !== undefined && !nav ? errorShape(thrown) : undefined,
        consumer,
        requestSize: parseInt(headerOf("content-length") || "0", 10) || 0,
        responseSize: capture.written(),
        requestHeaders: () => flattenNodeHeaders(req.headers),
        requestBody: parsedNodeBody(req.body, headerOf("content-type"), core.maxBodySize),
        responseBody: capture.body()
      });
    } catch (err) {
      if (options.debug)
        console.error("[sentrinel] Error recording Next.js API request:", err);
    }
  });
  try {
    return await core.run(state, () => handler(req, res, ...rest));
  } catch (err) {
    thrown = err;
    throw err;
  }
}
function wrap(core, handler, routeOptions) {
  return async function sentrinelHandler(...args) {
    if (isPagesCall(args)) {
      return handlePagesRoute(core, handler.bind(this), routeOptions, args[0], args[1], args.slice(2));
    }
    return handleAppRoute(core, handler.bind(this), routeOptions, args[0], args[1], args.slice(2));
  };
}
function createSentrinelNext(options) {
  const core = coreFor(options);
  return {
    withSentrinel: (handler, routeOptions) => wrap(core, handler, routeOptions),
    withSentrinelApi: (handler, routeOptions) => wrap(core, handler, routeOptions),
    flush: () => core.flush(),
    stop: () => core.stop()
  };
}
function withSentrinel(options, handler, routeOptions) {
  return wrap(coreFor(options), handler, routeOptions);
}
function withSentrinelApi(options, handler, routeOptions) {
  return wrap(coreFor(options), handler, routeOptions);
}

export { nextPassThrough, sentrinelNextMiddleware, routeFromParams, createSentrinelNext, withSentrinel, withSentrinelApi };
