#!/usr/bin/env bash
# tests/e2e/ONT-002-core-lifecycle.sh
#
# Drives the ONT-002 governed action lifecycle end-to-end against the in-memory
# store. The scenario logic lives in the sibling TypeScript file
# (ONT-002-core-lifecycle.scenario.ts) so it exercises orangerail-core straight
# from source through tsx; this wrapper is the ST-05 shell entry point the e2e
# runner discovers.
#
# Scenarios (ticket §5):
#   1. define -> stage (non-approver) -> wrong-role approve rejected ->
#      cs-manager approve wins -> authoritative re-eval -> execute -> audit verify
#   2. stage -> approve -> backend goes soldout -> execute yields
#      condition_changed, audited, approval stays consumed
#
# RED (pre-implementation): the engine modules do not exist yet, so the scenario
# import fails and this script exits non-zero.

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

RED='\033[0;31m'
GREEN='\033[0;32m'
BOLD='\033[1m'
NC='\033[0m'

echo -e "${BOLD}── ONT-002 core governed-lifecycle e2e ──${NC}"

if pnpm exec tsx tests/e2e/ONT-002-core-lifecycle.scenario.ts; then
  echo -e "${BOLD}${GREEN}========== ONT-002 CORE LIFECYCLE E2E PASS ==========${NC}"
  exit 0
fi

echo -e "${BOLD}${RED}========== ONT-002 CORE LIFECYCLE E2E FAIL ==========${NC}"
exit 1
