#!/usr/bin/env bash
# tests/e2e/ONT-069-audit-append-is-total.sh
#
# Audit append totality e2e (ticket section 5): builds the workspace, then hands
# off to the sibling driver (ONT-069-audit-append-is-total.scenario.mjs), which
# drives the SHIPPED CLI and MCP server over an ontology whose values JSON
# refuses — a structure that points at itself, never a BigInt — through:
#   1. an AUTO action returning a circular result -> the chain carries a terminal
#      record with a stated fallback rendering, and `audit verify` is OK.
#   2. a GATED action whose TARGET ROW is circular -> it executes, and no
#      approval is left consumed with nothing recorded against it.
#   3. an unwritable audit.jsonl between approval and execution -> the call
#      refuses (audit_blocked), nothing runs, and the SAME approvalId completes
#      once the log is writable again.
#
# RED (pre-implementation): phase 1 verifies FAILED ("incomplete execution"),
# phase 2 answers audit_blocked and leaves an orphaned consumed approval, and
# phase 3's retry answers "Already executed (consumed)." for an execution that
# never happened.

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

RED='\033[0;31m'
GREEN='\033[0;32m'
BOLD='\033[1m'
NC='\033[0m'

echo -e "${BOLD}── ONT-069 audit append totality e2e ──${NC}"

# The scenario drives the SHIPPED artifacts (dist bins), not source imports.
if ! pnpm -r run build > /dev/null 2>&1; then
  echo -e "${BOLD}${RED}workspace build failed${NC}"
  echo -e "${BOLD}${RED}========== ONT-069 E2E FAIL ==========${NC}"
  exit 1
fi

if node tests/e2e/ONT-069-audit-append-is-total.scenario.mjs; then
  echo -e "${BOLD}${GREEN}========== ONT-069 E2E PASS ==========${NC}"
  exit 0
fi

echo -e "${BOLD}${RED}========== ONT-069 E2E FAIL ==========${NC}"
exit 1
