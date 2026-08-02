#!/usr/bin/env bash
# tests/e2e/ONT-066-store-location.sh
#
# Store-location e2e (ticket section 5): builds the workspace, then hands off to
# the sibling driver (ONT-066-store-location.scenario.mjs), which drives the
# SHIPPED CLI over the ont-056 Prisma/SQLite fixture through:
#   1. `orangerail init` -> the closing summary names the store and says an agent
#      with file tools over this directory can write it; the generated config
#      carries the relocation as a commented one-liner at the `createFileStore`
#      call; `orangerail status` reports the resolved directory and whether it is
#      inside the project, on a store that is empty and after it is moved out,
#      with the exit code unchanged in both.
#   2. against a real SQLite database -> a gated `deleteOrder` is staged, ONE
#      well-formed `resolved` line is appended to approvals.jsonl, and BOTH
#      halves are asserted: the delete EXECUTES and the row is gone (this ticket
#      is not a fix), and `orangerail audit verify` fails naming the forged
#      approval in full.
#
# RED (pre-implementation): phase 1 fails at its first assertion — the init
# summary never named the store — and again on the absent commented alternative
# and the absent `store:` line in `status`. Phase 2 passes on the merge base by
# design: it pins the behaviour the ticket measured so it cannot change silently.

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

RED='\033[0;31m'
GREEN='\033[0;32m'
BOLD='\033[1m'
NC='\033[0m'

echo -e "${BOLD}── ONT-066 store location e2e ──${NC}"

# The scenario drives the SHIPPED artifacts (dist bins), not source imports.
if ! pnpm -r run build > /dev/null 2>&1; then
  echo -e "${BOLD}${RED}workspace build failed${NC}"
  echo -e "${BOLD}${RED}========== ONT-066 E2E FAIL ==========${NC}"
  exit 1
fi

if node tests/e2e/ONT-066-store-location.scenario.mjs; then
  echo -e "${BOLD}${GREEN}========== ONT-066 E2E PASS ==========${NC}"
  exit 0
fi

echo -e "${BOLD}${RED}========== ONT-066 E2E FAIL ==========${NC}"
exit 1
