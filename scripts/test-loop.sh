#!/usr/bin/env bash
# scripts/test-loop.sh
#
# The ticket's combined TDD gate — one verification round.
# No auto-retry / no auto-fix: report the result, the caller fixes, then re-runs.
#
# Stages:
#  1. check-test-case.sh — e2e test-case existence gate
#  2. verify.sh — static verification (language + structure + gates + Node steps)
#  3. e2e.sh <ID> — this ticket's scenarios
#  4. e2e.sh — full regression (GREEN mode only)
#
# Modes:
#  --red    : pre-implementation RED check — the ticket's e2e MUST FAIL
#             (verify must still PASS); regression is skipped
#  (default): GREEN mode — everything must PASS
#
# Usage:
#   ./scripts/test-loop.sh ONT-001            # GREEN mode
#   ./scripts/test-loop.sh ONT-001 --red      # RED mode (start of TDD)

set -uo pipefail

PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$PROJECT_ROOT"

TICKET_ID="${1:-}"
MODE="${2:-green}"
[[ "$MODE" == "--red" ]] && MODE="red"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
BOLD='\033[1m'
NC='\033[0m'

ok()   { echo -e "${GREEN}✅ $1${NC}"; }
info() { echo -e "${BLUE}ℹ️  $1${NC}"; }
fail() { GATE_LOG_DETAIL="$1"; echo -e "${RED}❌ $1${NC}" >&2; exit 1; }
step() { echo ""; echo -e "${BOLD}${BLUE}═══ $1 ═══${NC}"; }

[[ -z "$TICKET_ID" ]] && fail "usage: $0 <TICKET-ID> [--red]"

# shellcheck source=lib/gate-log.sh
source "$PROJECT_ROOT/scripts/lib/gate-log.sh"
gate_log_init "test-loop:$MODE" "$TICKET_ID" "${*:-}"

# ─── stage-order gate (workflow state stamps) ───
STATE="$PROJECT_ROOT/scripts/workflow-state.sh"
if [[ "$MODE" == "red" ]]; then
  "$STATE" require "$TICKET_ID" plan-reviewed \
    "RED (stage 5) requires an approved plan (stage 3) — run ./scripts/agent-review.sh plan .docs/analysis/${TICKET_ID}_plan.md first" \
    || { GATE_LOG_DETAIL="state-gate"; exit 1; }
else
  "$STATE" require "$TICKET_ID" red \
    "GREEN (stage 7) requires a recorded RED (stage 5) — run ./scripts/test-loop.sh $TICKET_ID --red first (a test that never failed proves nothing)" \
    || { GATE_LOG_DETAIL="state-gate"; exit 1; }
fi

echo -e "${BOLD}╔══════════════════════════════════════════╗${NC}"
echo -e "${BOLD}║  test-loop: $TICKET_ID  (mode: $MODE)${NC}"
echo -e "${BOLD}╚══════════════════════════════════════════╝${NC}"

# ─── 1. test-case gate ───
step "1/4  e2e test-case existence gate"
./scripts/check-test-case.sh "$TICKET_ID" || fail "no test-case — TDD violation (write tests/e2e/${TICKET_ID}-*.sh first)"
"$STATE" stamp "$TICKET_ID" test-case

# ─── 2. static verification ───
step "2/4  verify (language + structure + gate self-test + typecheck + lint + test + build)"
./scripts/verify.sh || fail "verify FAILED — fix static issues before anything else"

# ─── 3. ticket e2e ───
step "3/4  ticket e2e: $TICKET_ID"
set +e
./scripts/e2e.sh "$TICKET_ID"
E2E_RC=$?
set -e

if [[ "$MODE" == "red" ]]; then
  if [[ $E2E_RC -eq 0 ]]; then
    echo ""
    fail "RED check FAILED: e2e already PASSES before implementation — fake cycle. Make the scenario actually exercise the missing behavior."
  fi
  step "4/4  regression — skipped in RED mode"
  "$STATE" stamp "$TICKET_ID" red
  echo ""
  echo -e "${BOLD}${GREEN}========== RED OK (verify PASS + e2e FAIL) ==========${NC}"
  echo -e "Proceed to implementation, then run: ${YELLOW}./scripts/test-loop.sh $TICKET_ID${NC}"
  exit 0
fi

[[ $E2E_RC -ne 0 ]] && fail "ticket e2e FAILED — fix and re-run"

# ─── 4. full regression ───
step "4/4  full regression"
./scripts/e2e.sh || fail "regression FAILED — your change broke an existing scenario"

"$STATE" stamp "$TICKET_ID" green
echo ""
echo -e "${BOLD}${GREEN}========== GREEN — ALL GATES PASS ($TICKET_ID) ==========${NC}"
echo -e "Next: write ${YELLOW}.docs/analysis/${TICKET_ID}_report.md${NC} (template: _REPORT_TEMPLATE.md), then report review."
