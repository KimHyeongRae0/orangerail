#!/usr/bin/env bash
# tests/e2e/ONT-001-harness.sh
#
# Proves the orangerail gate harness is self-hosting (ticket ONT-001, AC-1..AC-8):
#   - verify.sh passes end-to-end in empty-workspace mode (loud warning banner)
#   - the gate self-test (check-gates.sh) passes
#   - the three new gates exist, are executable, and CLAUDE.md documents them
#   - LICENSE + .github artifacts + .docs/drafts exist
#   - no ai-hotline lineage identifiers (byte-assembled below) leak into the
#     harness artifacts (the lineage is referenced only as "ai-hotline")
#   - the workshop skills were copied in
#
# The residue pattern is byte-assembled at runtime so this scenario never
# matches itself, and the scan excludes the process docs (ticket/plan/report,
# DESIGN.md) that legitimately quote the lineage, plus vendored skills.

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

RED='\033[0;31m'
GREEN='\033[0;32m'
BOLD='\033[1m'
NC='\033[0m'

FAILS=0
pass() { echo -e "${GREEN}  ✅ $1${NC}"; }
fail() { echo -e "${RED}  ❌ $1${NC}"; FAILS=$((FAILS + 1)); }

echo -e "${BOLD}── ONT-001 harness self-hosting checks ──${NC}"

# ---- AC-3: LICENSE ----
if [[ -f LICENSE ]] && grep -q 'MIT' LICENSE && grep -q 'HyeongRae Kim' LICENSE; then
  pass "LICENSE present (MIT, HyeongRae Kim)"
else
  fail "LICENSE missing or lacks 'MIT' / 'HyeongRae Kim'"
fi

# ---- AC-5: three new gates exist and are executable ----
for g in check-no-llm.sh check-templates.sh check-references.sh; do
  if [[ -x "scripts/$g" ]]; then
    pass "scripts/$g executable"
  else
    fail "scripts/$g missing or not executable"
  fi
done

# ---- AC-1: verify.sh passes with the empty-workspace banner ----
VOUT="$(./scripts/verify.sh 2>&1)"; VRC=$?
if [[ $VRC -eq 0 ]]; then
  pass "verify.sh exits 0"
else
  fail "verify.sh exit $VRC (expected 0)"
fi
if printf '%s' "$VOUT" | grep -q 'EMPTY-WORKSPACE MODE'; then
  pass "verify.sh prints the empty-workspace warning banner"
else
  fail "verify.sh output lacks the empty-workspace warning banner"
fi

# ---- AC-2: gate self-test passes ----
if ./scripts/check-gates.sh >/dev/null 2>&1; then
  pass "check-gates.sh exits 0"
else
  fail "check-gates.sh did not exit 0"
fi

# ---- AC-4: no ai-hotline lineage identifiers in harness artifacts ----
PAT_A="$(printf 'H\x4fT-')"       # the ticket-prefix of the copy source
PAT_B="$(printf 'H\x4fTLINE')"    # the copy source's product identifier
# Exclusions are anchored with (^|/) so they hold regardless of whether grep
# prints a leading "./"; --text forces text mode so the Hangul-heavy DESIGN.md
# is scanned (and then excluded), never silently skipped as "binary".
RESIDUE="$(grep -rIna -e "$PAT_A" -e "$PAT_B" . \
  --exclude-dir=.git --exclude-dir=node_modules --exclude-dir=skills \
  --exclude-dir=scratch --exclude-dir=state 2>/dev/null \
  | grep -vE '(^|/)DESIGN\.md:' \
  | grep -vE '(^|/)ONT-001_harness-bootstrap\.md:' \
  | grep -vE '(^|/)ONT-001_plan\.md:' \
  | grep -vE '(^|/)ONT-001_report\.md:' \
  | grep -vE '(^|/)ONT-001-harness\.sh:' || true)"
if [[ -z "$RESIDUE" ]]; then
  pass "no lineage-identifier residue in harness artifacts"
else
  fail "lineage-identifier residue found:"
  printf '%s\n' "$RESIDUE" | sed 's/^/      /'
fi

# ---- AC-6: GitHub artifacts + drafts dir ----
for f in .github/ISSUE_TEMPLATE/bug_report.yml \
         .github/ISSUE_TEMPLATE/feature_request.yml \
         .github/PULL_REQUEST_TEMPLATE.md \
         .github/workflows/ci.yml; do
  if [[ -f "$f" ]]; then pass "$f present"; else fail "$f missing"; fi
done
if [[ -d .docs/drafts ]]; then pass ".docs/drafts/ present"; else fail ".docs/drafts/ missing"; fi

# ---- AC-8: CLAUDE.md documents the three new gates ----
if [[ -f CLAUDE.md ]]; then
  pass "CLAUDE.md present"
  for rule in REF-01 NOLLM-01 TMPL-01; do
    if grep -q "$rule" CLAUDE.md; then
      pass "CLAUDE.md mentions $rule"
    else
      fail "CLAUDE.md does not mention $rule"
    fi
  done
else
  fail "CLAUDE.md missing"
fi

# ---- README + skills (AC-10 skills-copy half) ----
if [[ -f README.md ]]; then pass "README.md present"; else fail "README.md missing"; fi
for s in typescript-expert vercel-react-best-practices find-skills; do
  if [[ -d ".claude/skills/$s" ]]; then
    pass ".claude/skills/$s copied"
  else
    fail ".claude/skills/$s missing"
  fi
done

echo ""
if [[ $FAILS -gt 0 ]]; then
  echo -e "${BOLD}${RED}========== ONT-001 HARNESS E2E FAIL ($FAILS check(s) failed) ==========${NC}"
  exit 1
fi
echo -e "${BOLD}${GREEN}========== ONT-001 HARNESS E2E PASS ==========${NC}"
