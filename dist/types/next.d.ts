import type { SentrinelPluginOptions } from "./types.js";
export { sentrinelNextMiddleware, nextPassThrough } from "./next-middleware.js";
export interface RouteOptions {
    /**
     * The route pattern, e.g. `/api/orders/[id]`. Derived from `params` when
     * omitted; set it when a route has no params to derive it from but its URL
     * still carries ids.
     */
    route?: string;
}
/**
 * `/api/orders/42` + `{ id: "42" }` → `/api/orders/[id]`.
 *
 * Next hands a route handler its params but not its pattern. Without the
 * pattern every id would be its own endpoint until the collector's id
 * heuristics caught it; with the params it can be rebuilt exactly.
 */
export declare function routeFromParams(pathname: string, params: Record<string, string | string[] | undefined> | undefined | null): string | undefined;
type AnyHandler = (...args: any[]) => any;
/**
 * Build the Next.js integration once, in a module every route imports.
 *
 * `withSentrinel(handler)` wraps an App Router route handler
 * (`export const GET = withSentrinel(async (request, ctx) => …)`) or a Pages
 * Router API route (`export default withSentrinel((req, res) => …)`) — which
 * one is detected from the arguments Next passes.
 */
export declare function createSentrinelNext(options: SentrinelPluginOptions): {
    withSentrinel: <H extends AnyHandler>(handler: H, routeOptions?: RouteOptions) => H;
    /** Explicitly a Pages Router API route. `withSentrinel` detects it anyway. */
    withSentrinelApi: <H extends AnyHandler>(handler: H, routeOptions?: RouteOptions) => H;
    /** Send what is buffered now. */
    flush: () => Promise<void>;
    /** Final flush and stop the timer. */
    stop: () => Promise<void>;
};
/**
 * One-shot form: `withSentrinel(options, handler)`.
 *
 * Every call with the same `serverUrl`/`appName`/`env`/`module`/`apiKey`
 * shares one collector, so wrapping each route file this way does not start a
 * collector per route. `createSentrinelNext` is the tidier form when many
 * routes are wrapped.
 */
export declare function withSentrinel<H extends AnyHandler>(options: SentrinelPluginOptions, handler: H, routeOptions?: RouteOptions): H;
/** `withSentrinel` for a Pages Router API route, named for readability. */
export declare function withSentrinelApi<H extends AnyHandler>(options: SentrinelPluginOptions, handler: H, routeOptions?: RouteOptions): H;
