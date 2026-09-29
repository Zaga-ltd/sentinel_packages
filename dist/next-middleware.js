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
export {
  nextPassThrough,
  sentrinelNextMiddleware
};
