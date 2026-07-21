#!/usr/bin/env bash
# tests/e2e/ONT-003-governed-runtime.sh
#
# Cross-process governed runtime e2e (ticket §5): an agent stages a governed
# action over a real `orangerail mcp` stdio server, a human approves it from a
# separate `orangerail approvals` CLI process, execution completes on re-check,
# and `orangerail audit verify` proves one linear hash chain across both
# writers — then fails on a tampered chain. Scenario logic lives in the
# sibling driver (ONT-003-governed-runtime.scenario.mjs, pure Node stdlib —
# it speaks raw newline-delimited JSON-RPC as a deliberate wire check).
#
# RED (pre-implementation): packages/cli and packages/mcp do not exist, so
# the driver's first CLI spawn fails and this script exits non-zero.

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

RED='\033[0;31m'
GREEN='\033[0;32m'
BOLD='\033[1m'
NC='\033[0m'

echo -e "${BOLD}── ONT-003 governed-runtime e2e ──${NC}"

# The scenario drives the SHIPPED artifacts (dist bins), not source imports.
if ! pnpm -r run build > /dev/null 2>&1; then
  echo -e "${BOLD}${RED}workspace build failed${NC}"
  echo -e "${BOLD}${RED}========== ONT-003 GOVERNED RUNTIME E2E FAIL ==========${NC}"
  exit 1
fi

if node tests/e2e/ONT-003-governed-runtime.scenario.mjs; then
  echo -e "${BOLD}${GREEN}========== ONT-003 GOVERNED RUNTIME E2E PASS ==========${NC}"
  exit 0
fi

echo -e "${BOLD}${RED}========== ONT-003 GOVERNED RUNTIME E2E FAIL ==========${NC}"
exit 1
