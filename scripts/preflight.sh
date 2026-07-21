#!/usr/bin/env bash
# scripts/preflight.sh
#
# Mandatory first step of every ticket (stage 1 of 9).
# 1. Verifies the project docs exist
# 2. Checks the environment (git, required dirs, node/pnpm)
# 3. Verifies the ticket exists
# 4. Stages CLAUDE.md + DESIGN.md + ticket to stdout & .docs/scratch/
#    so they are force-loaded into the agent's context
#
# Usage:
#   ./scripts/preflight.sh                  # load context without a ticket
#   ./scripts/preflight.sh ONT-001          # with a specific ticket
#   ./scripts/preflight.sh ONT-001 --quiet  # stage only, no console dump

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$PROJECT_ROOT"

SCRATCH_DIR="$PROJECT_ROOT/.docs/scratch"
TICKETS_DIR="$PROJECT_ROOT/.docs/tickets"

TICKET_ID=""
QUIET=""
for arg in "$@"; do
  case "$arg" in
    --quiet) QUIET="--quiet" ;;
    -*) echo "unknown flag: $arg" >&2; exit 1 ;;
    *) TICKET_ID="$arg" ;;
  esac
done

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
BOLD='\033[1m'
NC='\033[0m'

# shellcheck source=lib/gate-log.sh
source "$PROJECT_ROOT/scripts/lib/gate-log.sh"
gate_log_init "preflight" "${TICKET_ID:--}" "${*:-}"

fail() { GATE_LOG_DETAIL="$1"; echo -e "${RED}❌ $1${NC}" >&2; exit 1; }
ok()   { echo -e "${GREEN}✅ $1${NC}"; }
info() { echo -e "${BLUE}ℹ️  $1${NC}"; }
warn() { echo -e "${YELLOW}⚠️  $1${NC}"; }

# ---- CARDINAL RULE banner ----
echo -e "${BOLD}${RED}🚨 CARDINAL RULE (CR-01) — acknowledge before starting:${NC}"
echo -e "${RED}  GitHub-external actions (commit / push / issue / PR / merge / release)${NC}"
echo -e "${RED}  are forbidden until the user explicitly instructs that exact action.${NC}"
echo -e "${RED}  LANG-01: every repository artifact is written in English.${NC}"
echo ""

# ---- Step 1: docs exist ----
info "[1/4] Checking project docs..."
for doc in CLAUDE.md DESIGN.md docs/WORKFLOW.md; do
  [[ -f "$doc" ]] || fail "$doc not found"
  ok "$doc ($(wc -l < "$doc" | tr -d ' ') lines)"
done

# ---- Step 2: environment ----
info "[2/4] Checking environment..."
command -v git >/dev/null || fail "git not found in PATH"
[[ -d .git ]] || fail "not a git repository (run from the project root clone)"
ok "git $(git --version | awk '{print $3}')"

for dir in scripts .docs/tickets .docs/analysis tests/e2e tests/meta docs; do
  [[ -d "$dir" ]] || fail "required directory missing: $dir/"
done
ok "required directories present"

if command -v node >/dev/null; then
  ok "node $(node --version)"
else
  warn "node not found — fine for docs-only tickets, required once the workspace exists"
fi
if command -v pnpm >/dev/null; then
  ok "pnpm $(pnpm --version)"
else
  warn "pnpm not found — fine for docs-only tickets, required once the workspace exists"
fi

# ---- Step 3: ticket (optional) ----
TICKET_PATH=""
if [[ -n "$TICKET_ID" ]]; then
  info "[3/4] Checking ticket: $TICKET_ID"
  TICKET_PATH=$(find "$TICKETS_DIR" -name "${TICKET_ID}_*.md" -print -quit 2>/dev/null || true)
  [[ -z "$TICKET_PATH" ]] && fail "ticket not found: $TICKET_ID (searched $TICKETS_DIR)"
  ok "Ticket: $TICKET_PATH"
else
  warn "[3/4] No ticket ID — general context-load mode"
fi

# ---- Step 4: stage to scratch ----
info "[4/4] Staging context..."
mkdir -p "$SCRATCH_DIR"
TS="$(date +%Y%m%d-%H%M%S)"
STAGE_FILE="$SCRATCH_DIR/preflight-${TICKET_ID:-noticket}-${TS}.md"

{
  echo "# Preflight Stage"
  echo "- Generated: $(date)"
  echo "- Ticket: ${TICKET_ID:-(none)}"
  [[ -n "$TICKET_PATH" ]] && echo "- Ticket Path: $TICKET_PATH"
  echo ""
  echo "## 0. CARDINAL RULE (CR-01)"
  echo ""
  echo "GitHub-external actions (commit / push / issue / PR / merge / release /"
  echo "workflow trigger) are FORBIDDEN until the user explicitly instructs that"
  echo "exact action. This rule overrides every other rule in this project."
  echo "On violation: stop, disclose, restore."
  echo ""
  echo "## 0b. LANG-01"
  echo ""
  echo "Every repository artifact MUST be in English. Gate: scripts/check-language.sh."
  echo ""
  echo "---"
  echo ""
  echo "## 1. Project Instructions (CLAUDE.md)"
  echo ""
  cat CLAUDE.md
  echo ""
  echo "---"
  echo ""
  echo "## 2. Design (DESIGN.md)"
  echo ""
  cat DESIGN.md
  if [[ -n "$TICKET_PATH" ]]; then
    echo ""
    echo "---"
    echo ""
    echo "## 3. Current Ticket"
    echo ""
    cat "$TICKET_PATH"
  fi
} > "$STAGE_FILE"

ok "Staged: $STAGE_FILE ($(wc -l < "$STAGE_FILE" | tr -d ' ') lines)"

# ---- state stamp (stage 1 complete) ----
if [[ -n "$TICKET_ID" ]]; then
  "$PROJECT_ROOT/scripts/workflow-state.sh" stamp "$TICKET_ID" preflight
fi

# ---- Console dump (unless quiet) ----
if [[ "$QUIET" != "--quiet" ]]; then
  echo ""
  echo -e "${BOLD}===== Project Instructions (CLAUDE.md) =====${NC}"
  cat CLAUDE.md
  echo ""
  echo -e "${BOLD}===== Design (DESIGN.md) =====${NC}"
  cat DESIGN.md
  if [[ -n "$TICKET_PATH" ]]; then
    echo ""
    echo -e "${BOLD}===== Current Ticket: $TICKET_ID =====${NC}"
    cat "$TICKET_PATH"
  fi
fi

echo ""
echo -e "${BOLD}========== Preflight complete ==========${NC}"
echo ""
echo -e "${BOLD}Next steps (TDD flow):${NC}"
echo -e "  1. ${BOLD}Write plan${NC} (.docs/analysis/${TICKET_ID:-XXX}_plan.md) — §7 Test Plan is mandatory"
echo -e "  2. Plan cross-review: ${YELLOW}./scripts/agent-review.sh prompt plan ${TICKET_ID:-XXX}${NC} → send to reviewer"
echo -e "     gate: ${YELLOW}./scripts/agent-review.sh plan .docs/analysis/${TICKET_ID:-XXX}_plan.md${NC}"
echo -e "  3. ${BOLD}★ Write test-case${NC} (tests/e2e/${TICKET_ID:-XXX}-*.sh)"
echo -e "     gate: ${YELLOW}./scripts/check-test-case.sh ${TICKET_ID:-XXX}${NC}"
echo -e "  4. ${BOLD}★ RED check${NC}: ${YELLOW}./scripts/test-loop.sh ${TICKET_ID:-XXX} --red${NC} (verify PASS + e2e FAIL)"
echo -e "  5. ${BOLD}Implement${NC} (per DESIGN.md and ticket scope)"
echo -e "  6. ${BOLD}GREEN check${NC}: ${YELLOW}./scripts/test-loop.sh ${TICKET_ID:-XXX}${NC}"
echo -e "  7. Write report (§4.0 Test Execution round log mandatory)"
echo -e "  8. Report cross-review: ${YELLOW}./scripts/agent-review.sh prompt report ${TICKET_ID:-XXX}${NC}"
echo -e "     gate: ${YELLOW}./scripts/agent-review.sh report .docs/analysis/${TICKET_ID:-XXX}_report.md${NC}"
echo ""
echo -e "${RED}A ticket without an e2e test-case cannot pass.${NC}"
echo ""
