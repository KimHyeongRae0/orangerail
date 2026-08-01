#!/usr/bin/env bash
# tests/e2e/ONT-071-unrecorded-and-studio.sh
#
# Two-surface e2e (ticket section 5): builds the workspace, then hands off to the
# sibling driver (ONT-071-unrecorded-and-studio.scenario.mjs), which drives the
# SHIPPED CLI, MCP server and studio server through:
#   1. an UNGOVERNED action whose terminal record cannot be written -> the agent
#      is told the write landed, that nothing recorded it, and not to retry.
#   2. the same outcome on a GATED action after approval -> the sentence does not
#      invite a re-stage of an approval that is already spent.
#   3. `orangerail studio` over rows carrying a BigInt, a circular reference and
#      an unprintable SORT KEY -> the page is served, every row survives, each
#      field is named, and the process exits 0.
#
# RED (pre-implementation): phases 1 and 2 answer "Unexpected stage/execute
# result." with status `error` for a write that already happened; phase 3 kills
# the studio process on the first /api/instances request, and empties the
# snapshot before it even gets there.

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

RED='\033[0;31m'
GREEN='\033[0;32m'
BOLD='\033[1m'
NC='\033[0m'

echo -e "${BOLD}── ONT-071 unrecorded-write and studio-render e2e ──${NC}"

# The scenario drives the SHIPPED artifacts (dist bins), not source imports.
if ! pnpm -r run build > /dev/null 2>&1; then
  echo -e "${BOLD}${RED}workspace build failed${NC}"
  echo -e "${BOLD}${RED}========== ONT-071 E2E FAIL ==========${NC}"
  exit 1
fi

if node tests/e2e/ONT-071-unrecorded-and-studio.scenario.mjs; then
  echo -e "${BOLD}${GREEN}========== ONT-071 E2E PASS ==========${NC}"
  exit 0
fi

echo -e "${BOLD}${RED}========== ONT-071 E2E FAIL ==========${NC}"
exit 1
