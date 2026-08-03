#!/usr/bin/env bash
# tests/e2e/ONT-087-examples-run-as-documented.sh
#
# Examples-as-documented e2e (ticket section 5): builds the workspace once, then
# hands off to the sibling driver
# (ONT-087-examples-run-as-documented.scenario.mjs), which discovers every
# directory under examples/, lifts the ```bash fences out of that example's
# "## Run it" README section, and executes them verbatim — twice each, the
# second time over the state the first left behind.
#
# The build below is the one documented command the driver does NOT re-run per
# example: all three READMEs open their "Run it" section with it, and running it
# three more times would test pnpm rather than the examples. Everything after it
# is executed exactly as written, in the order written, with DATABASE_URL
# stripped from the environment so a forgotten `export` line cannot be masked by
# a runner that happens to have one set.
#
# RED (pre-implementation): revert ONT-085's `export DATABASE_URL="file:./dev.db"`
# from examples/unattended-queue/README.md and this scenario fails on that
# example with prisma's "Environment variable not found: DATABASE_URL".

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

RED='\033[0;31m'
GREEN='\033[0;32m'
BOLD='\033[1m'
NC='\033[0m'

echo -e "${BOLD}── ONT-087 examples run as documented e2e ──${NC}"

# The examples spawn the SHIPPED CLI at packages/cli/dist/main.js, which is not
# committed; without this they die on "MCP error -32000: Connection closed".
if ! pnpm install > /dev/null 2>&1 || ! pnpm -r run build > /dev/null 2>&1; then
  echo -e "${BOLD}${RED}workspace build failed${NC}"
  echo -e "${BOLD}${RED}========== ONT-087 E2E FAIL ==========${NC}"
  exit 1
fi

if node tests/e2e/ONT-087-examples-run-as-documented.scenario.mjs; then
  echo -e "${BOLD}${GREEN}========== ONT-087 E2E PASS ==========${NC}"
  exit 0
fi

echo -e "${BOLD}${RED}========== ONT-087 E2E FAIL ==========${NC}"
exit 1
