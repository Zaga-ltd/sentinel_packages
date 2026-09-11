// ─── `sentrinel skill` ───────────────────────────────────────────────────────
//
// The skill is the part an agent reads *before* it calls anything: what the
// tools are, which order to use them in, what an empty result means, what not
// to do with a captured request body. Every harness loads that kind of file
// from a different place, so this command writes it wherever the one in front
// of you looks.
//
//   sentrinel skill                    print SKILL.md
//   sentrinel skill --all              print it with its reference pages
//   sentrinel skill install            ~/.claude/skills/sentrinel/   (Claude)
//   sentrinel skill install --cursor   .cursor/rules/sentrinel.mdc   (Cursor)
//   sentrinel skill install --agents   ./AGENTS.md                   (Codex & co)
//   sentrinel skill install --dir P    anywhere else
//
// Everything here is a pure function of its inputs — the plan is computed,
// then written — so the interesting parts are testable without a filesystem.

import { SKILL_FILES } from "./skill-content";

export const SKILL_NAME = "sentrinel";

/** The description line from SKILL.md's frontmatter, for formats that want one. */
export function description(main: string = SKILL_FILES["SKILL.md"]): string {
  const m = main.match(/^description:\s*([\s\S]*?)\n(?:[a-z_]+:|---)/m);
  return m ? m[1].trim().replace(/\s+/g, " ") : "Read production telemetry from Sentrinel.";
}

/** SKILL.md without its YAML frontmatter, for formats that do not use it. */
export function body(main: string = SKILL_FILES["SKILL.md"]): string {
  return main.startsWith("---") ? main.slice(main.indexOf("\n---", 3) + 4).trimStart() : main;
}

export interface PlannedFile {
  path: string;
  content: string;
}

export interface Plan {
  /** Printed to stdout. Either the skill itself, or what was written where. */
  print: string;
  files: PlannedFile[];
}

const START = "<!-- sentrinel:skill:start -->";
const END = "<!-- sentrinel:skill:end -->";

/**
 * Replace a previously written block, or append one. Idempotent by design:
 * re-running after an upgrade must not leave two copies in someone's AGENTS.md,
 * and must not touch a line they wrote themselves.
 */
export function mergeBlock(existing: string, block: string): string {
  const wrapped = `${START}\n${block.trim()}\n${END}`;
  const s = existing.indexOf(START);
  const e = existing.indexOf(END);
  if (s > -1 && e > s) return existing.slice(0, s) + wrapped + existing.slice(e + END.length);
  return existing.trim() ? `${existing.trimEnd()}\n\n${wrapped}\n` : `${wrapped}\n`;
}

/** What Codex, Copilot and friends get: the skill, under a heading, in one file. */
export function agentsBlock(): string {
  return [
    "## Sentrinel (production telemetry)",
    "",
    body().replace(/^# Sentrinel\n+/, ""),
  ].join("\n");
}

/** Cursor rules are Markdown with their own frontmatter. */
export function cursorRule(): string {
  return [
    "---",
    `description: ${description()}`,
    "alwaysApply: false",
    "---",
    "",
    body(),
  ].join("\n");
}

export interface PlanOptions {
  install: boolean;
  all: boolean;
  cursor: boolean;
  agents: boolean;
  dir?: string;
  home: string;
  cwd: string;
}

export function plan(o: PlanOptions): Plan {
  if (!o.install) {
    const text = o.all
      ? Object.entries(SKILL_FILES)
          .map(([p, c]) => (p === "SKILL.md" ? c : `\n\n<!-- ${p} -->\n\n${c}`))
          .join("")
      : SKILL_FILES["SKILL.md"];
    return { print: text.trimEnd(), files: [] };
  }

  const join = (...parts: string[]) => parts.join("/").replace(/\/+/g, "/");

  if (o.cursor) {
    const path = o.dir ? join(o.dir, "sentrinel.mdc") : join(o.cwd, ".cursor/rules/sentrinel.mdc");
    return { print: written([path], "Cursor reads it from .cursor/rules/."), files: [{ path, content: cursorRule() }] };
  }

  if (o.agents) {
    // A single file others already own, so this one is a merge, not a write.
    const path = o.dir ? join(o.dir, "AGENTS.md") : join(o.cwd, "AGENTS.md");
    return {
      print: written([path], "Codex, Copilot, Amp and anything else that reads AGENTS.md."),
      files: [{ path, content: agentsBlock() }],
    };
  }

  const root = o.dir ? o.dir : join(o.home, ".claude/skills", SKILL_NAME);
  const files = Object.entries(SKILL_FILES).map(([rel, content]) => ({ path: join(root, rel), content }));
  return {
    print: written(
      files.map((f) => f.path),
      o.dir ? "" : "Claude Code and Claude Desktop pick it up on the next session."
    ),
    files,
  };
}

function written(paths: string[], note: string): string {
  return ["Wrote:", ...paths.map((p) => `  ${p}`), ...(note ? ["", `  ${note}`] : [])].join("\n");
}

/**
 * A flag is on when it is present and not explicitly denied. `--cursor`,
 * `--cursor=1` and `--cursor true` all mean the same thing to the person
 * typing them, and only the first parses as a boolean.
 */
export function on(v: string | boolean | undefined): boolean {
  if (v === undefined) return false;
  if (typeof v === "boolean") return v;
  return !/^(0|false|no)$/i.test(v.trim());
}

export function planFromArgs(
  positional: string[],
  flags: Record<string, string | boolean>,
  env: { home: string; cwd: string }
): Plan {
  const dir = typeof flags.dir === "string" ? flags.dir : undefined;
  return plan({
    install: positional[0] === "install" || on(flags.install),
    all: on(flags.all),
    cursor: on(flags.cursor),
    agents: on(flags.agents) || on(flags["agents-md"]),
    dir,
    home: env.home,
    cwd: env.cwd,
  });
}
