#!/usr/bin/env bash
# tests/e2e/ONT-017-studio-graph-readability.sh
#
# Studio graph-readability e2e (ticket ONT-017 section 5, plan section 7): builds
# the workspace, then hands off to the sibling driver
# (ONT-017-studio-graph-readability.scenario.mjs), which runs the SHIPPED CLI
# `orangerail init --from-jira … --from-slack …` on the ONT-010 fixture exports to
# generate the human-source config + data/*.json, launches the real
# `orangerail studio --no-open --port <fixed>` process against it, and drives a real
# browser through the agent-browser CLI (direct Playwright is forbidden repo-wide).
#
# Browser determinism: this script scrubs AGENT_BROWSER_HEADED so the run is
# always HEADLESS (no window ever pops up); the driver resets agent-browser
# (`close --all`) and uses a fresh isolated --session. The only navigation
# target is http://127.0.0.1:<port>.
#
# RED (pre-implementation): in the human category there is no view switcher
# (`[data-testid="view-tab-matrix"]` / `-ownership` do not exist), no Matrix
# (`[data-testid="help-matrix"]` absent), no focus-mode fade (no `data-dim` on
# non-ego nodes), no weight-threshold control, and the network nodes overlap at
# the ONT-011 64px cap — so the driver's Phase 2 view-switcher assertion fails
# first and this script exits non-zero. A genuine RED: none of the readability
# surface is built yet.

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

RED='\033[0;31m'
GREEN='\033[0;32m'
BOLD='\033[1m'
NC='\033[0m'

# Force headless browser driving for the whole scenario.
unset AGENT_BROWSER_HEADED

echo -e "${BOLD}── ONT-017 studio graph-readability e2e ──${NC}"

if ! command -v agent-browser > /dev/null 2>&1; then
  echo -e "${BOLD}${RED}agent-browser CLI not found — required for the studio e2e${NC}"
  echo -e "${BOLD}${RED}========== ONT-017 STUDIO E2E FAIL ==========${NC}"
  exit 1
fi

# The scenario drives the SHIPPED artifacts (dist bins), not source imports.
if ! pnpm -r run build > /dev/null 2>&1; then
  echo -e "${BOLD}${RED}workspace build failed${NC}"
  echo -e "${BOLD}${RED}========== ONT-017 STUDIO E2E FAIL ==========${NC}"
  exit 1
fi

if node tests/e2e/ONT-017-studio-graph-readability.scenario.mjs; then
  echo -e "${BOLD}${GREEN}========== ONT-017 STUDIO E2E PASS ==========${NC}"
  exit 0
fi

echo -e "${BOLD}${RED}========== ONT-017 STUDIO E2E FAIL ==========${NC}"
exit 1
