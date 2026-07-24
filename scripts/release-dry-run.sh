#!/usr/bin/env bash
# scripts/release-dry-run.sh
#
# Offline, idempotent release readiness check for the five @orangerail/* packages.
# It NEVER publishes — it runs `pnpm publish --dry-run` and `pnpm pack` only, and
# inspects the produced tarballs. Safe to run any number of times.
#
# ── Release runbook (the real publish is the user's account action, CR-01) ──
#
#   1. Ensure a clean, GREEN tree: `./scripts/verify.sh` passes and the working
#      tree has no uncommitted release changes.
#   2. Verify readiness with THIS script: `./scripts/release-dry-run.sh`. It
#      asserts the recursive dry-run exits 0 and that every packed tarball is
#      publishable (no `workspace:` spec survives, `dist` is shipped).
#   3. Publish, in dependency (topological) order:
#          core -> docs-gen -> mcp -> studio -> cli
#      All five share ONE coordinated version (v0 line: 0.1.0). Because the
#      packages are scoped (@orangerail/*), their FIRST publish defaults to
#      restricted — each manifest carries `publishConfig.access: "public"`, so a
#      plain `pnpm publish` is public. If ever publishing by hand, pass
#      `--access public` explicitly.
#   4. The one-command path once this script is green:
#          pnpm -r --filter "./packages/**" publish
#      (pnpm walks the packages in topological order and rewrites the
#      `workspace:*` sibling specs to the concrete published version at publish
#      time — do NOT hand-edit them to versions.)
#
# This script is exercised end to end by tests/e2e/ONT-019-npm-publish-readiness
# (which packs the same five packages and asserts the full publish contract).

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

RED='\033[0;31m'
GREEN='\033[0;32m'
BOLD='\033[1m'
NC='\033[0m'

# Documented publish order: core -> docs-gen -> mcp -> studio -> cli.
PACKAGES=(core docs-gen mcp studio cli)

fail() {
  echo -e "${BOLD}${RED}release-dry-run FAIL:${NC} $1"
  exit 1
}

echo -e "${BOLD}── orangerail release dry-run (offline; never publishes) ──${NC}"

# 1. Recursive publish --dry-run over the release packages. This must exit 0.
#    (On a private/0.0.0 tree pnpm silently skips the packages and still exits 0,
#    so this is a sanity gate — the tarball assertions below are the real proof.)
echo "[1/2] pnpm -r publish --dry-run over packages/**"
if ! pnpm -r --filter "./packages/**" publish --dry-run --no-git-checks; then
  fail "recursive \`pnpm publish --dry-run\` did not exit 0"
fi

# 2. Pack each package and assert the tarball is publishable: no surviving
#    `workspace:` spec (uninstallable from npm) and the built `dist` is shipped.
SCRATCH="$(mktemp -d "${TMPDIR:-/tmp}/orangerail-release-dry-run.XXXXXX")"
trap 'rm -rf "$SCRATCH"' EXIT

echo "[2/2] pnpm pack each package and inspect the tarball manifest"
for pkg in "${PACKAGES[@]}"; do
  dir="packages/$pkg"
  dest="$SCRATCH/$pkg"
  mkdir -p "$dest"

  if ! ( cd "$dir" && pnpm pack --pack-destination "$dest" > /dev/null 2>&1 ); then
    fail "\`pnpm pack\` failed for $dir"
  fi

  tgz="$(find "$dest" -name '*.tgz' -maxdepth 1 | head -n 1)"
  [ -n "$tgz" ] || fail "no tarball produced for $dir"

  manifest="$(tar -xzOf "$tgz" package/package.json)"

  if printf '%s' "$manifest" | grep -q 'workspace:'; then
    fail "$dir tarball still carries a \`workspace:\` spec (uninstallable from npm)"
  fi

  if ! tar -tzf "$tgz" | grep -q '^package/dist/'; then
    fail "$dir tarball does not ship the built \`dist\`"
  fi

  echo "  ok  @orangerail/$pkg -> $(basename "$tgz")"
done

echo -e "${BOLD}${GREEN}release dry-run OK — all five packages are publish-ready${NC}"
echo "Next (user's account action, CR-01): pnpm -r --filter \"./packages/**\" publish"
