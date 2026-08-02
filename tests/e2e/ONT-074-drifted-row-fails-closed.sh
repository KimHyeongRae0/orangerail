#!/usr/bin/env bash
# tests/e2e/ONT-074-drifted-row-fails-closed.sh
#
# A row that drifts from its declared schema closes the `where` gate instead of
# opening it (ticket section 5). Builds the workspace, then hands off to the
# sibling driver (ONT-074-drifted-row-fails-closed.scenario.mjs), which drives
# the SHIPPED CLI and MCP server in OUT-OF-REPO scratch dirs against a real
# generated Prisma ontology over a LIVE database — PostgreSQL first, then MySQL:
#   1. the untouched project: a row carrying a Date, a Decimal and a BigInt reads
#      unmarked and its gated action stages, is approved and executes (AC-7);
#   2. `note` is removed from the Prisma schema and the client regenerated, so
#      the row loses a declared-required field the clause never reads — the
#      action still stages (AC-3) and the read marks the field (AC-5);
#   3. `status` goes the same way — the gated action is REFUSED naming the field
#      (AC-1, AC-4), the read of the same row still succeeds with `status`
#      marked (AC-5), and the audit chain carries the refusal and verifies.
#
# Both live runs are capability-gated (DEV-01): an unreachable database or a
# failed network install means a LOUD skip, never a silent pass. Point them at
# servers they may create their own database on with
# ORANGERAIL_ONT074_POSTGRES_URL / ORANGERAIL_ONT074_MYSQL_URL.
#
# RED (against 062e527): phase 1 passes — it is the control. Phase 2 fails first
# on the read, which serves the missing `note` unmarked; with that one assertion
# relaxed the run reaches phase 3 and fails on the defect itself, by STAGING the
# action instead of refusing it.

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

RED='\033[0;31m'
GREEN='\033[0;32m'
BOLD='\033[1m'
NC='\033[0m'

echo -e "${BOLD}── ONT-074 drifted row fails closed e2e ──${NC}"

# The scenario drives the SHIPPED artifacts (dist bins), not source imports.
if ! pnpm -r run build > /dev/null 2>&1; then
  echo -e "${BOLD}${RED}workspace build failed${NC}"
  echo -e "${BOLD}${RED}========== ONT-074 E2E FAIL ==========${NC}"
  exit 1
fi

if node tests/e2e/ONT-074-drifted-row-fails-closed.scenario.mjs; then
  echo -e "${BOLD}${GREEN}========== ONT-074 E2E PASS ==========${NC}"
  exit 0
fi

echo -e "${BOLD}${RED}========== ONT-074 E2E FAIL ==========${NC}"
exit 1
