#!/usr/bin/env bash
# tests/e2e/ONT-005-studio-map-mode.sh
#
# Studio map-mode e2e (ticket section 5): builds the workspace, then hands off
# to the sibling driver (ONT-005-studio-map-mode.scenario.mjs), which launches
# the real `orangerail studio --no-open --port <fixed>` process against a
# full-feature fixture ontology and drives a real browser through the
# agent-browser CLI (direct Playwright is forbidden repo-wide).
#
# Browser determinism: this script scrubs AGENT_BROWSER_HEADED so the run is
# always HEADLESS (no window ever pops up), and the driver uses an isolated
# agent-browser --session with first-run/default-browser interstitials
# suppressed via --args. The only navigation target is http://127.0.0.1:<port>.
#
# RED (pre-implementation): `orangerail studio` does not exist, so the CLI exits
# with "unknown command", the driver's server never comes up, and this script
# exits non-zero.

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

RED='\033[0;31m'
GREEN='\033[0;32m'
BOLD='\033[1m'
NC='\033[0m'

# Force headless browser driving for the whole scenario (intervention 2026-07-22).
unset AGENT_BROWSER_HEADED

echo -e "${BOLD}── ONT-005 studio map-mode e2e ──${NC}"

if ! command -v agent-browser > /dev/null 2>&1; then
  echo -e "${BOLD}${RED}agent-browser CLI not found — required for the studio e2e${NC}"
  echo -e "${BOLD}${RED}========== ONT-005 STUDIO E2E FAIL ==========${NC}"
  exit 1
fi

# The scenario drives the SHIPPED artifacts (dist bins), not source imports.
if ! pnpm -r run build > /dev/null 2>&1; then
  echo -e "${BOLD}${RED}workspace build failed${NC}"
  echo -e "${BOLD}${RED}========== ONT-005 STUDIO E2E FAIL ==========${NC}"
  exit 1
fi

if node tests/e2e/ONT-005-studio-map-mode.scenario.mjs; then
  echo -e "${BOLD}${GREEN}========== ONT-005 STUDIO E2E PASS ==========${NC}"
  exit 0
fi

echo -e "${BOLD}${RED}========== ONT-005 STUDIO E2E FAIL ==========${NC}"
exit 1
