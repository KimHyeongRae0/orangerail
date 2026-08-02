#!/usr/bin/env bash
# tests/e2e/ONT-072-nonconforming-row.sh
#
# Studio e2e (ticket section 5): builds the workspace, then hands off to the
# sibling driver (ONT-072-nonconforming-row.scenario.mjs), which boots the
# SHIPPED `orangerail studio` over rows that do not match the shape
# `InstanceEmployee` declares and drives a REAL browser through the
# agent-browser CLI (direct Playwright is forbidden repo-wide):
#   1. /api/instances serves every row and names, in the ONT-071 vocabulary, the
#      fields it could not print.
#   2. selecting a person whose row carries no `complexityMix` renders the panel
#      with that metric named and every other metric intact, while the map, the
#      other people and the toolbar stay present and interactive.
#   3. a conforming row still prints its values verbatim.
#   4. a second failing row selected right after the first needs no reload.
#   5. a component that throws for an unrelated reason is caught by a boundary
#      that names the view, the root survives, and the error is still logged.
#
# RED (pre-implementation): phase 2 blanks the page. `PersonScorecard` derefs
# `employee.complexityMix.hi`, React unmounts the root, and the studio root, the
# person nodes and the toolbar all disappear with it.

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

RED='\033[0;31m'
GREEN='\033[0;32m'
BOLD='\033[1m'
NC='\033[0m'

echo -e "${BOLD}── ONT-072 nonconforming-row studio e2e ──${NC}"

# The scenario drives the SHIPPED artifacts (dist bins), not source imports.
if ! pnpm -r run build > /dev/null 2>&1; then
  echo -e "${BOLD}${RED}workspace build failed${NC}"
  echo -e "${BOLD}${RED}========== ONT-072 E2E FAIL ==========${NC}"
  exit 1
fi

if node tests/e2e/ONT-072-nonconforming-row.scenario.mjs; then
  echo -e "${BOLD}${GREEN}========== ONT-072 E2E PASS ==========${NC}"
  exit 0
fi

echo -e "${BOLD}${RED}========== ONT-072 E2E FAIL ==========${NC}"
exit 1
