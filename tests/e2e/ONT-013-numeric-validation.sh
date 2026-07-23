#!/usr/bin/env bash
# tests/e2e/ONT-013-numeric-validation.sh
#
# Numeric-input validation + degraded-input honesty e2e (ticket ONT-013). Builds
# the workspace, then hands off to the sibling driver
# (ONT-013-numeric-validation.scenario.mjs), which MUTATES the committed ONT-010
# Jira fixture (tests/e2e/fixtures/ont-010/jira-export.json) at runtime into a
# per-phase battery of scratch run dirs and drives the SHIPPED CLI
# (packages/cli/dist/main.js) over each. Pure Node stdlib — no Playwright, no
# browser (these are data/report contract assertions, no UI).
#
# The 7 phases map 1:1 to AC-1..AC-7:
#   1 (AC-1) a negative story point must not push any "share of team total"
#            above 100% (no sharePct > 100; no "carry N%" with N > 100);
#   2 (AC-2) negative points + inverted created/resolutiondate must never render
#            a negative storyPointsTotal, medianCycleDays*, or any negative
#            number in data/employee.json;
#   3 (AC-3) the excluded invalid inputs surface aggregate data-quality warnings
#            (count + field: customfield_10016; created after resolutiondate);
#   4 (AC-4) empty [] / {} / {issues:{}} exports warn "no issues recognized in
#            <path>", suppress the cheerful "extracted ... finding(s)" success,
#            and emit no placeholder findings (finding.json == []); a valid
#            all-unassigned export still succeeds and does NOT warn;
#   5 (AC-5) a 1 MB displayName is truncated (80-char prefix + "...") in
#            ANALYTICS.md while data/employee.json keeps the raw value;
#   6 (AC-6) the whole edge battery exits without crash, configs load, and the
#            hostile string stays inert (no raw onerror= in the config);
#   7 (AC-7) the both-sources run over the unmutated fixture is byte-identical
#            to the reference captured at scenario start (determinism).
#
# RED (pre-implementation): the current code is DISHONEST on messy input. The
# shipped CLI prints a sharePct up to 500% on a negative-points export, writes a
# negative storyPointsTotal and a negative medianCycleDays* when created
# post-dates resolutiondate, emits no data-quality warning for the excluded
# inputs, reports a cheerful "extracted 0 employee(s) ... 4 finding(s)" success
# with four "not evaluated" placeholders and no "no issues recognized" warning on
# an empty/wrong-shape export, and leaks a 1 MB displayName verbatim into
# ANALYTICS.md (a multi-megabyte report). So phases 1, 2, 3, 4 and 5 FAIL against
# the current code, while phases 6 and 7 (the crash-free / injection-safe /
# both-sources guarantees this ticket preserves) already pass.

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

RED='\033[0;31m'
GREEN='\033[0;32m'
BOLD='\033[1m'
NC='\033[0m'

echo -e "${BOLD}── ONT-013 numeric-validation + degraded-input honesty e2e ──${NC}"

# The scenario drives the SHIPPED artifacts (dist bins), not source imports.
if ! pnpm -r run build > /dev/null 2>&1; then
  echo -e "${BOLD}${RED}workspace build failed${NC}"
  echo -e "${BOLD}${RED}========== ONT-013 NUMERIC-VALIDATION E2E FAIL ==========${NC}"
  exit 1
fi

if node tests/e2e/ONT-013-numeric-validation.scenario.mjs; then
  echo -e "${BOLD}${GREEN}========== ONT-013 NUMERIC-VALIDATION E2E PASS ==========${NC}"
  exit 0
fi

echo -e "${BOLD}${RED}========== ONT-013 NUMERIC-VALIDATION E2E FAIL ==========${NC}"
exit 1
