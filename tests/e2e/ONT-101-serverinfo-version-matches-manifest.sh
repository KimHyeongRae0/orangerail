#!/usr/bin/env bash
# tests/e2e/ONT-101-serverinfo-version-matches-manifest.sh
#
# ONT-101 (#163) e2e: the version an MCP client is shown is the version npm
# installed. It was the string literal `'0.1.0'` through three releases, and
# nothing failed because nothing was looking.
#
# This wrapper builds the workspace once — `pnpm pack` ships whatever is under
# each package's dist, which is not committed — and hands off to the sibling
# driver, which packs this tree, installs the tarballs into a scratch project,
# generates an ontology, and drives a real `initialize` over stdio.
#
# WHAT IT PROVES: the assertion is made against a PACKED artifact, because the
# interesting failure is not the literal — it is whether `new URL('../package.json',
# import.meta.url)` still resolves after bundling. That is a claim about the
# tarball and it is only checkable against a tarball.
#
# RED (pre-implementation): restore the literal at packages/mcp/src/server.ts
# and the driver fails with `reported "0.1.0", installed "0.1.3"`.

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

RED='\033[0;31m'
GREEN='\033[0;32m'
BOLD='\033[1m'
NC='\033[0m'

echo -e "${BOLD}── ONT-101 serverInfo version matches manifest e2e ──${NC}"

if ! pnpm install > /dev/null 2>&1 || ! pnpm -r run build > /dev/null 2>&1; then
  echo -e "${BOLD}${RED}workspace build failed${NC}"
  echo -e "${BOLD}${RED}========== ONT-101 E2E FAIL ==========${NC}"
  exit 1
fi

if node tests/e2e/ONT-101-serverinfo-version-matches-manifest.scenario.mjs; then
  echo -e "${BOLD}${GREEN}========== ONT-101 E2E PASS ==========${NC}"
  exit 0
fi

echo -e "${BOLD}${RED}========== ONT-101 E2E FAIL ==========${NC}"
exit 1
