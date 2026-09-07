#!/usr/bin/env bash
# ─── Sentrinel for coding agents — installer ─────────────────────────────────
#
#   curl -fsSL https://sentrinel.dev/install-mcp.sh | bash
#
# Downloads two single-file bundles — the MCP server and the CLI — and puts
# `sentrinel-mcp` and `sentrinel` on your PATH. No clone, no `bun install`, no
# sudo: everything lands under ~/.sentrinel and ~/.local/bin. Re-running
# upgrades in place.
#
# Then point an agent at it:
#
#   claude mcp add sentrinel \
#     --env SENTRINEL_API_URL=https://api.sentrinel.dev \
#     --env SENTRINEL_API_KEY=snt_mcp_… \
#     -- sentrinel-mcp
#
# The source lives in https://github.com/Zaga-ltd/sentinel_packages under mcp/.

set -euo pipefail

VERSION="0.1.0"
BASE_URL="${SENTRINEL_INSTALL_BASE:-https://sentrinel.dev}"
INSTALL_DIR="${SENTRINEL_HOME:-$HOME/.sentrinel}"
BIN_DIR="${SENTRINEL_BIN_DIR:-$HOME/.local/bin}"

say()  { printf '  %s\n' "$*"; }
fail() { printf '\n  %s\n\n' "$*" >&2; exit 1; }

printf '\n  Sentrinel for coding agents %s\n\n' "$VERSION"

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

# Launchers rather than symlinks: the bundle needs `bun` to run it, and an
# agent's config gets a bare command name it can spawn with no shell.
launcher() {
  cat > "$BIN_DIR/$1" <<LAUNCH
#!/usr/bin/env bash
exec "$BUN_BIN" run "$INSTALL_DIR/$2" "\$@"
LAUNCH
  chmod 0755 "$BIN_DIR/$1"
}
launcher sentrinel-mcp sentrinel-mcp.js
launcher sentrinel     sentrinel-cli.js

printf '\n  Installed:\n'
say "$BIN_DIR/sentrinel-mcp   the MCP server"
say "$BIN_DIR/sentrinel       the CLI"

case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) printf '\n  %s is not on your PATH. Add it:\n    export PATH="%s:$PATH"\n' "$BIN_DIR" "$BIN_DIR" ;;
esac

cat <<EOF

  Point Claude Code at it (key from API Keys → Generate → AI agent):

    claude mcp add sentrinel \\
      --env SENTRINEL_API_URL=https://api.sentrinel.dev \\
      --env SENTRINEL_API_KEY=snt_mcp_… \\
      -- sentrinel-mcp

EOF
