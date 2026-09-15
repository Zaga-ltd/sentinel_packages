// ─── Auth domain ─────────────────────────────────────────────────────────────
//
// Five routes, and the only place the demo deals in credentials — so it is also
// where masking is worth proving. The plugin is configured to mask `password`,
// `pin` and `token` in bodies; send a login and the request detail should show
// the field present but redacted.

import { Elysia, t } from "elysia";
import { getLogger, addRequestContext, tspan } from "@sentrinel/plugin";

const log = getLogger(["fieldops", "auth"]);

/** Sessions live for the process only; this is a demo, not an auth server. */
const sessions = new Map<string, { userId: string; email: string; issuedAt: number }>();

const KNOWN_USERS = new Map<string, { id: string; password: string; role: string }>([
  ["dispatcher@fieldops.example", { id: "usr_dispatch", password: "correct-horse", role: "dispatcher" }],
  ["admin@fieldops.example", { id: "usr_admin", password: "correct-horse", role: "admin" }],
  ["tech@fieldops.example", { id: "usr_tech", password: "correct-horse", role: "technician" }],
]);

export const authRoutes = new Elysia({ prefix: "/api/v1/auth" })
  .post(
    "/login",
    async ({ body, set }) => {
      const { email, password } = body;
      addRequestContext({ "auth.email": email, "auth.attempt": true });

      const user = await tspan("auth.lookupUser", async ({ setAttribute }) => {
        await Bun.sleep(12);
        setAttribute("user.found", KNOWN_USERS.has(email));
        return KNOWN_USERS.get(email) ?? null;
      });

      if (!user) {
        log.warn("login rejected: unknown account", { email });
        set.status = 401;
        return { error: "InvalidCredentials", message: "No account for that email" };
      }

      if (user.password !== password) {
        log.warn("login rejected: bad password", { email, userId: user.id });
        set.status = 401;
        return { error: "InvalidCredentials", message: "Incorrect password" };
      }

      const token = `sess_${crypto.randomUUID()}`;
      sessions.set(token, { userId: user.id, email, issuedAt: Date.now() });
      addRequestContext({ "auth.userId": user.id, "auth.role": user.role });
      log.info("login succeeded", { userId: user.id, role: user.role });

      return { token, expiresIn: 3600, user: { id: user.id, email, role: user.role } };
    },
    {
      body: t.Object({
        email: t.String(),
        password: t.String(),
      }),
    }
  )

  .post(
    "/register",
    async ({ body, set }) => {
      const { email, password } = body;
      if (KNOWN_USERS.has(email)) {
        set.status = 409;
        return { error: "Conflict", message: "That email is already registered" };
      }
      if (password.length < 8) {
        set.status = 422;
        return { error: "WeakPassword", message: "Password must be at least 8 characters" };
      }
      const newUser = { id: `usr_${crypto.randomUUID().slice(0, 8)}`, password, role: "technician" };
      KNOWN_USERS.set(email, newUser);
      log.info("account created", { userId: newUser.id, email });
      set.status = 201;
      return { id: newUser.id, email, role: newUser.role };
    },
    {
      body: t.Object({
        email: t.String(),
        password: t.String(),
      }),
    }
  )

  .post("/refresh", async ({ request, set }) => {
    const token = bearer(request);
    const session = token ? sessions.get(token) : null;
    if (!session) {
      set.status = 401;
      return { error: "Unauthorized", message: "Unknown or expired session" };
    }
    const next = `sess_${crypto.randomUUID()}`;
    sessions.delete(token!);
    sessions.set(next, { ...session, issuedAt: Date.now() });
    return { token: next, expiresIn: 3600 };
  })

  .post("/logout", async ({ request }) => {
    const token = bearer(request);
    if (token) sessions.delete(token);
    log.info("logout");
    return { ok: true };
  })

  .get("/me", async ({ request, set }) => {
    const token = bearer(request);
    const session = token ? sessions.get(token) : null;
    if (!session) {
      set.status = 401;
      return { error: "Unauthorized", message: "Missing or invalid Bearer token" };
    }
    addRequestContext({ "auth.userId": session.userId });
    return {
      id: session.userId,
      email: session.email,
      sessionAgeMs: Date.now() - session.issuedAt,
    };
  });

function bearer(request: Request): string | null {
  const header = request.headers.get("authorization");
  if (!header?.startsWith("Bearer ")) return null;
  return header.slice(7);
}
