#!/usr/bin/env bash
# tests/e2e/ONT-014-governance-security.sh
#
# Governance security hardening e2e (ticket ONT-014, AC-1..AC-7): drives the
# SHIPPED core/CLI/MCP (dist bins) to replay the expert audit's H-AUDIT PoC and
# pin the identity/robustness gaps. Scenario logic lives in the sibling driver
# (ONT-014-governance-security.scenario.mjs, pure Node stdlib - it speaks raw
# newline-delimited JSON-RPC to `orangerail mcp` over stdio and mutates the store
# files directly, exactly like the ONT-003 driver; no Playwright, no browser).
#
# RED (pre-implementation, against the pre-fix shipped CLI/MCP): today the
# battery FAILS because the security gaps are still open -
#   - Phase 1/2: `audit verify` stays CLEAN after tail-truncating a completed
#     run (no anchored head; auto actions have no started->terminal cross-check).
#   - Phase 4: a no-adapter MCP server treats callers as the all-roles local-dev
#     identity, so an authenticated read and a governed staging both succeed.
#   - Phase 5: core `approve` accepts a self-approval (approver == requester).
#   - Phase 6: anonymous check_approval triggers execution; a throwing functional
#     `where` escapes uncaught with no resolve_error audit record.
# Phases 3 and 7 (no-false-positive / no-regression guards) pass in both states.

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

RED='\033[0;31m'
GREEN='\033[0;32m'
BOLD='\033[1m'
NC='\033[0m'

echo -e "${BOLD}── ONT-014 governance-security e2e ──${NC}"

# The scenario drives the SHIPPED artifacts (dist bins), not source imports.
if ! pnpm -r run build > /dev/null 2>&1; then
  echo -e "${BOLD}${RED}workspace build failed${NC}"
  echo -e "${BOLD}${RED}========== ONT-014 GOVERNANCE SECURITY E2E FAIL ==========${NC}"
  exit 1
fi

if node tests/e2e/ONT-014-governance-security.scenario.mjs; then
  echo -e "${BOLD}${GREEN}========== ONT-014 GOVERNANCE SECURITY E2E PASS ==========${NC}"
  exit 0
fi

echo -e "${BOLD}${RED}========== ONT-014 GOVERNANCE SECURITY E2E FAIL ==========${NC}"
exit 1
