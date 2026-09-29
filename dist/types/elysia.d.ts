import type { SentrinelPluginOptions } from "./types.js";
export type { SentrinelPluginOptions, RequestLoggingOptions } from "./types.js";
/**
 * Sentrinel Elysia Plugin
 *
 * Instruments your Elysia application with API monitoring, metrics collection,
 * request logging, and error tracking. Data is sent to a Sentrinel API server
 * for visualization in the Sentrinel dashboard.
 *
 * @example
 * ```ts
 * import { sentrinelPlugin } from '@sentrinel/plugin';
 *
 * const app = new Elysia()
 *   .use(sentrinelPlugin({
 *     serverUrl: 'http://localhost:3001',
 *     appName: 'my-api',
 *     env: 'prod',
 *     requestLogging: {
 *       enabled: true,
 *       logRequestHeaders: true,
 *       logRequestBody: true,
 *       logResponseBody: true,
 *     },
 *     consumerIdentifier: (ctx) => ctx.headers['x-consumer-id'],
 *   }))
 * ```
 */
export declare function sentrinelPlugin(options: SentrinelPluginOptions): (app: any) => any;
