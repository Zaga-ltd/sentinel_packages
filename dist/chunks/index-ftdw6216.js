import {
  createServerInstrumentation,
  errorShape,
  peekBody,
  statusFromName
} from "./index-6sz14kdp.js";

// src/elysia.ts
function sentrinelPlugin(options) {
  return (app) => {
    const core = createServerInstrumentation(options, "Elysia plugin");
    app.onStop(async () => {
      await core.stop();
    });
    const capturedPayloads = new WeakMap;
    const states = new WeakMap;
    app.onRequest(({ request }) => {
      try {
        const url = new URL(request.url);
        const state = core.begin(request.method, url, (name) => request.headers.get(name));
        states.set(request, state);
      } catch {}
    });
    if (options.requestLogging?.logRequestBody) {
      app.onRequest(async ({ request }) => {
        try {
          const captured = await peekBody(request, core.maxBodySize);
          if (captured?.text)
            capturedPayloads.set(request, captured);
        } catch {}
      });
    }
    app.derive(({ request }) => {
      const state = states.get(request);
      if (!state)
        return {};
      core.enter(state);
      return {
        _sentrinelState: state,
        _sentrinelReqPayload: capturedPayloads.get(request)
      };
    });
    app.onError((ctx) => {
      try {
        const err = ctx.error;
        if (err instanceof Error) {
          ctx._sentrinelError = errorShape(err);
        }
      } catch {}
    });
    app.onAfterResponse((ctx) => {
      try {
        const state = ctx._sentrinelState;
        if (!state)
          return;
        const pathname = state.url.pathname;
        if (core.isExcludedPath(pathname))
          return;
        try {
          if (options.excludeRequest?.(ctx.request))
            return;
        } catch {}
        const routePath = ctx.route || pathname;
        const response = ctx.response;
        const setStatus = ctx.set?.status;
        const statusCode = typeof Response !== "undefined" && response instanceof Response ? response.status : typeof setStatus === "number" ? setStatus : typeof setStatus === "string" ? statusFromName(setStatus) ?? 200 : 200;
        const requestSize = parseInt(ctx.request.headers.get("content-length") || "0", 10) || 0;
        let responseSize = 0;
        if (response !== null && response !== undefined) {
          if (typeof Response !== "undefined" && response instanceof Response) {
            responseSize = parseInt(response.headers.get("content-length") || "0", 10) || 0;
          } else if (typeof response === "string") {
            responseSize = new TextEncoder().encode(response).byteLength;
          } else if (typeof response === "object") {
            try {
              responseSize = new TextEncoder().encode(JSON.stringify(response)).byteLength;
            } catch {}
          }
        }
        let consumer = null;
        if (typeof options.consumerIdentifier === "function") {
          try {
            const safeCtx = {
              request: ctx.request,
              headers: ctx.headers,
              set: ctx.set,
              query: ctx.query,
              params: ctx.params,
              store: ctx.store,
              response: ctx.response
            };
            consumer = options.consumerIdentifier(safeCtx);
          } catch {}
        } else if (typeof options.consumerIdentifier === "string") {
          consumer = ctx.request.headers.get(options.consumerIdentifier.toLowerCase());
        }
        const captured = ctx._sentrinelReqPayload;
        const request = ctx.request;
        core.finish(state, {
          statusCode,
          route: routePath,
          error: ctx._sentrinelError,
          consumer,
          requestSize,
          responseSize,
          requestHeaders: () => {
            const raw = {};
            request.headers.forEach((value, key) => {
              raw[key] = value;
            });
            return raw;
          },
          requestBody: captured ? {
            text: captured.text,
            truncated: captured.truncated,
            totalBytes: requestSize || undefined,
            contentType: request.headers.get("content-type")
          } : undefined,
          responseBody: response !== null && response !== undefined && !(typeof Response !== "undefined" && response instanceof Response) ? { value: response } : undefined
        });
      } catch (err) {
        if (options.debug)
          console.error("[sentrinel] Error in afterResponse hook:", err);
      }
    });
    return app;
  };
}

export { sentrinelPlugin };
