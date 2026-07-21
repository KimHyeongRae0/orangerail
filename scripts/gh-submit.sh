#!/usr/bin/env bash
# scripts/gh-submit.sh
#
# The ONLY sanctioned way to open GitHub issues and PRs for this repo.
# Creating them with raw `gh issue create` / `gh pr create` is forbidden
# (CLAUDE.md) — this wrapper makes every submission come out identical:
#
#   - body comes from the TMPL-01-gated draft (.docs/drafts/{issue,pr}-ont-###.md)
#   - title is derived, never hand-typed:
#       issue: "ONT-###: <Title from the ticket H1>"
#       pr:    the HEAD commit title (already "ONT-###: <summary> (#N)")
#   - assignee is ALWAYS the authenticated user (resolved at runtime)
#   - labels are derived deterministically:
#       area  = first word of the ticket slug, if it is a known area
#               (harness core cli mcp studio docs-gen)
#       type  = from the branch prefix: feat->enhancement, fix->bug,
#               docs->documentation, chore->chore
#     missing labels are created on the fly (idempotent)
#
# Usage:
#   ./scripts/gh-submit.sh issue ONT-002
#   ./scripts/gh-submit.sh pr ONT-002

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$PROJECT_ROOT"

# shellcheck source=lib/gate-log.sh
source "$PROJECT_ROOT/scripts/lib/gate-log.sh"
gate_log_init "gh-submit" "${2:--}" "${*:-}"

RED='\033[0;31m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
NC='\033[0m'

fail() { GATE_LOG_DETAIL="$1"; echo -e "${RED}❌ $1${NC}" >&2; exit 1; }
ok()   { echo -e "${GREEN}✅ $1${NC}"; }
info() { echo -e "${BLUE}ℹ️  $1${NC}"; }

KIND="${1:-}"
TICKET_ID="${2:-}"
[[ "$KIND" == "issue" || "$KIND" == "pr" ]] || fail "usage: $0 issue|pr <ONT-###>"
[[ "$TICKET_ID" =~ ^ONT-[0-9][0-9][0-9]$ ]] || fail "ticket id must be ONT-### (got '${TICKET_ID}')"

TICKET_FILE=$(find .docs/tickets -name "${TICKET_ID}_*.md" -print -quit 2>/dev/null || true)
[[ -n "$TICKET_FILE" ]] || fail "ticket not found: $TICKET_ID"

LOWER_ID=$(echo "$TICKET_ID" | tr '[:upper:]' '[:lower:]')
DRAFT=".docs/drafts/${KIND}-${LOWER_ID}.md"
[[ -f "$DRAFT" ]] || fail "draft not found: $DRAFT — write the body there first (TMPL-01 flow)"

# ---- gate the drafts before anything leaves the repo ----
./scripts/check-templates.sh >/dev/null || fail "check-templates BLOCK — fix the draft before submitting"
ok "TMPL-01 gate passed for drafts"

# ---- derived title ----
if [[ "$KIND" == "issue" ]]; then
  # ticket H1: "# ONT-### — <Title>"
  H1=$(head -1 "$TICKET_FILE" | sed 's/^# *//')
  TITLE=$(echo "$H1" | sed "s/^${TICKET_ID}[[:space:]]*[—-][[:space:]]*/${TICKET_ID}: /")
else
  TITLE=$(git log -1 --format=%s)
  [[ "$TITLE" == ${TICKET_ID}:* ]] || fail "HEAD commit title '${TITLE}' does not start with '${TICKET_ID}:' — commit the ticket before opening its PR"
fi

# ---- derived labels ----
SLUG_FIRST=$(basename "$TICKET_FILE" | sed "s/^${TICKET_ID}_//; s/\.md$//" | cut -d- -f1)
AREA_LABELS="harness core cli mcp studio docs-gen"
LABELS=()
for a in $AREA_LABELS; do
  [[ "$SLUG_FIRST" == "$a" ]] && LABELS+=("$a")
done

BRANCH=$(git branch --show-current)
case "${BRANCH%%/*}" in
  feat)  LABELS+=("enhancement") ;;
  fix)   LABELS+=("bug") ;;
  docs)  LABELS+=("documentation") ;;
  chore) LABELS+=("chore") ;;
esac
[[ ${#LABELS[@]} -gt 0 ]] || fail "no label derivable (slug area '"$SLUG_FIRST"' unknown and branch '"$BRANCH"' has no typed prefix)"

# ---- ensure labels exist (idempotent), assignee = authenticated user ----
ASSIGNEE=$(gh api user --jq .login)
for l in "${LABELS[@]}"; do
  gh label create "$l" -R orangerail/orangerail 2>/dev/null || true
done

LABEL_FLAGS=()
for l in "${LABELS[@]}"; do LABEL_FLAGS+=(--label "$l"); done

info "kind=$KIND title='$TITLE' assignee=$ASSIGNEE labels=${LABELS[*]}"

if [[ "$KIND" == "issue" ]]; then
  gh issue create -R orangerail/orangerail --title "$TITLE" --body-file "$DRAFT" \
    --assignee "$ASSIGNEE" "${LABEL_FLAGS[@]}"
else
  gh pr create -R orangerail/orangerail --title "$TITLE" --body-file "$DRAFT" \
    --assignee "$ASSIGNEE" "${LABEL_FLAGS[@]}"
fi
ok "$KIND submitted"
