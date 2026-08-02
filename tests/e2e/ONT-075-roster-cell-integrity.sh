#!/usr/bin/env bash
# tests/e2e/ONT-075-roster-cell-integrity.sh
#
# CLI e2e (ticket section 5): builds the workspace, then hands off to the sibling
# driver (ONT-075-roster-cell-integrity.scenario.mjs), which runs the SHIPPED
# `orangerail init --from-jira` over two Jira exports:
#   1. a hostile export — a display name carrying `|`, a display name carrying
#      CRLF, and two story-point values that each pass the scanner's finite
#      guard and sum to Infinity. Every roster row must keep its column count,
#      every name must survive whole, and the overflow must be named in
#      ONT-071's vocabulary instead of printed as a number.
#   2. a conforming export — ANALYTICS.md must be byte-identical to the
#      reference the merge-base binary emitted (fixtures/ont-075/reference).
#
# RED (pre-implementation): phase 1 fails at the row count. The CRLF name splits
# one row into two, so the table carries 5 rows for 4 people, and the pipe-
# carrying name gives its person 15 cells in a 12-column table — a row that
# reads 999 tickets and `yes` story points for someone with 1 ticket and 5 points.

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

RED='\033[0;31m'
GREEN='\033[0;32m'
BOLD='\033[1m'
NC='\033[0m'

echo -e "${BOLD}── ONT-075 roster cell integrity e2e ──${NC}"

# The scenario drives the SHIPPED artifact (dist bin), not a source import.
if ! pnpm -r run build > /dev/null 2>&1; then
  echo -e "${BOLD}${RED}workspace build failed${NC}"
  echo -e "${BOLD}${RED}========== ONT-075 E2E FAIL ==========${NC}"
  exit 1
fi

if node tests/e2e/ONT-075-roster-cell-integrity.scenario.mjs; then
  echo -e "${BOLD}${GREEN}========== ONT-075 E2E PASS ==========${NC}"
  exit 0
fi

echo -e "${BOLD}${RED}========== ONT-075 E2E FAIL ==========${NC}"
exit 1
