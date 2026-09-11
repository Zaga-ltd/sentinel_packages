import { describe, expect, it } from "bun:test";

import { collect, render } from "../scripts/gen-skill";
import { SKILL_FILES } from "../src/skill-content";
import { absolutize, agentsBlock, body, cursorRule, description, mergeBlock, on, plan, planFromArgs } from "../src/skill";

const env = { home: "/home/dev", cwd: "/repo" };
const opts = { install: false, all: false, cursor: false, agents: false, ...env };

describe("the generated content", () => {
  // The whole point of generating is that the bundle carries the skill. A stale
  // skill-content.ts would ship documentation that no longer matches the tools,
  // and nothing else would notice.
  it("is in sync with skill/", async () => {
    expect(render(await collect())).toBe(await Bun.file(`${import.meta.dir}/../src/skill-content.ts`).text());
  });

  it("carries SKILL.md and its references", () => {
    expect(Object.keys(SKILL_FILES).sort()).toEqual([
      "SKILL.md",
      "references/cli.md",
      "references/databases.md",
      "references/integration.md",
      "references/keys.md",
    ]);
  });

  it("names every tool the server registers", () => {
    const server = SKILL_FILES["SKILL.md"];
    for (const tool of [
      "list_issues",
      "get_issue",
      "get_request",
      "get_trace",
      "search_logs",
      "list_databases",
      "slow_queries",
      "db_activity",
      "db_health",
      "set_issue_status",
    ]) {
      expect(server).toContain(tool);
    }
  });
});

describe("frontmatter", () => {
  it("reads the description out", () => {
    expect(description()).toStartWith("Work with Sentrinel, an error and performance monitor");
  });

  it("strips it for formats that do not use it", () => {
    expect(body()).toStartWith("# Sentrinel");
    expect(body()).not.toContain("name: sentrinel");
  });
});

describe("plan", () => {
  it("prints SKILL.md by default", () => {
    const p = plan(opts);
    expect(p.files).toEqual([]);
    expect(p.print).toStartWith("---");
  });

  it("--all appends the references", () => {
    expect(plan({ ...opts, all: true }).print).toContain("references/cli.md");
  });

  it("installs the whole skill under ~/.claude/skills", () => {
    expect(plan({ ...opts, install: true }).files.map((f) => f.path)).toEqual([
      "/home/dev/.claude/skills/sentrinel/SKILL.md",
      "/home/dev/.claude/skills/sentrinel/references/cli.md",
      "/home/dev/.claude/skills/sentrinel/references/databases.md",
      "/home/dev/.claude/skills/sentrinel/references/integration.md",
      "/home/dev/.claude/skills/sentrinel/references/keys.md",
    ]);
  });

  it("writes one file for Cursor, with its own frontmatter", () => {
    const [f, ...rest] = plan({ ...opts, install: true, cursor: true }).files;
    expect(rest).toEqual([]);
    expect(f.path).toBe("/repo/.cursor/rules/sentrinel.mdc");
    expect(f.content).toContain("alwaysApply: false");
  });

  it("writes AGENTS.md in the repo, under a heading", () => {
    const [f] = plan({ ...opts, install: true, agents: true }).files;
    expect(f.path).toBe("/repo/AGENTS.md");
    expect(f.content).toStartWith("## Sentrinel (production telemetry)");
  });

  it("honours an explicit directory", () => {
    expect(plan({ ...opts, install: true, dir: "/elsewhere" }).files[0].path).toBe("/elsewhere/SKILL.md");
  });
});

describe("mergeBlock", () => {
  const block = agentsBlock();

  it("appends to a file someone else owns, keeping their content", () => {
    const out = mergeBlock("# My repo\n\nRun the tests with bun test.\n", block);
    expect(out).toStartWith("# My repo");
    expect(out).toContain("## Sentrinel");
  });

  // An upgrade must not leave two copies, and must not touch their lines.
  it("replaces its own block instead of duplicating it", () => {
    const once = mergeBlock("# My repo\n", block);
    const twice = mergeBlock(once, block);
    expect(twice).toBe(once);
    expect(twice.split("## Sentrinel (production telemetry)")).toHaveLength(2);
  });

  it("leaves what follows its block alone", () => {
    const start = mergeBlock("# My repo\n", block) + "\n## After\n\nmine\n";
    expect(mergeBlock(start, block)).toContain("## After");
  });

  it("writes a bare file when there is nothing there", () => {
    expect(mergeBlock("", block)).toStartWith("<!-- sentrinel:skill:start -->");
  });
});

describe("cursorRule", () => {
  it("is a single self-contained document", () => {
    const r = cursorRule();
    expect(r).toStartWith("---\ndescription: Work with Sentrinel");
    expect(r).toContain("# Sentrinel");
    expect(r).toContain("list_issues");
  });
});

describe("flags", () => {
  // `--cursor=1` parses as the string "1", not true. Comparing against `true`
  // silently installed to the default location instead of the one asked for.
  it("accepts a flag however it was written", () => {
    for (const v of [true, "1", "true", "yes", ""]) expect(on(v as string | boolean)).toBe(true);
    for (const v of [undefined, false, "0", "false", "no"]) expect(on(v as string | boolean)).toBe(false);
  });

  it("routes --cursor=1 to the Cursor rule", () => {
    const p = planFromArgs(["install"], { cursor: "1" }, { home: "/h", cwd: "/r" });
    expect(p.files[0].path).toBe("/r/.cursor/rules/sentrinel.mdc");
  });
});

// A relative link to references/ is correct inside the installed skill folder
// and dangling in every single-file form, where those files do not travel.
describe("links in the single-file forms", () => {
  it("rewrites relative reference links to the published copies", () => {
    expect(absolutize("see [cli](references/cli.md) now")).toBe(
      "see [cli](https://github.com/Zaga-ltd/sentinel_packages/blob/main/mcp/skill/references/cli.md) now"
    );
  });

  it("leaves no relative reference link in the Cursor rule or the AGENTS block", () => {
    for (const form of [cursorRule(), agentsBlock()]) {
      expect(form).not.toMatch(/\]\(references\//);
      expect(form).toContain("skill/references/cli.md");
    }
  });

  it("keeps them relative in the installed skill, where the files are real", () => {
    const [main] = plan({ ...opts, install: true }).files;
    expect(main.content).toContain("](references/cli.md)");
  });
});

// The skill is published — to the public package repo, to sentrinel.dev, and
// into whatever repository a user installs it in. It documents the product, so
// nothing about how the product is built or hosted belongs in it, and no
// credential-shaped string ever does.
describe("the public/internal boundary", () => {
  const all = Object.values(SKILL_FILES).join("\n");

  it("names no internal host, service or private repository", () => {
    for (const forbidden of [
      "dokploy",
      "clickhouse",
      "redpanda",
      "elysia-monitoring",
      ".env.deploy",
      "wrangler",
      "cloudflare",
      "drizzle",
      "sentrinel-db",
    ]) {
      expect(all.toLowerCase()).not.toContain(forbidden);
    }
  });

  it("names no raw IP address", () => {
    expect(all).not.toMatch(/\b\d{1,3}(\.\d{1,3}){3}\b/);
  });

  // Prefixes are documented on purpose — a whole key never is.
  it("contains no key-shaped string", () => {
    expect(all).not.toMatch(/snt_[a-z]+_[A-Za-z0-9]{8,}/);
  });

  it("points at the public docs for the detail it does not carry", () => {
    expect(SKILL_FILES["references/integration.md"]).toContain("https://docs.sentrinel.dev/reference/");
    expect(SKILL_FILES["SKILL.md"]).toContain("https://docs.sentrinel.dev");
  });

  it("covers every SDK someone might be integrating", () => {
    const i = SKILL_FILES["references/integration.md"];
    for (const platform of ["Elysia", "Express", "Next.js", "Bun", "Django", "Flutter", "Postgres", "browser"]) {
      expect(i).toContain(platform);
    }
  });

  it("says where the key goes, in both references", () => {
    expect(SKILL_FILES["references/keys.md"]).toContain("Never on a command line");
    expect(SKILL_FILES["references/integration.md"]).toContain("never in a commit");
  });
});
