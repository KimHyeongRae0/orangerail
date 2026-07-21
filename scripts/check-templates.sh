#!/usr/bin/env bash
# scripts/check-templates.sh
#
# TMPL-01 gate — issue / PR / ticket text must not drift from its fixed template
# (DESIGN.md §8.5). The template is the single source of truth; this gate checks
# that each drafted instance carries the template's required sections, in order,
# each with a non-empty body.
#
# What is validated:
#   1. Tickets   .docs/tickets/ONT-*.md   against  .docs/tickets/_TICKET_TEMPLATE.md
#                (required "## " headings: presence + order + non-empty body)
#   2. PR drafts .docs/drafts/pr-*.md     against  .github/PULL_REQUEST_TEMPLATE.md
#                (same "## " heading check)
#
# Deferred: issue-draft validation (against .github/ISSUE_TEMPLATE/*.yml) is
# deferred until the repo is public and issue drafts actually exist (user
# simplification directive 2026-07-22) — no instances exist pre-v0, so the gate
# would only be a check with nothing to check.
#
# No instances of a kind => that kind is skipped with an info line (PASS overall
# when nothing is validated).
#
# Runs in verify.sh and in the pre-commit hook.
#
# Usage:
#   ./scripts/check-templates.sh

set -uo pipefail

PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$PROJECT_ROOT"

# shellcheck source=lib/gate-log.sh
source "$PROJECT_ROOT/scripts/lib/gate-log.sh"
gate_log_init "check-templates" "-" "${*:-}"

RED='\033[0;31m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
BOLD='\033[1m'
NC='\033[0m'

BLOCKS=0
CHECKED=0
block() { echo -e "${RED}  ✗ $1${NC}" >&2; BLOCKS=$((BLOCKS + 1)); }
info()  { echo -e "${BLUE}ℹ️  $1${NC}"; }
okline(){ echo -e "${GREEN}  ✅ $1${NC}"; }

# Non-empty body between heading at line $2 and the next "## " (or EOF) in $1.
body_nonempty() {
  local file="$1" start="$2"
  awk -v s="$start" '
    NR > s {
      if ($0 ~ /^## /) exit
      t = $0; gsub(/[ \t\r]/, "", t)
      if (t != "") { found = 1; exit }
    }
    END { exit(found ? 0 : 1) }
  ' "$file"
}

# Validate one markdown instance against a list of required headings.
# $1 instance file, $2 label, then required headings passed on stdin (one/line).
check_headings() {
  local file="$1" label="$2"
  local prev_line=0 h line
  while IFS= read -r h; do
    [[ -z "$h" ]] && continue
    line="$(grep -nxF "## $h" "$file" | head -1 | cut -d: -f1)"
    if [[ -z "$line" ]]; then
      block "TMPL-01 ($label): $file is missing required section '## $h'"
      continue
    fi
    if [[ "$line" -le "$prev_line" ]]; then
      block "TMPL-01 ($label): $file section '## $h' is out of order"
    fi
    if ! body_nonempty "$file" "$line"; then
      block "TMPL-01 ($label): $file section '## $h' has an empty body"
    fi
    prev_line="$line"
  done
}

headings_from_md() { sed -n 's/^## //p' "$1"; }

shopt -s nullglob

# ---- 1. tickets ----
TICKET_TMPL=".docs/tickets/_TICKET_TEMPLATE.md"
TICKETS=(.docs/tickets/ONT-*.md)
if [[ ${#TICKETS[@]} -eq 0 ]]; then
  info "TMPL-01: no .docs/tickets/ONT-*.md instances — skipped"
elif [[ ! -f "$TICKET_TMPL" ]]; then
  block "TMPL-01 (ticket): template missing: $TICKET_TMPL"
else
  for t in "${TICKETS[@]}"; do
    check_headings "$t" ticket < <(headings_from_md "$TICKET_TMPL")
    CHECKED=$((CHECKED + 1))
    okline "checked ticket $t"
  done
fi

# ---- 2. PR drafts ----
PR_TMPL=".github/PULL_REQUEST_TEMPLATE.md"
PRS=(.docs/drafts/pr-*.md)
if [[ ${#PRS[@]} -eq 0 ]]; then
  info "TMPL-01: no .docs/drafts/pr-*.md instances — skipped"
elif [[ ! -f "$PR_TMPL" ]]; then
  block "TMPL-01 (pr): template missing: $PR_TMPL"
else
  for p in "${PRS[@]}"; do
    check_headings "$p" pr < <(headings_from_md "$PR_TMPL")
    CHECKED=$((CHECKED + 1))
    okline "checked PR draft $p"
  done
fi

echo ""
if [[ $BLOCKS -gt 0 ]]; then
  echo -e "${BOLD}${RED}========== TMPL-01 BLOCK — template drift (${BLOCKS}) ==========${NC}" >&2
  echo -e "${RED}Fix the drafted instance to match its template's required sections.${NC}" >&2
  exit 1
fi
echo -e "${GREEN}✅ TMPL-01 PASS — ${CHECKED} instance(s) match their templates${NC}"
