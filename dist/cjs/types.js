"use strict";
// ─── Sentrinel Plugin Types ──────────────────────────────────────────────────────
Object.defineProperty(exports, "__esModule", { value: true });
exports.resolveConsumer = resolveConsumer;
/**
 * Normalise whatever a resolver returned into the three fields we store.
 *
 * Shared by every adapter so a `ConsumerIdentity` behaves identically on
 * Elysia, Bun and Express — the alternative is three near-copies that drift,
 * and an object silently stringifying to "[object Object]" on the two that
 * were not updated.
 */
function resolveConsumer(value) {
    if (!value)
        return { identifier: null };
    if (typeof value === "string")
        return { identifier: value };
    return {
        identifier: value.identifier || null,
        name: value.name,
        group: value.group,
    };
}
