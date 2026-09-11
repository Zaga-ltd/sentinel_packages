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
# The source lives in https://github.com/Zaga-ltd/sentinel_packages under mcp/.

set -euo pipefail

VERSION="0.1.0"
BASE_URL="${SENTRINEL_INSTALL_BASE:-https://sentrinel.dev}"
INSTALL_DIR="${SENTRINEL_HOME:-$HOME/.sentrinel}"
BIN_DIR="${SENTRINEL_BIN_DIR:-$HOME/.local/bin}"
ENV_FILE="$INSTALL_DIR/env"
API_URL="${SENTRINEL_API_URL:-https://api.sentrinel.dev}"
API_KEY="${SENTRINEL_API_KEY:-}"

say()  { printf '  %s\n' "$*"; }
fail() { printf '\n  %s\n\n' "$*" >&2; exit 1; }

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

# Download to .tmp and move into place, so an interrupted run never leaves a
# half-written bundle that an agent will happily try to execute.
fetch() {
  local name="$1" dest="$INSTALL_DIR/$1"
  curl -fsSL "$BASE_URL/$name" -o "$dest.tmp" \
    || fail "Could not download $BASE_URL/$name"
  # A CDN that 404s to the marketing site would otherwise install an HTML page.
  head -c 200 "$dest.tmp" | grep -qi '<!doctype\|<html' \
    && { rm -f "$dest.tmp"; fail "$BASE_URL/$name returned a web page, not the bundle."; }
  mv "$dest.tmp" "$dest"
  chmod 0644 "$dest"
}

say "Downloading the MCP server and CLI…"
fetch sentrinel-mcp.js
fetch sentrinel-cli.js

# Launchers rather than symlinks: the bundle needs `bun` to run it, an agent's
# config gets a bare command name it can spawn with no shell, and the key comes
# from the env file below rather than from anybody's argv. Variables already in
# the environment win, so a one-off `SENTRINEL_API_KEY=… sentrinel issues` still
# works.
launcher() {
  cat > "$BIN_DIR/$1" <<LAUNCH
#!/usr/bin/env bash
if [ -f "$ENV_FILE" ]; then
  while IFS='=' read -r k v; do
    case "\$k" in ''|'#'*) continue ;; esac
    [ -n "\${!k:-}" ] || export "\$k=\$v"
  done < "$ENV_FILE"
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
  claude mcp remove sentrinel --scope user >/dev/null 2>&1 || true
  if claude mcp add sentrinel --scope user -- "$BIN_DIR/sentrinel-mcp" >/dev/null 2>&1; then
    REGISTERED=yes
    say "Registered with Claude Code (user scope)."
  else
    say "Could not register with Claude Code — add it yourself:"
    say "  claude mcp add sentrinel -- $BIN_DIR/sentrinel-mcp"
  fi
fi

if [ -n "$REGISTERED" ]; then
  cat <<EOF

  Done. In a Claude Code session:

    Look at Sentrinel's top unresolved issue, find the cause in this repo, and fix it.

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
