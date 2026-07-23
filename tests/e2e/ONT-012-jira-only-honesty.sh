#!/usr/bin/env bash
# tests/e2e/ONT-012-jira-only-honesty.sh
#
# Jira-only honesty + low-evidence robustness e2e (ticket ONT-012). Builds the
# workspace, then hands off to the sibling driver
# (ONT-012-jira-only-honesty.scenario.mjs), which MUTATES the committed ONT-010
# Jira fixture (tests/e2e/fixtures/ont-010/jira-export.json) at runtime into a
# per-phase battery of scratch run dirs and drives the SHIPPED CLI
# (packages/cli/dist/main.js) over each. Pure Node stdlib — no Playwright, no
# browser (these are data/report contract assertions, no UI).
#
# The 8 phases map 1:1 to AC-1..AC-7:
#   1 (AC-1) Jira-only helpGiven/helpReceived are "unavailable", not 0; Jira
#            metrics unchanged vs the both-sources reference;
#   2 (AC-2) no self-contradicting finding text; Slack-dependent findings marked;
#   3 (AC-3) report + CLI summary name the Jira export only + not-evaluated note;
#   4 (AC-4) empty/single-issue emit no evidence-free confident findings;
#   5 (AC-6) all-unassigned + no-changelog exit 0 and the config smoke-loads;
#   6 (AC-5) points-null complexityMix degrades to { hi:0, med:0, lo:tickets };
#   7 (AC-6) hostile strings stay inert (JSON-encoded, no onerror= in config);
#   8 (AC-7) both-sources output is byte-identical to the ONT-010 output.
#
# RED (pre-implementation): the current Jira-only output is DISHONEST. The
# shipped CLI writes helpGiven=0 (read as "helps nobody") instead of
# "unavailable"; ships self-contradicting findings ("Dave Holt is the top
# help-giver (helpGiven=0)", "0 help interactions total; they concentrate on a
# few hubs"); prints the "Jira and Slack export" header when only Jira was
# provided; emits six confident org findings on an empty (0-issue) corpus; and
# fabricates a hi/med/lo complexity spread while storyPointsTotal=0. So phases
# 1, 2, 3, 4 and 6 FAIL against the current code, while phases 5, 7 and 8 (the
# crash-free / injection-safe / both-sources guarantees this ticket preserves)
# already pass.

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

RED='\033[0;31m'
GREEN='\033[0;32m'
BOLD='\033[1m'
NC='\033[0m'

echo -e "${BOLD}── ONT-012 jira-only honesty + robustness e2e ──${NC}"

# The scenario drives the SHIPPED artifacts (dist bins), not source imports.
if ! pnpm -r run build > /dev/null 2>&1; then
  echo -e "${BOLD}${RED}workspace build failed${NC}"
  echo -e "${BOLD}${RED}========== ONT-012 HONESTY E2E FAIL ==========${NC}"
  exit 1
fi

if node tests/e2e/ONT-012-jira-only-honesty.scenario.mjs; then
  echo -e "${BOLD}${GREEN}========== ONT-012 HONESTY E2E PASS ==========${NC}"
  exit 0
fi

echo -e "${BOLD}${RED}========== ONT-012 HONESTY E2E FAIL ==========${NC}"
exit 1
