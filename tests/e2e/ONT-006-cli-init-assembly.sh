#!/usr/bin/env bash
# tests/e2e/ONT-006-cli-init-assembly.sh
#
# init-assembly e2e (ticket section 5): builds the workspace, then hands off
# to the sibling driver (ONT-006-cli-init-assembly.scenario.mjs), which copies
# the fixture repo (Prisma schema + OpenAPI JSON, hostile strings) into
# scratch run dirs and drives the SHIPPED CLI through the full flow: flag-only
# init + studio handoff (verified with a real browser via agent-browser —
# direct Playwright is forbidden repo-wide), re-run refusal, MCP tools/list on
# the generated output, double-run byte determinism, and the sync drift
# report with --accept-new.
#
# Browser determinism: AGENT_BROWSER_HEADED is scrubbed so the run is always
# headless; the only navigation target is http://127.0.0.1:4879.
#
# RED (pre-implementation): main.ts loads the config before dispatch, so
# `orangerail init --yes ...` in the config-less fixture copy exits 1 with the
# loader's "no orangerail config found" diagnostic — the studio never comes up
# and the driver fails in phase 1.

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

RED='\033[0;31m'
GREEN='\033[0;32m'
BOLD='\033[1m'
NC='\033[0m'

unset AGENT_BROWSER_HEADED

echo -e "${BOLD}── ONT-006 cli init-assembly e2e ──${NC}"

if ! command -v agent-browser > /dev/null 2>&1; then
  echo -e "${BOLD}${RED}agent-browser CLI not found — required for the studio phase${NC}"
  echo -e "${BOLD}${RED}========== ONT-006 INIT E2E FAIL ==========${NC}"
  exit 1
fi

# The scenario drives the SHIPPED artifacts (dist bins), not source imports.
if ! pnpm -r run build > /dev/null 2>&1; then
  echo -e "${BOLD}${RED}workspace build failed${NC}"
  echo -e "${BOLD}${RED}========== ONT-006 INIT E2E FAIL ==========${NC}"
  exit 1
fi

if node tests/e2e/ONT-006-cli-init-assembly.scenario.mjs; then
  echo -e "${BOLD}${GREEN}========== ONT-006 INIT E2E PASS ==========${NC}"
  exit 0
fi

echo -e "${BOLD}${RED}========== ONT-006 INIT E2E FAIL ==========${NC}"
exit 1
