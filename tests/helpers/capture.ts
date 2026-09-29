// What the plugin tried to send, grouped by ingest path — installed as the
// global fetch so the collectors under test post into memory.

export type Captured = Record<string, any[]>;

export function installCapture(
  respond: (path: string, body: any) => Response | Promise<Response> = () =>
    new Response(JSON.stringify({ success: true }), { status: 200 })
): { captured: Captured; restore: () => void } {
  const captured: Captured = {};
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = String(typeof input === "string" ? input : input.url ?? input);
    const path = new URL(url).pathname;
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    (captured[path] ??= []).push(body);
    return respond(path, body);
  }) as typeof fetch;
  return { captured, restore: () => (globalThis.fetch = original) };
}

export const all = (captured: Captured, path: string, key: string): any[] =>
  (captured[path] ?? []).flatMap((b) => b?.[key] ?? []);

export const baseOptions = (appName: string) => ({
  serverUrl: "http://sentrinel.local",
  appName,
  env: "test",
  apiKey: "k",
  // Long: tests flush by hand, so nothing races the assertions.
  flushInterval: 1_000_000,
});
