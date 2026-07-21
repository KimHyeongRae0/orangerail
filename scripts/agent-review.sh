#!/usr/bin/env bash
# scripts/agent-review.sh
#
# Verifies that a plan or report document carries an approved agent review.
# NEEDS_REVISION or remaining placeholders → FAIL → next stage blocked.
#
# Usage:
#   ./scripts/agent-review.sh plan .docs/analysis/ONT-001_plan.md
#   ./scripts/agent-review.sh report .docs/analysis/ONT-001_report.md
#   ./scripts/agent-review.sh prompt plan|report ONT-001   # print the 3-block reviewer prompt

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$PROJECT_ROOT"

MODE="${1:-}"
TARGET="${2:-}"
EXTRA="${3:-}"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
BOLD='\033[1m'
NC='\033[0m'

fail() { GATE_LOG_DETAIL="$1"; echo -e "${RED}❌ $1${NC}" >&2; exit 1; }
info() { echo -e "${BLUE}ℹ️  $1${NC}"; }
warn() { echo -e "${YELLOW}⚠️  $1${NC}"; }

# ---- LLM-as-a-judge rubric (fixed scorecard, verified mechanically) ----
# One line per item: <ID><TAB><criterion>. The reviewer must score EVERY item
# PASS / FAIL / N/A with one line of concrete evidence. The verification mode
# rejects: a missing/unjudged row, an empty evidence cell, and the inconsistent
# combination "any FAIL row + verdict APPROVED".
rubric_items() {
  if [[ "$1" == "plan" ]]; then
    cat <<'EOF'
P1	Scope fidelity: the plan stays inside the ticket's Scope.Allowed / NotAllowed and addresses every AC
P2	Step granularity: steps touch 1-3 files each and are independently verifiable
P3	Decision consistency: no conflict with DESIGN.md decisions or docs/DECISIONS.md
P4	Test plan: concrete e2e file(s) with explicit RED and GREEN conditions covering each AC
P5	Risk coverage: risks, mitigations, and Out of Scope are explicit
P6	Language policy: the plan and referenced artifacts are English-only (LANG-01)
P7	References consulted: the plan's References Consulted section shows the ticket's required references actually opened (Y + note), or the ticket is on the REF-01 exemption list
EOF
  else
    cat <<'EOF'
R1	AC evidence: every ticket AC is verified with reproducible gate/command output, and non-scriptable behavior is declared in the Non-Scriptable Verification section (checked via the mandated tool or explicit N/A), never silently skipped
R2	TDD integrity: the round log records a real RED (e2e FAIL) before GREEN
R3	Plan compliance: deviations from the approved plan are disclosed and justified
R4	Code match: Files Changed is accurate and claimed rules/decisions are reflected in the code
R5	CR-01 compliance: no commit/push/issue/PR/merge/release without explicit user instruction
R6	Language policy: all changed artifacts are English-only (LANG-01)
EOF
  fi
}

usage() {
  cat <<EOF
Usage:
  $0 plan   <path-to-plan.md>          plan review gate
  $0 report <path-to-report.md>        report review gate
  $0 prompt plan|report <TICKET-ID>    print the review-request prompt for the reviewer agent

Gate pass conditions:
  - "## Agent Review" section verdict is APPROVED or APPROVED_WITH_NOTES
  - every rubric item (plan: P1-P6 / report: R1-R6) is scored PASS/FAIL/N-A with evidence
  - no rubric FAIL row under an APPROVED verdict (inconsistent review)
  - a "## ... Final ..." line exists
  - the placeholder string "placeholder — review not yet written" is removed
EOF
}

[[ -z "$MODE" ]] && { usage; exit 1; }

# ---- prompt mode ----
if [[ "$MODE" == "prompt" ]]; then
  PROMPT_TYPE="$TARGET"   # plan | report
  TICKET_ID="$EXTRA"
  [[ -z "$PROMPT_TYPE" || -z "$TICKET_ID" ]] && { usage; exit 1; }

  case "$PROMPT_TYPE" in
    plan)   PROMPT_TYPE_TITLE="Plan";   REVIEW_SEC="9";  FINAL_SEC="10" ;;
    report) PROMPT_TYPE_TITLE="Report"; REVIEW_SEC="10"; FINAL_SEC="11" ;;
    *)      fail "prompt type must be 'plan' or 'report' (got: $PROMPT_TYPE)" ;;
  esac
  PROMPT_TYPE_UPPER=$(echo "$PROMPT_TYPE" | tr '[:lower:]' '[:upper:]')

  TARGET_FILE=".docs/analysis/${TICKET_ID}_${PROMPT_TYPE}.md"
  TICKET_FILE=$(find .docs/tickets -name "${TICKET_ID}_*.md" -print -quit 2>/dev/null || true)

  echo -e "${BOLD}===== ${PROMPT_TYPE_UPPER} REVIEW request prompt (send to the reviewer agent) =====${NC}"
  echo ""
  cat <<EOF
You are the review agent for the ${PROMPT_TYPE} document of the orangerail project
(a TypeScript library that turns a zod-declared domain ontology into two rails:
generated agent-facing docs and a governed MCP server with human-in-the-loop
approvals and a tamper-evident audit log). The normative spec is DESIGN.md
(Korean, LANG-01 allowlisted).

## CARDINAL RULE (must acknowledge)
GitHub-external actions (commit/push/issue/PR/merge/release) are forbidden without an
explicit user instruction. This review itself is read-only — do not run git mutations,
and do not write comments recommending commit/push either.

## LANG-01 (must acknowledge)
This repository is English-only (sole allowlisted exception: DESIGN.md, the Korean
normative spec — product data, not prose). Write your entire review in English. Flag
any non-allowlisted Korean text you find in the reviewed artifacts as a Blocker.

## Context (read first, in this order)
1. CLAUDE.md                  (project instructions, rules CR-01 / LANG-01)
2. docs/WORKFLOW.md           (the 9-stage gate cycle — you are gate ${PROMPT_TYPE_TITLE} review)
3. DESIGN.md                  (product design + decision log — Korean, allowlisted)
4. docs/DECISIONS.md          (build-time decision log DEC-###, if present)
5. ${TICKET_FILE:-".docs/tickets/${TICKET_ID}_*.md"} (current ticket — part of what you review)
6. ${TARGET_FILE}             (${PROMPT_TYPE_TITLE} document — part of what you review)

## What to review (evaluate these together)
1. **The ticket itself** — are Goal/Scope/AC/Edge Cases clear, are ACs objectively
   verifiable, are Scope.Allowed/NotAllowed narrow enough, is the edge case → e2e
   mapping adequate? If the ticket is flawed, add "ticket revision needed" to Blockers
   regardless of the verdict.
2. **The ${PROMPT_TYPE_TITLE} document** — see "Review criteria" below.
3. **The actual code changes** — (report mode only) do they match the plan + ticket,
   any rule/decision violations?

## Review criteria
EOF

  if [[ "$PROMPT_TYPE" == "plan" ]]; then
    cat <<EOF
- Are the plan steps small enough (1–3 files per step)?
- Are applied rule/decision IDs stated (LANG-01, DESIGN.md D-IDs, DECISIONS.md entries)?
- Is the risk identification sufficient?
- Is Out of Scope explicit?
- Does it match the ticket's Scope.Allowed / NotAllowed?
- Does it conflict with decisions recorded in DESIGN.md or docs/DECISIONS.md?
- **REF-01** — for a mapped ticket (ONT-002+), does §8.5 References Consulted show each
  required reference actually opened (Y + note)? ONT-001 is exempt (see check-references.sh).
- **§7 Test Plan mandatory (TDD)** — are the e2e scenario file(s), RED condition, and
  GREEN condition concrete? Is the unit-test decision justified?
- **§8 Feature Tags** — can this ticket be mapped to regression scenarios?
- **LANG-01** — any non-allowlisted non-English text in the plan or referenced
  artifacts is a Blocker.
EOF
  else
    cat <<EOF
- Is Plan Compliance (§3) accurate, step by step?
- Do the actual code changes (packages/) match the plan (inspect the code directly)?
- Is Files Changed accurate?
- **§4.0 Test Execution round log mandatory (TDD)** — are the RED → GREEN rounds
  recorded accurately?
- Were e2e test-case file(s) actually added (tests/e2e/${TICKET_ID}-*.sh)?
- In the GREEN round, did check-test-case + verify + ticket e2e + regression ALL pass?
- Is the Regression Check trustworthy?
- **§5 Non-Scriptable Verification (DEV-01)** — is behavior that no gate can verify
  (e.g. studio visual quality, CI workflow execution) either checked via the mandated
  tool (agent-browser for studio) or explicitly marked N/A with a reason?
  A silently skipped row is a Blocker.
- Are the claimed rules/decisions actually reflected in the code?
- **Is CR-01 Compliance YES** — no trace of commit/push/issue/PR executed without
  explicit user instruction (check git log + report Risks/Notes)?
- **LANG-01** — verification command: \`./scripts/check-language.sh\` must pass; any
  non-allowlisted Korean text in code, comments, docs, or fixtures is a Blocker.
EOF
  fi

  cat <<EOF

## Rubric (mandatory scorecard — the gate verifies this mechanically)
Score EVERY item below: PASS, FAIL, or N/A — nothing else. Every row needs one
line of concrete evidence (file + line, command output, or quoted text); a bare
verdict with an empty Evidence cell is rejected. Any FAIL row means your overall
verdict MUST be NEEDS_REVISION and the row must be repeated under Blockers —
APPROVED with a FAIL row is rejected as an inconsistent review.

| ID | Item | Verdict | Evidence |
|---|---|---|---|
EOF
  while IFS=$'\t' read -r RID RTEXT; do
    echo "| $RID | $RTEXT | PASS / FAIL / N/A | <one line of evidence> |"
  done < <(rubric_items "$PROMPT_TYPE")

  cat <<EOF

## Output format (use exactly this)
Fill the "## ${REVIEW_SEC}. Agent Review" section of ${TARGET_FILE} as:

\`\`\`md
### Reviewer
- Model: <model name>
- Reviewed at: $(date +%Y-%m-%d) HH:MM

### Verdict
- [x] APPROVED  (or APPROVED_WITH_NOTES, or NEEDS_REVISION)

### Rubric
| ID | Item | Verdict | Evidence |
|---|---|---|---|
(all rubric rows from above, in order, with your verdict + evidence filled in)

### Comments
1. <point>
2. <point>

### Blockers (only if NEEDS_REVISION)
- <item — include every rubric FAIL row here>
\`\`\`

Then update the Agent line in "## ${FINAL_SEC}. Final ${PROMPT_TYPE_TITLE} Status" and delete the
"_(placeholder — review not yet written)_" line.
EOF
  echo ""
  exit 0
fi

# ---- verification mode (plan / report) ----
[[ "$MODE" != "plan" && "$MODE" != "report" ]] && { usage; exit 1; }
[[ -z "$TARGET" ]] && { usage; exit 1; }
[[ ! -f "$TARGET" ]] && fail "file not found: $TARGET"

# ---- stage-order gate (workflow state stamps) ----
STATE="$PROJECT_ROOT/scripts/workflow-state.sh"
TKT_ID=$(basename "$TARGET" | sed -E 's/_(plan|report)\.md$//')
if [[ "$TKT_ID" == "$(basename "$TARGET")" ]]; then
  warn "cannot extract TICKET-ID from '$TARGET' — state gate skipped (name the file <ID>_${MODE}.md)"
  TKT_ID=""
fi

# shellcheck source=lib/gate-log.sh
source "$PROJECT_ROOT/scripts/lib/gate-log.sh"
gate_log_init "agent-review:$MODE" "${TKT_ID:--}" "${*:-}"

if [[ -n "$TKT_ID" && "$MODE" == "plan" ]]; then
  "$STATE" require "$TKT_ID" preflight \
    "plan review (stage 3) requires preflight (stage 1) — run ./scripts/preflight.sh $TKT_ID first" \
    || { GATE_LOG_DETAIL="state-gate"; exit 1; }
elif [[ -n "$TKT_ID" ]]; then
  "$STATE" require "$TKT_ID" green \
    "report review (stage 9) requires GREEN (stage 7) — run ./scripts/test-loop.sh $TKT_ID first" \
    || { GATE_LOG_DETAIL="state-gate"; exit 1; }
fi

info "Reviewing: $TARGET (mode: $MODE)"
echo ""

ERRORS=0

# 0. REF-01 reference gate (plan mode only) — the plan's References Consulted
#    section must show the ticket's required references actually opened (§6.5.1).
if [[ "$MODE" == "plan" ]]; then
  info "[0] REF-01 reference gate"
  if "$PROJECT_ROOT/scripts/check-references.sh" "$TARGET" > /dev/null 2>&1; then
    echo -e "  ${GREEN}✅${NC} references consulted (or ticket exempt) — REF-01 PASS"
  else
    echo -e "  ${RED}❌${NC} REF-01 BLOCK — run './scripts/check-references.sh $TARGET' for details"
    ERRORS=$((ERRORS + 1))
  fi
fi

# 1. required sections (number prefixes allowed)
info "[1/6] Required sections"
SEC_AGENT_RE='^## ([0-9]+\. )?Agent Review'
SEC_FINAL_RE='^## ([0-9]+\. )?Final'

check_section() {
  local label="$1"; local re="$2"
  if grep -qE "$re" "$TARGET"; then
    echo -e "  ${GREEN}✅${NC} $label"
  else
    echo -e "  ${RED}❌${NC} missing section: '$label'"
    ERRORS=$((ERRORS + 1))
  fi
}
check_section "Agent Review" "$SEC_AGENT_RE"
check_section "Final ${MODE}" "$SEC_FINAL_RE"

# 1b. mandatory TDD sections (plan: Test Plan / report: Test Execution)
if [[ "$MODE" == "plan" ]]; then
  if grep -qE '^## ([0-9]+\. )?Test Plan|^### .*Test Plan' "$TARGET"; then
    echo -e "  ${GREEN}✅${NC} Test Plan section (TDD mandatory)"
  else
    echo -e "  ${RED}❌${NC} Test Plan section missing (TDD mandatory — see _PLAN_TEMPLATE.md §7)"
    ERRORS=$((ERRORS + 1))
  fi
  if grep -qE '^## ([0-9a-z]+\.? )?Feature Tags' "$TARGET"; then
    echo -e "  ${GREEN}✅${NC} Feature Tags section (regression mapping)"
  else
    echo -e "  ${RED}❌${NC} Feature Tags section missing (see _PLAN_TEMPLATE.md §8)"
    ERRORS=$((ERRORS + 1))
  fi
else
  if grep -qE '^### 4\.0 .*[Rr]ound log|^### 4\.0 Test Execution|^## .*Test Execution' "$TARGET"; then
    echo -e "  ${GREEN}✅${NC} Test Execution section (TDD round log)"
  else
    echo -e "  ${RED}❌${NC} Test Execution section missing (_REPORT_TEMPLATE.md §4.0 — RED→GREEN round log mandatory)"
    ERRORS=$((ERRORS + 1))
  fi
  if grep -qE '^## ([0-9]+\. )?Non-Scriptable Verification' "$TARGET"; then
    echo -e "  ${GREEN}✅${NC} Non-Scriptable Verification section (DEV-01)"
  else
    echo -e "  ${RED}❌${NC} Non-Scriptable Verification section missing (_REPORT_TEMPLATE.md §5 — declare non-scriptable behavior or mark N/A)"
    ERRORS=$((ERRORS + 1))
  fi
fi

# 2. placeholders removed
echo ""
info "[2/6] Placeholders removed"
set +e
PLACEHOLDER_COUNT=$(grep -c 'placeholder — review not yet written' "$TARGET" 2>/dev/null)
set -e
PLACEHOLDER_COUNT=${PLACEHOLDER_COUNT:-0}
if [[ "$PLACEHOLDER_COUNT" -gt 0 ]]; then
  echo -e "  ${RED}❌${NC} ${PLACEHOLDER_COUNT} placeholder(s) remain → review not written"
  ERRORS=$((ERRORS + 1))
else
  echo -e "  ${GREEN}✅${NC} all placeholders removed"
fi

# 3. verdict extraction
echo ""
info "[3/6] Verdict extraction"
AGENT_SECTION=$(awk '/^## ([0-9]+\. )?Agent Review/{flag=1; next} /^## /{flag=0} flag' "$TARGET")

extract_verdict() {
  local section="$1"
  set +e
  local raw
  raw=$(echo "$section" | grep -oE '\[x\] `?(APPROVED_WITH_NOTES|NEEDS_REVISION|APPROVED)`?' 2>/dev/null | head -1)
  echo "$raw" | grep -oE '(APPROVED_WITH_NOTES|NEEDS_REVISION|APPROVED)' 2>/dev/null | head -1
  set -e
}

set +e
AGENT_VERDICT=$(extract_verdict "$AGENT_SECTION")
set -e
AGENT_VERDICT=${AGENT_VERDICT:-}

if [[ -z "$AGENT_VERDICT" ]]; then
  echo -e "  ${RED}❌${NC} agent verdict not found (no [x] checkbox)"
  ERRORS=$((ERRORS + 1))
else
  echo -e "  Agent: $AGENT_VERDICT"
fi

# 4. rubric scorecard (LLM-as-a-judge — every item judged, with evidence)
echo ""
info "[4/6] Rubric scorecard"
RUBRIC_FAILS=0
while IFS=$'\t' read -r RID RTEXT; do
  ROW=$(printf '%s\n' "$AGENT_SECTION" | awk -F'|' -v id="$RID" '
    { c2 = $2; gsub(/[ \t`*]/, "", c2) }
    c2 == id { v = $4; gsub(/[ \t`*]/, "", v)
               e = $5; gsub(/^[ \t]+|[ \t]+$/, "", e)
               print v "\t" e; exit }')
  ROW_VERDICT="${ROW%%$'\t'*}"
  ROW_EVIDENCE="${ROW#*$'\t'}"
  [[ "$ROW_EVIDENCE" == "$ROW" ]] && ROW_EVIDENCE=""
  case "$ROW_VERDICT" in
    PASS|FAIL|N/A)
      if [[ -z "$ROW_EVIDENCE" || "$ROW_EVIDENCE" == "<one line of evidence>" || "$ROW_EVIDENCE" == "<evidence>" ]]; then
        echo -e "  ${RED}❌${NC} rubric item $RID has no evidence — a bare verdict is not a review"
        ERRORS=$((ERRORS + 1))
      elif [[ "$ROW_VERDICT" == "FAIL" ]]; then
        echo -e "  ${RED}✗${NC}  $RID FAIL — $ROW_EVIDENCE"
        RUBRIC_FAILS=$((RUBRIC_FAILS + 1))
      else
        echo -e "  ${GREEN}✅${NC} $RID $ROW_VERDICT"
      fi
      ;;
    *)
      echo -e "  ${RED}❌${NC} rubric item $RID missing or unjudged (expected a '| $RID | ... | PASS/FAIL/N/A | evidence |' row)"
      ERRORS=$((ERRORS + 1))
      ;;
  esac
done < <(rubric_items "$MODE")

# 5. approved?
echo ""
info "[5/6] Verdict gate"
is_approved() { [[ "$1" == "APPROVED" || "$1" == "APPROVED_WITH_NOTES" ]]; }

GATE_PASS=true
if ! is_approved "$AGENT_VERDICT"; then
  echo -e "  ${RED}❌${NC} Agent: ${AGENT_VERDICT:-<none>} (NOT approved)"
  GATE_PASS=false
fi
if is_approved "$AGENT_VERDICT" && [[ $RUBRIC_FAILS -gt 0 ]]; then
  echo -e "  ${RED}❌${NC} inconsistent review: $RUBRIC_FAILS rubric FAIL row(s) but verdict is $AGENT_VERDICT — FAIL rows require NEEDS_REVISION"
  GATE_PASS=false
fi

# 6. TDD gate (report mode only — test-case actually exists)
echo ""
info "[6/6] TDD gate"
if [[ "$MODE" == "report" ]]; then
  TKT_ID=$(basename "$TARGET" | sed -E 's/_(report|plan)\.md$//')
  if [[ -n "$TKT_ID" && -x "$PROJECT_ROOT/scripts/check-test-case.sh" ]]; then
    if "$PROJECT_ROOT/scripts/check-test-case.sh" "$TKT_ID" > /dev/null 2>&1; then
      echo -e "  ${GREEN}✅${NC} e2e test-case gate (check-test-case.sh PASS)"
    else
      echo -e "  ${RED}❌${NC} e2e test-case gate FAIL — run './scripts/check-test-case.sh ${TKT_ID}' for details"
      GATE_PASS=false
    fi
  else
    warn "  could not extract TICKET-ID or check-test-case.sh missing — gate skipped"
  fi
else
  echo -e "  ${BLUE}ℹ️${NC}  plan mode — TDD gate is checked at the report stage"
fi

echo ""
if [[ $ERRORS -gt 0 ]]; then
  echo -e "${BOLD}${RED}========== AGENT-REVIEW FAIL (errors: $ERRORS) ==========${NC}"
  echo ""
  echo "Required actions:"
  echo "  1. add the missing sections (template: .docs/analysis/_$(echo "$MODE" | tr '[:lower:]' '[:upper:]')_TEMPLATE.md)"
  echo "  2. collect a review (3 steps):"
  echo "     a. ./scripts/agent-review.sh prompt $MODE <TICKET-ID>  →  send to the reviewer agent"
  echo "     b. paste the response into the 'Agent Review' section (plan §9 / report §10)"
  echo "     c. ./scripts/agent-review.sh $MODE <path>   # re-verify the gate"
  exit 1
fi

if ! $GATE_PASS; then
  echo -e "${BOLD}${RED}========== AGENT-REVIEW FAIL — NEEDS_REVISION ==========${NC}"
  echo ""
  if [[ "$MODE" == "plan" ]]; then
    echo "Revise the plan, then re-review. Implementation must not start."
  else
    echo "Revise the report or code, then re-review. The ticket cannot be Done."
  fi
  exit 1
fi

echo -e "${BOLD}${GREEN}========== AGENT-REVIEW PASS ==========${NC}"
if [[ -n "$TKT_ID" ]]; then
  if [[ "$MODE" == "plan" ]]; then
    "$STATE" stamp "$TKT_ID" plan-reviewed
  else
    "$STATE" stamp "$TKT_ID" report-reviewed
  fi
fi
echo ""
if [[ "$MODE" == "plan" ]]; then
  echo "✅ Plan approved → implementation may start"
  echo ""
  echo "Next:"
  echo "  1. write the test-case first: tests/e2e/<TICKET-ID>-*.sh"
  echo "  2. RED check: ./scripts/test-loop.sh <TICKET-ID> --red"
  echo "  3. implement per plan §3, then GREEN: ./scripts/test-loop.sh <TICKET-ID>"
  echo "  4. write the report: cp .docs/analysis/_REPORT_TEMPLATE.md .docs/analysis/<TICKET-ID>_report.md"
  echo "  5. report review: ./scripts/agent-review.sh prompt report <TICKET-ID>"
else
  echo "✅ Report approved → ticket Done"
  echo ""
  echo "Next:"
  echo "  1. add the human approval line to 'Final Report Status'"
  echo "  2. await the user's instruction before any commit (CR-01)"
fi
