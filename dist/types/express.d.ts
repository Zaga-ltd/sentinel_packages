import { type CapturedBody } from "./core.js";
import { type NodeResponseLike } from "./node-response.js";
import type { SentrinelPluginOptions } from "./types.js";
interface Request {
    headers: Record<string, string | string[] | undefined>;
    method?: string;
    path?: string;
    url?: string;
    originalUrl?: string;
    baseUrl?: string;
    route?: {
        path?: string | RegExp | (string | RegExp)[];
    };
    query?: unknown;
    body?: unknown;
}
interface Response extends NodeResponseLike {
    setHeader(name: string, value: string): void;
}
type NextFunction = (err?: unknown) => void;
/**
 * Express error middleware that records the thrown error, then passes it on.
 *
 * Add it after your routes and before any error handler of your own that
 * sends a response — a handler that responds without calling `next(err)`
 * stops the chain before this runs. It never responds itself.
 */
export declare function sentrinelErrorHandler(): (err: unknown, req: Request, _res: Response, next: NextFunction) => void;
/**
 * The matched route, with the mount path of any router it lives in.
 *
 * `req.baseUrl + req.route.path` is right while the request is inside its
 * router — but when an error leaves the router, Express restores `baseUrl` to
 * the parent's before the error middleware runs, so by `finish` an errored
 * `/api/boom/:id` reads as `/boom/:id`. The mount prefix is then rebuilt from
 * the URL: whatever precedes the segments the route pattern matched.
 */
export declare function expressRoute(req: Request): string | undefined;
/** A parsed `req.body` (from body-parser, multer, …) as a capturable body. */
export declare function parsedNodeBody(body: unknown, contentType: string | null | undefined, maxBodySize: number): CapturedBody | undefined;
export declare function sentrinelExpressMiddleware(options: SentrinelPluginOptions): ((req: Request, res: Response, next: NextFunction) => void) & {
    /** The error middleware to add after your routes — see sentrinelErrorHandler. */
    errorHandler: (err: unknown, req: Request, _res: Response, next: NextFunction) => void;
    /** Send what is buffered now. */
    flush: () => Promise<void>;
    /** Final flush and stop the timer — for your own shutdown handler. */
    stop: () => Promise<void>;
};
export {};
