#!/usr/bin/env bash
# tests/e2e/ONT-091-op-survives-generation.sh
#
# Op-provenance e2e (ticket section 5): builds the workspace, then hands off to
# the sibling driver (ONT-091-op-survives-generation.scenario.mjs), which runs
# the SHIPPED CLI against the ont-006 fixture under two gate policies and reads
# the result back through the SHIPPED studio snapshot builder.
#
# The build is not optional here: the driver drives packages/cli/dist/main.js and
# imports packages/studio/dist/node/index.js, neither of which is committed.
#
# RED (pre-implementation): the emitter writes no `op:` key, so Phase 1 fails on
# the first generated action file.

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

RED='\033[0;31m'
GREEN='\033[0;32m'
BOLD='\033[1m'
NC='\033[0m'

echo -e "${BOLD}── ONT-091 op survives generation e2e ──${NC}"

if ! pnpm install > /dev/null 2>&1 || ! pnpm -r run build > /dev/null 2>&1; then
  echo -e "${BOLD}${RED}workspace build failed${NC}"
  echo -e "${BOLD}${RED}========== ONT-091 E2E FAIL ==========${NC}"
  exit 1
fi

if node tests/e2e/ONT-091-op-survives-generation.scenario.mjs; then
  echo -e "${BOLD}${GREEN}========== ONT-091 E2E PASS ==========${NC}"
  exit 0
fi

echo -e "${BOLD}${RED}========== ONT-091 E2E FAIL ==========${NC}"
exit 1
