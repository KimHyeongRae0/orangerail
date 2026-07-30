#!/usr/bin/env bash
# tests/e2e/ONT-056-init-gating-default.sh
#
# `orangerail init --gate` default e2e (ticket section 5): builds the workspace,
# then hands off to the sibling driver (ONT-056-init-gating-default.scenario.mjs),
# which drives the SHIPPED CLI over the ont-056 Prisma/SQLite fixture through:
#   1. init with no --gate  -> the two deletes gated, the other four not; the
#      un-gated headers say so; an un-gated update keeps target/targetIdFrom; the
#      init summary, `orangerail status` and the governance baseline note all
#      quote 2 of 6; a `sync` straight after is clean.
#   2. against a real SQLite database -> the generated `updateOrder` EXECUTES on
#      the agent's call and the row changes, the generated `deleteOrder` STAGES
#      and the row stays until a human approves, and `audit verify` passes over a
#      chain that holds both.
#   3. --gate all gates 6 of 6, --gate none gates 0 of 6, an unknown value refuses
#      with exit 1 and writes nothing.
#
# RED (pre-implementation): init gated every generated action, so phase 1 fails
# at its first assertion (`createCustomer.mjs` carries the gate the default is
# meant to leave off) and phase 3 fails on `--gate` not existing at all.

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

RED='\033[0;31m'
GREEN='\033[0;32m'
BOLD='\033[1m'
NC='\033[0m'

echo -e "${BOLD}── ONT-056 init gating default e2e ──${NC}"

# The scenario drives the SHIPPED artifacts (dist bins), not source imports.
if ! pnpm -r run build > /dev/null 2>&1; then
  echo -e "${BOLD}${RED}workspace build failed${NC}"
  echo -e "${BOLD}${RED}========== ONT-056 E2E FAIL ==========${NC}"
  exit 1
fi

if node tests/e2e/ONT-056-init-gating-default.scenario.mjs; then
  echo -e "${BOLD}${GREEN}========== ONT-056 E2E PASS ==========${NC}"
  exit 0
fi

echo -e "${BOLD}${RED}========== ONT-056 E2E FAIL ==========${NC}"
exit 1
