#!/usr/bin/env bash
# tests/e2e/ONT-070-approvals-show-is-total.sh
#
# `approvals show` totality e2e (ticket section 5): builds the workspace, then
# hands off to the sibling driver (ONT-070-approvals-show-is-total.scenario.mjs),
# which stages a gated action against a row carrying a cycle, a function-valued
# column and a symbol-keyed one, and drives the SHIPPED CLI through
# `approvals list` -> `show` -> `show --full` -> `reject`.
#
# No database and no BigInt: the crash must be fixed for ANY value JSON cannot
# print, so this proof deliberately does not rest on the BigInt contract
# (ONT-068).
#
# RED (pre-implementation): `approvals show` exits 1 with
# `orangerail: Converting circular structure to JSON` and prints nothing.

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

RED='\033[0;31m'
GREEN='\033[0;32m'
BOLD='\033[1m'
NC='\033[0m'

echo -e "${BOLD}── ONT-070 approvals show totality e2e ──${NC}"

# The scenario drives the SHIPPED artifacts (dist bins), not source imports.
if ! pnpm -r run build > /dev/null 2>&1; then
  echo -e "${BOLD}${RED}workspace build failed${NC}"
  echo -e "${BOLD}${RED}========== ONT-070 E2E FAIL ==========${NC}"
  exit 1
fi

if node tests/e2e/ONT-070-approvals-show-is-total.scenario.mjs; then
  echo -e "${BOLD}${GREEN}========== ONT-070 E2E PASS ==========${NC}"
  exit 0
fi

echo -e "${BOLD}${RED}========== ONT-070 E2E FAIL ==========${NC}"
exit 1
