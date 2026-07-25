#!/usr/bin/env bash
# tests/e2e/ONT-020-agent-fleet-governance.sh
#
# Agent-fleet governance e2e (ONT-020): builds the workspace, then hands off to
# the sibling driver (ONT-020-agent-fleet-governance.scenario.mjs), which runs the
# SHIPPED CLI `orangerail init --from-jira --from-slack` on the ONT-010 fixture to
# generate a bootable config, drops the canonical agent-fleet sample manifest in as
# data/fleet.json, launches the real `orangerail studio --no-open --port <fixed>`
# process against it, and drives a real browser through the agent-browser CLI
# (direct Playwright is forbidden repo-wide) to prove /api/fleet and the fleet
# governance view.
#
# Browser determinism: this script scrubs AGENT_BROWSER_HEADED so the run is
# always HEADLESS; the driver resets agent-browser (`close --all`) and uses a
# fresh isolated --session. The only navigation target is http://127.0.0.1:<port>.
#
# RED (pre-implementation): GET /api/fleet 404s and the agent-tab / fleet-view
# testids do not exist, so the driver's Phase 1 assertion fails and this script
# exits non-zero.

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

RED='\033[0;31m'
GREEN='\033[0;32m'
BOLD='\033[1m'
NC='\033[0m'

# Force headless browser driving for the whole scenario.
unset AGENT_BROWSER_HEADED

echo -e "${BOLD}── ONT-020 agent-fleet-governance e2e ──${NC}"

if ! command -v agent-browser > /dev/null 2>&1; then
  echo -e "${BOLD}${RED}agent-browser CLI not found — required for the studio e2e${NC}"
  echo -e "${BOLD}${RED}========== ONT-020 AGENT-FLEET E2E FAIL ==========${NC}"
  exit 1
fi

# The scenario drives the SHIPPED artifacts (dist bins), not source imports.
if ! pnpm -r run build > /dev/null 2>&1; then
  echo -e "${BOLD}${RED}workspace build failed${NC}"
  echo -e "${BOLD}${RED}========== ONT-020 AGENT-FLEET E2E FAIL ==========${NC}"
  exit 1
fi

if node tests/e2e/ONT-020-agent-fleet-governance.scenario.mjs; then
  echo -e "${BOLD}${GREEN}========== ONT-020 AGENT-FLEET E2E PASS ==========${NC}"
  exit 0
fi

echo -e "${BOLD}${RED}========== ONT-020 AGENT-FLEET E2E FAIL ==========${NC}"
exit 1
