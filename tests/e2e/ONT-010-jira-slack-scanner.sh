#!/usr/bin/env bash
# tests/e2e/ONT-010-jira-slack-scanner.sh
#
# Jira/Slack org-ontology scanner e2e (ticket ONT-010). Builds the workspace,
# then hands off to the sibling driver (ONT-010-jira-slack-scanner.scenario.mjs),
# which copies the realistic-shape fixture exports (tests/e2e/fixtures/ont-010:
# 340 Jira issues with fields+changelog, 766 Slack messages with users[] and
# <@U_> mentions, plus small edge fixtures) into scratch run dirs and drives the
# SHIPPED CLI (packages/cli/dist/main.js) through the deterministic flow:
#   1. flag-driven `orangerail init --from-jira <j> --from-slack <s>` generates
#      orangerail.config.mjs + data/*.json + ANALYTICS.md (headless, no LLM);
#   2. per-person structural metrics match the pinned ground truth (AC-2/AC-8);
#   3. the generated config serves employee/team/service objects and
#      member_of/works_on/helps links over MCP tools/list (AC-6);
#   4. >=5 org findings emit with pointers incl. the ticket-less incident and
#      the post-departure approval gap (AC-5);
#   5. every report metric carries a formula and no ranking number appears
#      (AC-7);
#   6. generation is byte-deterministic across two fresh runs (AC-6/AC-8);
#   7. edge fixtures (unassigned, no-changelog, bot/unknown user) and a hostile
#      string fixture are handled without crash or code injection.
#
# RED (pre-implementation): main.ts does not know --from-jira, so in the
# config-less run dir (no Prisma schema / OpenAPI JSON) `orangerail init` reports
# "no Prisma schema or OpenAPI JSON found" and writes no config — phase 1's
# "config generated" assertion fails.

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

RED='\033[0;31m'
GREEN='\033[0;32m'
BOLD='\033[1m'
NC='\033[0m'

echo -e "${BOLD}── ONT-010 jira/slack scanner e2e ──${NC}"

# The scenario drives the SHIPPED artifacts (dist bins), not source imports.
if ! pnpm -r run build > /dev/null 2>&1; then
  echo -e "${BOLD}${RED}workspace build failed${NC}"
  echo -e "${BOLD}${RED}========== ONT-010 SCANNER E2E FAIL ==========${NC}"
  exit 1
fi

if node tests/e2e/ONT-010-jira-slack-scanner.scenario.mjs; then
  echo -e "${BOLD}${GREEN}========== ONT-010 SCANNER E2E PASS ==========${NC}"
  exit 0
fi

echo -e "${BOLD}${RED}========== ONT-010 SCANNER E2E FAIL ==========${NC}"
exit 1
