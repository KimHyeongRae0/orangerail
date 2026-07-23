#!/usr/bin/env bash
# tests/e2e/ONT-011-studio-instance-graph.sh
#
# Studio instance-graph e2e (ticket ONT-011 section 5): builds the workspace,
# then hands off to the sibling driver (ONT-011-studio-instance-graph.scenario.mjs),
# which runs the SHIPPED CLI `orangerail init --from-jira … --from-slack …` on the
# ONT-010 fixture exports to generate the human-source config + data/*.json,
# launches the real `orangerail studio --no-open --port <fixed>` process against it,
# and drives a real browser through the agent-browser CLI (direct Playwright is
# forbidden repo-wide).
#
# Browser determinism: this script scrubs AGENT_BROWSER_HEADED so the run is
# always HEADLESS (no window ever pops up); the driver resets agent-browser
# (`close --all`) and uses a fresh isolated --session. The only navigation
# target is http://127.0.0.1:<port>.
#
# RED (pre-implementation): `GET /api/instances` 404s and the category-tab /
# instance-node / scorecard testids do not exist, so the driver's Phase 1
# assertion fails and this script exits non-zero.

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

RED='\033[0;31m'
GREEN='\033[0;32m'
BOLD='\033[1m'
NC='\033[0m'

# Force headless browser driving for the whole scenario.
unset AGENT_BROWSER_HEADED

echo -e "${BOLD}── ONT-011 studio instance-graph e2e ──${NC}"

if ! command -v agent-browser > /dev/null 2>&1; then
  echo -e "${BOLD}${RED}agent-browser CLI not found — required for the studio e2e${NC}"
  echo -e "${BOLD}${RED}========== ONT-011 STUDIO E2E FAIL ==========${NC}"
  exit 1
fi

# The scenario drives the SHIPPED artifacts (dist bins), not source imports.
if ! pnpm -r run build > /dev/null 2>&1; then
  echo -e "${BOLD}${RED}workspace build failed${NC}"
  echo -e "${BOLD}${RED}========== ONT-011 STUDIO E2E FAIL ==========${NC}"
  exit 1
fi

if node tests/e2e/ONT-011-studio-instance-graph.scenario.mjs; then
  echo -e "${BOLD}${GREEN}========== ONT-011 STUDIO E2E PASS ==========${NC}"
  exit 0
fi

echo -e "${BOLD}${RED}========== ONT-011 STUDIO E2E FAIL ==========${NC}"
exit 1
