#!/usr/bin/env bash
# scripts/workflow-state.sh
#
# Per-ticket workflow state stamps — deterministic stage-order enforcement.
# Each completed gate stamps its stage into .docs/state/<TICKET-ID>.state
# (gitignored, append-only). Later gates REQUIRE earlier stamps, so the
# 9-stage cycle cannot be entered out of order (e.g. GREEN before RED).
#
# Stages (subset of WORKFLOW.md stages that have a deciding script):
#   preflight        stage 1  stamped by preflight.sh
#   plan-reviewed    stage 3  stamped by agent-review.sh plan (PASS)
#   test-case        stage 4  stamped by test-loop.sh after check-test-case
#   red              stage 5  stamped by test-loop.sh --red (RED OK)
#   green            stage 7  stamped by test-loop.sh (GREEN)
#   report-reviewed  stage 9  stamped by agent-review.sh report (PASS)
#
# Usage:
#   ./scripts/workflow-state.sh stamp   <TICKET-ID> <stage>
#   ./scripts/workflow-state.sh require <TICKET-ID> <stage> [hint]
#   ./scripts/workflow-state.sh has     <TICKET-ID> <stage>     # silent, exit code only
#   ./scripts/workflow-state.sh show    <TICKET-ID>
#   ./scripts/workflow-state.sh reset   <TICKET-ID>
#
# Escape hatch (use only with an explicit reason, e.g. recovering a ticket
# whose state file was lost): ORANGERAIL_STATE_BYPASS=1 makes `require` warn
# instead of block. The bypass is loud by design.

set -uo pipefail

PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$PROJECT_ROOT"

STATE_DIR=".docs/state"
STAGES=(preflight plan-reviewed test-case red green report-reviewed)

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BOLD='\033[1m'
NC='\033[0m'

usage() {
  sed -n '3,30p' "$0" | sed 's/^# \{0,1\}//'
  exit 1
}

CMD="${1:-}"
TICKET_ID="${2:-}"
STAGE="${3:-}"
HINT="${4:-}"

[[ -z "$CMD" || -z "$TICKET_ID" ]] && usage
if [[ "$TICKET_ID" == */* || "$TICKET_ID" == .* ]]; then
  echo -e "${RED}❌ invalid ticket id: '$TICKET_ID'${NC}" >&2
  exit 2
fi

STATE_FILE="$STATE_DIR/${TICKET_ID}.state"

valid_stage() {
  local s
  for s in "${STAGES[@]}"; do [[ "$s" == "$1" ]] && return 0; done
  return 1
}

stage_stamped() {
  [[ -f "$STATE_FILE" ]] && grep -q "^$1	" "$STATE_FILE"
}

case "$CMD" in
  stamp)
    [[ -z "$STAGE" ]] && usage
    valid_stage "$STAGE" || { echo -e "${RED}❌ unknown stage '$STAGE' (valid: ${STAGES[*]})${NC}" >&2; exit 2; }
    mkdir -p "$STATE_DIR"
    printf '%s\t%s\n' "$STAGE" "$(date '+%Y-%m-%dT%H:%M:%S')" >> "$STATE_FILE"
    echo -e "${GREEN}✅ state: $TICKET_ID → '$STAGE' stamped${NC}"
    ;;

  has)
    [[ -z "$STAGE" ]] && usage
    valid_stage "$STAGE" || exit 2
    stage_stamped "$STAGE"
    ;;

  require)
    [[ -z "$STAGE" ]] && usage
    valid_stage "$STAGE" || { echo -e "${RED}❌ unknown stage '$STAGE' (valid: ${STAGES[*]})${NC}" >&2; exit 2; }
    if stage_stamped "$STAGE"; then
      echo -e "${GREEN}✅ state: $TICKET_ID has '$STAGE'${NC}"
      exit 0
    fi
    if [[ "${ORANGERAIL_STATE_BYPASS:-0}" == "1" ]]; then
      echo -e "${YELLOW}⚠️  STATE BYPASS: $TICKET_ID is missing '$STAGE' but ORANGERAIL_STATE_BYPASS=1 — proceeding anyway.${NC}"
      echo -e "${YELLOW}   Record why in the ticket report (Risks/Notes).${NC}"
      exit 0
    fi
    echo -e "${BOLD}${RED}========== STATE GATE BLOCK ==========${NC}" >&2
    echo -e "${RED}Ticket $TICKET_ID has no '$STAGE' stamp — a required earlier stage has not passed.${NC}" >&2
    [[ -n "$HINT" ]] && echo -e "${RED}→ $HINT${NC}" >&2
    echo -e "Current state:" >&2
    "$0" show "$TICKET_ID" >&2
    echo -e "(legitimate recovery only: ORANGERAIL_STATE_BYPASS=1 — loud, log the reason)" >&2
    exit 1
    ;;

  show)
    echo "workflow state: $TICKET_ID"
    for s in "${STAGES[@]}"; do
      if stage_stamped "$s"; then
        ts=$(grep "^$s	" "$STATE_FILE" | tail -1 | cut -f2)
        echo -e "  ${GREEN}✅ $s${NC}  ($ts)"
      else
        echo -e "  ⬜ $s"
      fi
    done
    ;;

  reset)
    if [[ -f "$STATE_FILE" ]]; then
      rm -f "$STATE_FILE"
      echo -e "${YELLOW}⚠️  state reset: $TICKET_ID (all stamps cleared)${NC}"
    else
      echo "no state for $TICKET_ID — nothing to reset"
    fi
    ;;

  *)
    usage
    ;;
esac
