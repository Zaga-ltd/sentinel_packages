/**
 * The route identity for a path. Idempotent, and a no-op on a route the
 * framework already parameterised (`/orders/:id`, `/orders/{id}`).
 */
export declare function normaliseRoutePath(path: string | null | undefined): string;
