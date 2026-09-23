// ─── Profiles: which app the commands talk to ────────────────────────────────
//
// A key is pinned to one app, so "work on a different app now" means "use a
// different key". That is a good security boundary and a poor interface if the
// only way to act on it is editing a file, so a profile is a named key and
// switching is one command.
//
//   sentrinel apps              what is installed, and which one is active
//   sentrinel use merchant      switch
//
// The active profile is a name in ~/.sentrinel/current. SENTRINEL_PROFILE still
// wins when it is set, so a one-off `SENTRINEL_PROFILE=x sentrinel issues` needs
// no switching and switching does not disturb a shell that pinned one.
//
// Registered MCP servers are unaffected by a switch: each was registered with
// its own profile, except the default one — which follows `current`, so a
// switch changes what plain `sentrinel` reports in the next Claude session.

import { readdir, readFile, writeFile, rm, mkdir } from "node:fs/promises";
import { join } from "node:path";

import { installDir } from "./update";

export const DEFAULT_PROFILE = "default";
const CURRENT = "current";

export interface Profile {
  /** "default" for ~/.sentrinel/env, otherwise the suffix. */
  name: string;
  envFile: string;
  apiUrl?: string;
  key?: string;
  active: boolean;
}

function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq > 0) out[t.slice(0, eq)] = t.slice(eq + 1);
  }
  return out;
}

/** The profile in force, before any per-command override. */
export async function activeProfile(
  dir = installDir(),
  env: Record<string, string | undefined> = process.env
): Promise<string> {
  if (env.SENTRINEL_PROFILE) return env.SENTRINEL_PROFILE;
  try {
    const name = (await readFile(join(dir, CURRENT), "utf8")).trim();
    return name || DEFAULT_PROFILE;
  } catch {
    return DEFAULT_PROFILE;
  }
}

export async function listProfiles(
  dir = installDir(),
  env: Record<string, string | undefined> = process.env
): Promise<Profile[]> {
  const active = await activeProfile(dir, env);
  let names: string[] = [];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }

  const found: Profile[] = [];
  for (const f of names.sort()) {
    if (f !== "env" && !f.startsWith("env.")) continue;
    const name = f === "env" ? DEFAULT_PROFILE : f.slice("env.".length);
    const envFile = join(dir, f);
    let parsed: Record<string, string> = {};
    try {
      parsed = parseEnvFile(await readFile(envFile, "utf8"));
    } catch {
      /* unreadable is still a profile worth listing */
    }
    found.push({
      name,
      envFile,
      apiUrl: parsed.SENTRINEL_API_URL,
      key: parsed.SENTRINEL_API_KEY,
      active: name === active,
    });
  }
  return found;
}

/**
 * Switch, after checking the profile exists.
 *
 * Writing a name nothing backs would leave every later command failing on a
 * missing key, with nothing to connect it to the switch that caused it.
 */
export async function useProfile(name: string, dir = installDir()): Promise<Profile[]> {
  const profiles = await listProfiles(dir, {});
  const target = profiles.find((p) => p.name === name);
  if (!target) {
    const known = profiles.map((p) => p.name).join(", ") || "none installed";
    throw new Error(`No profile called "${name}". Installed: ${known}.`);
  }
  await mkdir(dir, { recursive: true });
  if (name === DEFAULT_PROFILE) {
    await rm(join(dir, CURRENT), { force: true });
  } else {
    await writeFile(join(dir, CURRENT), name, { mode: 0o644 });
  }
  return profiles.map((p) => ({ ...p, active: p.name === name }));
}

/**
 * Which app a key belongs to.
 *
 * There is no "what am I" endpoint; the overview is already scoped to the key's
 * app and names it, so a one-minute window is the cheapest way to ask. A
 * failure is reported per profile rather than thrown — one revoked key must not
 * stop the list rendering.
 */
export async function appForKey(
  profile: Profile,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 8000
): Promise<string> {
  if (!profile.key) return "no key set";
  const base = (profile.apiUrl || "https://api.sentrinel.dev").replace(/\/+$/, "");
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetchImpl(`${base}/api/overview?period=60`, {
      headers: { authorization: `Bearer ${profile.key}` },
      signal: ac.signal,
    });
    if (res.status === 401) return "key rejected (revoked?)";
    if (!res.ok) return `unavailable (${res.status})`;
    const body = (await res.json()) as { apps?: Array<{ name?: string }> };
    const names = (body.apps ?? []).map((a) => a.name).filter(Boolean);
    return names.length ? names.join(", ") : "no app";
  } catch {
    return "unreachable";
  } finally {
    clearTimeout(timer);
  }
}

export async function profilesToMarkdown(
  dir = installDir(),
  env: Record<string, string | undefined> = process.env,
  fetchImpl: typeof fetch = fetch
): Promise<string> {
  const profiles = await listProfiles(dir, env);
  if (!profiles.length) {
    return "No profiles installed. Run the installer with a key to make one.";
  }
  const apps = await Promise.all(profiles.map((p) => appForKey(p, fetchImpl)));
  const lines = ["## Installed profiles", ""];
  profiles.forEach((p, i) => {
    lines.push(`${p.active ? "* " : "  "}**${p.name}** — ${apps[i]}${p.active ? "  _(active)_" : ""}`);
  });
  lines.push(
    "",
    "Switch with `sentrinel use <name>`, or for one command only:",
    "`SENTRINEL_PROFILE=<name> sentrinel issues`.",
    "",
    "A profile is one app, because a key is. Add one with:",
    "`curl -fsSL https://sentrinel.dev/install-mcp.sh | SENTRINEL_API_KEY=<key> SENTRINEL_PROFILE=<name> bash`"
  );
  return lines.join("\n");
}
