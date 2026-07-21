#!/usr/bin/env bash
# scripts/check-test-case.sh
#
# Per-ticket e2e test-case existence gate (TDD stage 4).
# A ticket passes when at least one tests/e2e/<ID>-*.sh exists and is executable.
#
# Usage:
#   ./scripts/check-test-case.sh ONT-001

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$PROJECT_ROOT"

RED='\033[0;31m'
GREEN='\033[0;32m'
BOLD='\033[1m'
NC='\033[0m'

TICKET_ID="${1:-}"
[[ -z "$TICKET_ID" ]] && { echo "usage: $0 <TICKET-ID>" >&2; exit 1; }

# shellcheck source=lib/gate-log.sh
source "$PROJECT_ROOT/scripts/lib/gate-log.sh"
gate_log_init "check-test-case" "$TICKET_ID" "${*:-}"

TICKET_FILE=$(find .docs/tickets -name "${TICKET_ID}_*.md" -print -quit 2>/dev/null || true)
if [[ -z "$TICKET_FILE" ]]; then
  echo -e "${RED}❌ ticket not found: $TICKET_ID (searched .docs/tickets/)${NC}" >&2
  exit 1
fi

CASES=$(find tests/e2e -name "${TICKET_ID}-*.sh" 2>/dev/null || true)
if [[ -z "$CASES" ]]; then
  echo -e "${BOLD}${RED}========== TEST-CASE GATE FAIL ==========${NC}"
  echo -e "${RED}No e2e scenario for $TICKET_ID — expected tests/e2e/${TICKET_ID}-*.sh${NC}"
  echo "A ticket without an e2e test-case cannot proceed (TDD, WORKFLOW.md §2.3)."
  exit 1
fi

ERRORS=0
echo "$CASES" | while read -r f; do
  if [[ -x "$f" ]]; then
    echo -e "${GREEN}✅ $f${NC}"
  else
    echo -e "${RED}❌ $f is not executable (chmod +x)${NC}"
    exit 1
  fi
done || ERRORS=1

[[ $ERRORS -ne 0 ]] && exit 1
echo -e "${BOLD}${GREEN}========== TEST-CASE GATE PASS ($TICKET_ID) ==========${NC}"
