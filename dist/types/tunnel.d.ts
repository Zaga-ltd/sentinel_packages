/**
 * Browser tunnel — `@sentrinel/plugin/tunnel`
 *
 * The server half of the browser SDK: one `Request → Response` handler that
 * takes a batch from the page and forwards it to Sentrinel with your API key.
 *
 * It exists so the key never ships in a bundle. It also **pins `appName` and
 * `env` here**, ignoring anything the browser claims, so a page — or anyone who
 * found the endpoint — cannot write telemetry into a different app.
 *
 * It is a plain `(Request) => Promise<Response>`, which is what Bun, Elysia,
 * Hono, Next route handlers, TanStack Start, Remix and Deno all speak.
 *
 * ```ts
 * // app/api/sentrinel/route.ts  (Next)
 * import { createSentrinelTunnel } from "@sentrinel/plugin/tunnel";
 *
 * const tunnel = createSentrinelTunnel({
 *   serverUrl: "https://api.sentrinel.dev",
 *   appName: "admin",
 *   env: "prod",
 *   apiKey: process.env.SENTRINEL_API_KEY!,
 * });
 *
 * export const POST = tunnel;
 * ```
 *
 * ## Browser timings are client data
 *
 * A fetch timed in the browser includes the network, the queue in the
 * browser, and whatever the page did before the request left. It is a
 * different measurement from the one the backend makes of the same call. They
 * used to be rolled up into `/api/ingest/metrics`, where they landed in the
 * same endpoint rows as the backend's (those rows have no module column), so
 * `GET /api/orders` counted every call twice and its p95 was a blend of two
 * unrelated numbers. They are now sent only as request rows marked
 * `kind: "client"` in the `web` module, and as client spans on the trace.
 */
export interface SentrinelTunnelOptions {
    /** The Sentrinel API, e.g. `https://api.sentrinel.dev`. */
    serverUrl: string;
    /** Pinned server-side; whatever the browser sends is ignored. */
    appName: string;
    /** Pinned server-side. Must match the environment the key was issued for. */
    env: string;
    /** Never let this reach the client. */
    apiKey: string;
    /** Falls back to the release the browser reported. */
    release?: string;
    /**
     * Which part of the project this page is — `web`, `admin`, `checkout`. An app
     * is the whole project; the browser reports as a module of it beside the
     * backend and the phone. Defaults to `web`.
     *
     * Not to the key's name, as it once did: the tunnel usually runs on the
     * backend with the backend's own server key, so defaulting to the key filed
     * every browser record under the backend's module.
     */
    module?: string;
    /**
     * Largest batch accepted, in bytes. An open endpoint that will buffer
     * anything is a memory-exhaustion target.
     */
    maxBodyBytes?: number;
    /** Ceiling for a session-replay chunk. Defaults to 4MB. */
    maxReplayBytes?: number;
    /**
     * Who sent this, derived from the request — a session cookie, a header, an
     * authenticated user. Overrides whatever the browser claimed, because a
     * browser-supplied identity is a claim, not a fact.
     */
    consumerIdentifier?: (request: Request) => string | undefined | Promise<string | undefined>;
    /** Last chance to drop or redact server-side. Return `null` to drop the batch. */
    beforeForward?: (batch: TunnelBatch, request: Request) => TunnelBatch | null;
    /** Log forwarding results. */
    debug?: boolean;
}
export interface TunnelBatch {
    release?: string;
    errors?: Record<string, unknown>[];
    requests?: Record<string, unknown>[];
    sessions?: Record<string, unknown>[];
    events?: Record<string, unknown>[];
    anonymousId?: string;
    userId?: string;
    sessionId?: string;
    /** A session-replay chunk. Arrives alone, and is far larger than the rest. */
    replay?: Record<string, unknown>;
}
/**
 * Where the browser SDK posts by default, and where it used to.
 *
 * `/api/_sentrinel` was the old default and pages built against it are still
 * deployed; Next's App Router cannot serve it (a `_` folder is private), which
 * is why the default moved. A server mounting the tunnel by path should answer
 * both — `isSentrinelTunnelPath` does.
 */
export declare const SENTRINEL_TUNNEL_PATHS: readonly ["/api/sentrinel", "/api/_sentrinel"];
export declare function isSentrinelTunnelPath(pathname: string): boolean;
/**
 * Build the handler.
 *
 * Always answers `202` when the batch is well-formed, even if forwarding fails.
 * The page cannot do anything useful with a delivery failure, and an error
 * response would show up as a failed request in its own console — noise about
 * monitoring, in place of the app's own signal.
 */
export declare function createSentrinelTunnel(options: SentrinelTunnelOptions): (request: Request) => Promise<Response>;
