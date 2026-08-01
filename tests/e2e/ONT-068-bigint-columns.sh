#!/usr/bin/env bash
# tests/e2e/ONT-068-bigint-columns.sh
#
# A `BigInt` column travels as a decimal string, end to end (ticket section 5).
# Builds the workspace, then hands off to the sibling driver
# (ONT-068-bigint-columns.scenario.mjs), which drives the SHIPPED CLI in
# OUT-OF-REPO scratch dirs through:
#   1. a schema with no BigInt column -> byte-identical to a reference captured
#      on main;
#   2. `orangerail sync` green on a BigInt-bearing project the emitter generated;
#   3. `tools/list` publishing a BigInt as a string, with contains refused by the
#      gate rather than by the datasource;
#   4. reads at `9007199254740993` and at the BIGINT UNSIGNED maximum, malformed
#      ids taking the not-found path, and a cursor walk across 2^53;
#   5. update / create / gated delete -> approve -> check_approval -> executed,
#      the row gone, the prior row in the chain carrying the decimal string, and
#      `audit verify` reporting the chain OK;
#   6. the same on an INT-keyed model carrying a BigInt foreign key.
#
# Phases 2-6 are capability-gated (DEV-01): no reachable MySQL or no network
# install means a LOUD skip, never a silent pass. Point them at a database they
# may create and drop tables in with ORANGERAIL_ONT068_MYSQL_URL.
#
# RED (pre-implementation): phase 1 passes — it is the control. Phase 3 fails on
# `updateSigned` publishing `{"type":"integer"}`, and phase 4 fails at the first
# `_list` with `Do not know how to serialize a BigInt`, which is the defect
# exactly as reported.

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

RED='\033[0;31m'
GREEN='\033[0;32m'
BOLD='\033[1m'
NC='\033[0m'

echo -e "${BOLD}── ONT-068 BigInt columns e2e ──${NC}"

# The scenario drives the SHIPPED artifacts (dist bins), not source imports.
if ! pnpm -r run build > /dev/null 2>&1; then
  echo -e "${BOLD}${RED}workspace build failed${NC}"
  echo -e "${BOLD}${RED}========== ONT-068 E2E FAIL ==========${NC}"
  exit 1
fi

if node tests/e2e/ONT-068-bigint-columns.scenario.mjs; then
  echo -e "${BOLD}${GREEN}========== ONT-068 E2E PASS ==========${NC}"
  exit 0
fi

echo -e "${BOLD}${RED}========== ONT-068 E2E FAIL ==========${NC}"
exit 1
