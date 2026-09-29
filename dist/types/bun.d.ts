import type { SentrinelPluginOptions } from "./types.js";
type FetchHandler = (req: Request, server: any) => Response | Promise<Response>;
export declare function sentrinelBunMiddleware(options: SentrinelPluginOptions, handler: FetchHandler): FetchHandler & {
    flush: () => Promise<void>;
    stop: () => Promise<void>;
};
export {};
