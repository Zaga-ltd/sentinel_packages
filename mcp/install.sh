#!/usr/bin/env bash
# ─── Sentrinel for coding agents — installer ─────────────────────────────────
#
#   curl -fsSL https://sentrinel.dev/install-mcp.sh | bash
#
# Configure as you install, and Claude Code is registered for you — one line,
# nothing left to paste:
#
#   curl -fsSL https://sentrinel.dev/install-mcp.sh | \
#     SENTRINEL_API_KEY=snt_mcp_… \
#     bash
#
# Downloads two single-file bundles — the MCP server and the CLI — and puts
# `sentrinel-mcp` and `sentrinel` on your PATH. No clone, no `bun install`, no
# sudo: everything lands under ~/.sentrinel and ~/.local/bin. Re-running
# upgrades in place and leaves configuration alone.
#
# The key is written to ~/.sentrinel/env (0600) and read by the commands
# themselves, so it never appears in any agent's config or in `ps` output.
#
# It also installs the agent skill — how to use these tools well — into
# ~/.claude/skills when Claude is present. SENTRINEL_SKILL=0 skips that; every
# other harness is `sentrinel skill install --cursor|--agents|--dir P`.
#
# The source lives in https://github.com/Zaga-ltd/sentinel_packages under mcp/.

set -euo pipefail

VERSION="0.3.0"
BASE_URL="${SENTRINEL_INSTALL_BASE:-https://sentrinel.dev}"
INSTALL_DIR="${SENTRINEL_HOME:-$HOME/.sentrinel}"
BIN_DIR="${SENTRINEL_BIN_DIR:-$HOME/.local/bin}"
API_URL="${SENTRINEL_API_URL:-https://api.sentrinel.dev}"
API_KEY="${SENTRINEL_API_KEY:-}"

# The ed25519 key the release manifest is signed with — the same one the
# installed CLI checks its own updates against. apps/web/build.ts writes it in
# from packages/mcp/src/update-key.ts when the site is built; while it is the
# placeholder, the bundles are checked against the manifest's checksums only.
UPDATE_PUBLIC_KEY="REPLACE_WITH_PUBLIC_KEY_BASE64"

say()  { printf '  %s\n' "$*"; }
fail() { printf '\n  %s\n\n' "$*" >&2; exit 1; }

# ─── Profiles: one per app ───────────────────────────────────────────────────
#
# A key is pinned to one app, so watching a second app means a second key — and
# without profiles the second install would overwrite the first. A profile is
# just a name: it picks the env file the launcher reads, and the name the MCP
# server is registered under.
#
#   curl … | SENTRINEL_API_KEY=snt_mcp_… SENTRINEL_PROFILE=merchant bash
#
# gives you `sentrinel-merchant` in Claude alongside plain `sentrinel`, and
# `SENTRINEL_PROFILE=merchant sentrinel issues` on the command line. The key
# still lives in a 0600 file rather than in any agent's config — only the
# profile name goes there.
PROFILE="${SENTRINEL_PROFILE:-}"
case "$PROFILE" in
  *[!A-Za-z0-9_-]*) fail "SENTRINEL_PROFILE must be letters, digits, dash or underscore." ;;
esac
ENV_FILE="$INSTALL_DIR/env${PROFILE:+.$PROFILE}"
MCP_NAME="sentrinel${PROFILE:+-$PROFILE}"

printf '\n  Sentrinel for coding agents %s\n\n' "$VERSION"

# Validate the key before doing any work.
#
# A key pasted straight from the documentation keeps the example's ellipsis. It
# has the right prefix, so a prefix check waves it through, and the failure
# lands much later as an invalid-header error from fetch — which reads as "the
# API is unreachable". Checked here, nothing is downloaded and nothing is
# written for a value that cannot work.
if [ -n "$API_KEY" ]; then
  case "$API_KEY" in
    *[!A-Za-z0-9_]*)
      fail "SENTRINEL_API_KEY is not a key — it contains characters a key cannot have. If you copied the example from the docs, that is a placeholder: use the real value from API Keys -> Generate -> AI agent." ;;
  esac
  case "$API_KEY" in
    snt_mcp_????????????????*|snt_mcprw_????????????????*) ;;
    snt_mcp_*|snt_mcprw_*)
      fail "SENTRINEL_API_KEY is too short to be a key. Copy the whole value from the dashboard." ;;
  esac
fi

command -v curl >/dev/null 2>&1 || fail "curl is required."

# The bundles are built --target=bun and run under Bun. Install it rather than
# failing on a machine that is one command away from working.
if ! command -v bun >/dev/null 2>&1; then
  say "Installing Bun…"
  curl -fsSL https://bun.sh/install | bash >/dev/null 2>&1 \
    || fail "Could not install Bun. See https://bun.sh, then re-run this."
  export PATH="$HOME/.bun/bin:$PATH"
fi
BUN_BIN="$(command -v bun)"

mkdir -p "$INSTALL_DIR" "$BIN_DIR"

# Download everything to temporary names, check it, and only then move it into
# place — so an interrupted or tampered download never leaves a bundle that an
# agent will happily try to execute. Per-process names, so two installs at once
# cannot write into each other's file.
SUFFIX=".tmp.$$"
trap 'rm -f "$INSTALL_DIR"/*"$SUFFIX"' EXIT

download() {
  local name="$1" dest="$INSTALL_DIR/$1$SUFFIX"
  curl -fsSL "$BASE_URL/$name" -o "$dest" \
    || fail "Could not download $BASE_URL/$name"
  # A CDN that 404s to the marketing site would otherwise install an HTML page.
  if head -c 200 "$dest" | grep -qi '<!doctype\|<html'; then
    fail "$BASE_URL/$name returned a web page, not the bundle."
  fi
}

# The check itself, run by Bun since it is installed by now. Its manifest
# payload is the one in packages/mcp/src/signature.ts, copied — a test there
# runs this exact text against a manifest the real signer produced, so the two
# cannot drift. It prints the version on success and the reason on failure.
#
# read, not VERIFY_JS="$(cat <<'JS' …)": macOS's bash 3.2 scans a $( … ) for
# its closing paren and trips over the quotes and parens inside the JS.
# sentrinel:verify:start
IFS= read -r -d '' VERIFY_JS <<'JS' || true
const { createHash, createPublicKey, verify } = await import("node:crypto");
const { readFileSync } = await import("node:fs");
const env = process.env;
const die = (why) => { console.error(why); process.exit(1); };
let m;
try { m = JSON.parse(readFileSync(env.SNT_MANIFEST, "utf8")); } catch { die("the release manifest is not JSON"); }
const payload = (() => {
  if (!m || typeof m.version !== "string" || !/^[0-9A-Za-z.+-]{1,64}$/.test(m.version)) return null;
  if (!m.files || typeof m.files !== "object") return null;
  const lines = ["sentrinel-mcp-manifest v1", `version ${m.version}`];
  for (const name of Object.keys(m.files).sort()) {
    const hash = m.files[name];
    if (!/^[A-Za-z0-9._-]{1,128}$/.test(name) || typeof hash !== "string" || !/^[0-9a-f]{64}$/.test(hash)) return null;
    lines.push(`file ${name} ${hash}`);
  }
  return lines.join("\n") + "\n";
})();
if (!payload) die("the release manifest is malformed");
const key = env.SNT_KEY || "";
if (key && key !== "REPLACE_WITH_PUBLIC_KEY_BASE64") {
  if (typeof m.signature !== "string" || !m.signature) die("the release manifest is not signed");
  let ok = false;
  try {
    const der = Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(key, "base64")]);
    const pub = createPublicKey({ key: der, format: "der", type: "spki" });
    ok = verify(null, Buffer.from(payload), pub, Buffer.from(m.signature, "base64"));
  } catch {}
  if (!ok) die("the release manifest's signature does not verify");
}
for (const name of (env.SNT_FILES || "").split(" ").filter(Boolean)) {
  const want = m.files[name];
  if (!want) die(`the release manifest does not list ${name}`);
  const got = createHash("sha256").update(readFileSync(`${env.SNT_DIR}/${name}${env.SNT_SUFFIX}`)).digest("hex");
  if (got !== want) die(`${name} does not match its published checksum`);
}
console.log(m.version);
JS
# sentrinel:verify:end

say "Downloading the MCP server and CLI…"
download mcp-version.json
download sentrinel-mcp.js
download sentrinel-cli.js

if ! VERIFIED="$(SNT_MANIFEST="$INSTALL_DIR/mcp-version.json$SUFFIX" SNT_KEY="$UPDATE_PUBLIC_KEY" \
    SNT_DIR="$INSTALL_DIR" SNT_SUFFIX="$SUFFIX" SNT_FILES="sentrinel-mcp.js sentrinel-cli.js" \
    "$BUN_BIN" -e "$VERIFY_JS" 2>&1)"; then
  fail "Refusing to install: ${VERIFIED:-the download could not be verified}. Nothing was changed. If this persists, the release may be mid-publish — try again in a few minutes."
fi

for name in sentrinel-mcp.js sentrinel-cli.js; do
  mv "$INSTALL_DIR/$name$SUFFIX" "$INSTALL_DIR/$name"
  chmod 0644 "$INSTALL_DIR/$name"
done

# Launchers rather than symlinks: the bundle needs `bun` to run it, an agent's
# config gets a bare command name it can spawn with no shell, and the key comes
# from the env file below rather than from anybody's argv. Variables already in
# the environment win, so a one-off `SENTRINEL_API_KEY=… sentrinel issues` still
# works.
launcher() {
  cat > "$BIN_DIR/$1" <<LAUNCH
#!/usr/bin/env bash
# Where this install lives, for the bundle: the updater replaces files here and
# the profile commands read key files from here. Always this directory, even
# if SENTRINEL_HOME is set to something else — these are the bundles it runs.
export SENTRINEL_HOME="$INSTALL_DIR"
# The profile picks which key file to read, so one binary serves every app.
# A variable already in the environment always wins, which keeps a one-off
# \`SENTRINEL_API_KEY=… sentrinel issues\` working.
_p="\${SENTRINEL_PROFILE:-}"
if [ -z "\$_p" ] && [ -f "$INSTALL_DIR/current" ]; then
  _p="\$(cat "$INSTALL_DIR/current" 2>/dev/null)"
fi
_env="$INSTALL_DIR/env\${_p:+.\$_p}"
if [ -f "\$_env" ]; then
  while IFS='=' read -r k v; do
    case "\$k" in ''|'#'*) continue ;; esac
    [ -n "\${!k:-}" ] || export "\$k=\$v"
  done < "\$_env"
fi
exec "$BUN_BIN" run "$INSTALL_DIR/$2" "\$@"
LAUNCH
  chmod 0755 "$BIN_DIR/$1"
}
launcher sentrinel-mcp sentrinel-mcp.js
launcher sentrinel     sentrinel-cli.js

# ─── Configuration ───────────────────────────────────────────────────────────
#
# Written only when a key was passed. A re-run without one keeps whatever is
# already there — upgrading should never quietly unconfigure a working install.
if [ -n "$API_KEY" ]; then
  case "$API_KEY" in
    snt_mcp_*|snt_mcprw_*) ;;
    *) say "Note: $(printf %.12s "$API_KEY")… is not an AI agent key (snt_mcp_ / snt_mcprw_). The server will refuse it and say so." ;;
  esac
  umask 077
  cat > "$ENV_FILE" <<ENV
SENTRINEL_API_URL=$API_URL
SENTRINEL_API_KEY=$API_KEY
ENV
  chmod 0600 "$ENV_FILE"
  say "Key written to $ENV_FILE (0600)."
fi

printf '\n  Installed:\n'
say "$BIN_DIR/sentrinel-mcp   the MCP server"
say "$BIN_DIR/sentrinel       the CLI"

case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) printf '\n  %s is not on your PATH. Add it:\n    export PATH="%s:$PATH"\n' "$BIN_DIR" "$BIN_DIR" ;;
esac

# ─── Claude Code ─────────────────────────────────────────────────────────────
#
# If the CLI is here, do the registration too — the point of the one-liner is
# that nothing is left to paste. No --env: the launcher reads the env file, so
# the key stays out of the MCP config and out of `ps`.
REGISTERED=""
if [ -n "$API_KEY" ] && command -v claude >/dev/null 2>&1; then
  claude mcp remove "$MCP_NAME" --scope user >/dev/null 2>&1 || true
  if [ -n "$PROFILE" ]; then
    ADD_ENV=(--env "SENTRINEL_PROFILE=$PROFILE")
  else
    ADD_ENV=()
  fi
  if claude mcp add "$MCP_NAME" --scope user "${ADD_ENV[@]}" -- "$BIN_DIR/sentrinel-mcp" >/dev/null 2>&1; then
    REGISTERED=yes
    say "Registered with Claude Code as \"$MCP_NAME\" (user scope)."
  else
    say "Could not register with Claude Code — add it yourself:"
    say "  claude mcp add $MCP_NAME ${PROFILE:+--env SENTRINEL_PROFILE=$PROFILE }-- $BIN_DIR/sentrinel-mcp"
  fi
fi

# ─── The skill ───────────────────────────────────────────────────────────────
#
# Tools without a skill get used badly: an agent that can call get_issue but
# does not know to follow it to the captured request stops at the stack trace,
# which is the part the developer already had. Installed where Claude looks
# when Claude is present; every other harness is one command away and the
# output below says which.
#
# SENTRINEL_SKILL=0 skips it, for anyone who manages their own skills.
if [ "${SENTRINEL_SKILL:-1}" != "0" ] && [ -d "$HOME/.claude" ]; then
  "$BIN_DIR/sentrinel" skill install >/dev/null 2>&1 \
    && say "Skill installed to ~/.claude/skills/sentrinel/." \
    || say "Could not install the skill — run: sentrinel skill install"
fi

if [ -n "$REGISTERED" ]; then
  cat <<EOF

  Done. In a Claude Code session:

    Look at Sentrinel's top unresolved issue, find the cause in this repo, and fix it.

  Watching a second app? A key is pinned to one app, so give it a profile:

    curl -fsSL $BASE_URL/install-mcp.sh | \\
      SENTRINEL_API_KEY=<that app's key> SENTRINEL_PROFILE=<app-name> bash

  Using another agent? The skill goes wherever it reads from:

    sentrinel skill install --cursor    .cursor/rules/sentrinel.mdc
    sentrinel skill install --agents    ./AGENTS.md   (Codex, Copilot, Amp)
    sentrinel skill                     print it, for anything else

EOF
elif [ -n "$API_KEY" ]; then
  cat <<EOF

  Point an agent at it:

    claude mcp add sentrinel -- sentrinel-mcp

EOF
else
  cat <<EOF

  Now give it a key (API Keys → Generate → AI agent) and register it:

    curl -fsSL $BASE_URL/install-mcp.sh | SENTRINEL_API_KEY=snt_mcp_… bash

EOF
fi
