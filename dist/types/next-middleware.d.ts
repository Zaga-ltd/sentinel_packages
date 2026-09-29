/** `NextResponse.next()`, without depending on `next/server`. */
export declare function nextPassThrough(): Response;
/**
 * A middleware that lets every request through untouched.
 *
 * An incoming `traceparent` already reaches the route handler unchanged — a
 * pass-through forwards request headers as they are — and `withSentrinel`
 * continues it there. Minting one here would name a parent span nothing ever
 * records.
 *
 * @deprecated Wrap route handlers with `withSentrinel` from
 * `@sentrinel/plugin/next`; this middleware is not needed at all.
 */
export declare function sentrinelNextMiddleware(_options?: unknown): ((_request: Request) => Promise<Response>) & {
    /** @deprecated No-op; kept so old call sites compile. */
    recordResponse: (_request: Request, _response: Response) => void;
    /** @deprecated No-op. */
    stop: () => Promise<void>;
};
