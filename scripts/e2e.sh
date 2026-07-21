#!/usr/bin/env bash
# scripts/e2e.sh
#
# E2E runner for orangerail.
# Each scenario in tests/e2e/ is a standalone bash script that asserts
# output / exit codes against fixture data or a locally started bridge.
#
# Usage:
#   ./scripts/e2e.sh ONT-001    # run only this ticket's scenarios
#   ./scripts/e2e.sh            # run ALL scenarios (regression)

set -uo pipefail

PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$PROJECT_ROOT"

RED='\033[0;31m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
BOLD='\033[1m'
NC='\033[0m'

TICKET_ID="${1:-}"

# shellcheck source=lib/gate-log.sh
source "$PROJECT_ROOT/scripts/lib/gate-log.sh"
gate_log_init "e2e" "${TICKET_ID:-regression}" "${*:-}"

# No global build step here: each scenario is responsible for its own setup
# (installing/booting what it needs) so scenarios stay self-contained.

if [[ -n "$TICKET_ID" ]]; then
  SCENARIOS=$(find tests/e2e -name "${TICKET_ID}-*.sh" 2>/dev/null | sort)
  LABEL="$TICKET_ID"
else
  SCENARIOS=$(find tests/e2e -name "*.sh" ! -name "all.sh" ! -path "*/lib/*" 2>/dev/null | sort)
  LABEL="regression (all)"
fi

if [[ -z "$SCENARIOS" ]]; then
  echo -e "${RED}❌ no e2e scenarios found for: ${LABEL}${NC}" >&2
  exit 1
fi

echo -e "${BOLD}╔══════════════════════════════════════════╗${NC}"
echo -e "${BOLD}║  e2e: ${LABEL}${NC}"
echo -e "${BOLD}╚══════════════════════════════════════════╝${NC}"

PASS=0
FAIL=0
SKIPPED=0
FAILED_LIST=""

while read -r scenario; do
  # DEC-006: in REGRESSION mode only, a scenario may declare "# @live-env: VAR".
  # If VAR is unset the run fails by default; ORANGERAIL_ALLOW_MISSING_LIVE=1 skips it
  # loudly instead (must be justified in the ticket report). In ticket mode the
  # guard never applies — a ticket cannot skip its own live scenario.
  if [[ -z "$TICKET_ID" ]]; then
    REQUIRED_ENV="$(grep -m1 '^# @live-env:' "$scenario" | sed 's/^# @live-env:[[:space:]]*//' || true)"
    if [[ -n "$REQUIRED_ENV" && -z "${!REQUIRED_ENV:-}" ]]; then
      if [[ "${ORANGERAIL_ALLOW_MISSING_LIVE:-0}" == "1" ]]; then
        echo -e "\n${BOLD}${RED}⚠️  SKIPPING $scenario — $REQUIRED_ENV unset (ORANGERAIL_ALLOW_MISSING_LIVE=1; justify in report — DEC-006)${NC}" >&2
        SKIPPED=$((SKIPPED + 1))
        continue
      fi

      echo -e "\n${RED}❌ $scenario requires $REQUIRED_ENV (unset).${NC}" >&2
      echo -e "${RED}   Set it, or acknowledge with ORANGERAIL_ALLOW_MISSING_LIVE=1 and justify in the report (DEC-006).${NC}" >&2
      FAIL=$((FAIL + 1))
      FAILED_LIST="$FAILED_LIST $scenario"
      continue
    fi
  fi

  echo -e "\n${BLUE}── $scenario${NC}"
  if bash "$scenario"; then
    echo -e "${GREEN}  PASS${NC}"
    PASS=$((PASS + 1))
  else
    echo -e "${RED}  FAIL${NC}"
    FAIL=$((FAIL + 1))
    FAILED_LIST="$FAILED_LIST $scenario"
  fi
done <<< "$SCENARIOS"

echo ""
if [[ $FAIL -gt 0 ]]; then
  echo -e "${BOLD}${RED}========== E2E FAIL ($PASS pass / $FAIL fail) ==========${NC}"
  for f in $FAILED_LIST; do echo -e "${RED}  ✗ $f${NC}"; done
  exit 1
fi
if [[ $SKIPPED -gt 0 ]]; then
  echo -e "${BOLD}${GREEN}========== E2E PASS ($PASS/$PASS)${NC}${BOLD}${RED} + $SKIPPED LOUDLY SKIPPED live scenario(s) (DEC-006) ==========${NC}"
else
  echo -e "${BOLD}${GREEN}========== E2E PASS ($PASS/$PASS) ==========${NC}"
fi
