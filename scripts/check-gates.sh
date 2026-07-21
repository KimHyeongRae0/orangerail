#!/usr/bin/env bash
# scripts/check-gates.sh
#
# Gate self-test ("the test for the gates") — golden-set regression for every
# deterministic gate script. Each case in tests/meta/cases/ plants exactly one
# violation inside a throwaway sandbox copy of the gates and asserts that the
# target gate (a) FAILS and (b) fails for the RIGHT rule (output pattern).
# Clean-pass cases (EXPECT_PASS=1) assert the opposite: the gate must PASS —
# they guard allowlists and other deliberate exemptions against leaking.
#
# Two baselines run first so a gate that false-positives on a clean tree is
# caught the same as one that misses a violation:
#   baseline A — clean docs-only skeleton: language + structure PASS
#   baseline B — minimal compliant pnpm workspace skeleton: structure PASS
#
# Sandboxes copy the CURRENT scripts/ tree, so editing a gate script and
# breaking its detection makes this gate fail immediately (verify.sh step 3).
#
# Usage:
#   ./scripts/check-gates.sh            # run baselines + all cases
#   ./scripts/check-gates.sh 05 11      # run only cases whose filename starts with these numbers

set -uo pipefail

PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$PROJECT_ROOT"

CASES_DIR="tests/meta/cases"
LIB="tests/meta/lib.sh"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
BOLD='\033[1m'
NC='\033[0m'

# shellcheck source=lib/gate-log.sh
source "$PROJECT_ROOT/scripts/lib/gate-log.sh"
gate_log_init "check-gates" "-" "${*:-}"

fail_hard() { GATE_LOG_DETAIL="$1"; echo -e "${RED}❌ $1${NC}" >&2; exit 1; }

[[ -d "$CASES_DIR" ]] || fail_hard "golden set missing: $CASES_DIR — the gate self-test cannot run (do not skip this silently)"
[[ -f "$LIB" ]] || fail_hard "helper library missing: $LIB"

# Recursion guard: anything launched from inside a sandbox must not spawn
# nested self-tests (verify.sh checks this variable before step 3).
export ORANGERAIL_GATE_SANDBOX=1

# shellcheck source=tests/meta/lib.sh
source "$LIB"

shopt -s nullglob
if [[ $# -gt 0 ]]; then
  CASE_FILES=()
  for sel in "$@"; do
    for f in "$CASES_DIR"/"$sel"*.sh; do CASE_FILES+=("$f"); done
  done
  [[ ${#CASE_FILES[@]} -eq 0 ]] && fail_hard "no cases match: $*"
else
  CASE_FILES=("$CASES_DIR"/*.sh)
  [[ ${#CASE_FILES[@]} -eq 0 ]] && fail_hard "golden set is empty: $CASES_DIR/*.sh"
fi

SANDBOXES=()
cleanup() { for sb in "${SANDBOXES[@]:-}"; do [[ -n "$sb" ]] && rm -rf "$sb"; done; }
# chain: keep the gate-log EXIT record while adding sandbox cleanup
trap 'rc=$?; cleanup; gate_log_exit "$rc"' EXIT

make_sandbox() {
  SB="$(mktemp -d "${TMPDIR:-/tmp}/orangerail-gates.XXXXXX")"
  SANDBOXES+=("$SB")
  mkdir -p "$SB/docs" "$SB/tests/e2e" "$SB/.docs/tickets" "$SB/.docs/analysis"
  cp -R scripts "$SB/scripts"
}

# ---- baselines: gates must PASS on clean trees (no false positives) ----
echo -e "${BOLD}${BLUE}── baseline A: clean docs-only skeleton${NC}"
make_sandbox
BASE_OUT="$(mktemp)"
if ! ( cd "$SB" && scripts/check-language.sh && scripts/check-structure.sh ) > "$BASE_OUT" 2>&1; then
  echo -e "${RED}❌ baseline A FAILED — a gate false-positives on a clean skeleton:${NC}"
  tail -20 "$BASE_OUT"; rm -f "$BASE_OUT"; exit 1
fi
echo -e "${GREEN}✅ baseline A — language/structure clean${NC}"

echo -e "${BOLD}${BLUE}── baseline B: compliant pnpm workspace skeleton${NC}"
make_sandbox
if ! ( cd "$SB" && plant_valid_workspace && scripts/check-structure.sh ) > "$BASE_OUT" 2>&1; then
  echo -e "${RED}❌ baseline B FAILED — a gate false-positives on a compliant workspace:${NC}"
  tail -20 "$BASE_OUT"; rm -f "$BASE_OUT"; exit 1
fi
rm -f "$BASE_OUT"
echo -e "${GREEN}✅ baseline B — workspace-mode gates clean${NC}"

# ---- cases: each planted violation must be CAUGHT by the right rule ----
CAUGHT=0
MISSED=0
MISSED_LIST=""

for case_file in "${CASE_FILES[@]}"; do
  CASE_DESC=""; GATE=""; EXPECT_PATTERN=""; EXPECT_PASS=""
  unset -f plant 2>/dev/null
  # shellcheck disable=SC1090
  source "$case_file"
  name="$(basename "$case_file" .sh)"

  if [[ -z "$GATE" ]] || ! declare -f plant >/dev/null; then
    echo -e "${RED}✗ $name — malformed case (needs GATE and plant())${NC}"
    MISSED=$((MISSED + 1)); MISSED_LIST="$MISSED_LIST $name"
    continue
  fi

  make_sandbox
  OUT="$(mktemp)"

  if ! ( cd "$SB" && plant ) > "$OUT" 2>&1; then
    echo -e "${RED}✗ $name — case setup (plant) failed:${NC}"
    tail -5 "$OUT"; rm -f "$OUT"
    MISSED=$((MISSED + 1)); MISSED_LIST="$MISSED_LIST $name"
    continue
  fi

  ( cd "$SB" && eval "$GATE" ) > "$OUT" 2>&1
  rc=$?

  if [[ "$EXPECT_PASS" == "1" ]]; then
    # clean-pass case: the gate must NOT block (guards allowlist leaks)
    if [[ $rc -ne 0 ]]; then
      echo -e "${RED}✗ $name — FALSE POSITIVE: gate blocked an allowlisted/clean tree${NC}  ($CASE_DESC)"
      tail -5 "$OUT"
      MISSED=$((MISSED + 1)); MISSED_LIST="$MISSED_LIST $name"
    elif [[ -n "$EXPECT_PATTERN" ]] && ! grep -q "$EXPECT_PATTERN" "$OUT"; then
      echo -e "${RED}✗ $name — WRONG REASON: gate passed but output lacks '$EXPECT_PATTERN'${NC}"
      tail -5 "$OUT"
      MISSED=$((MISSED + 1)); MISSED_LIST="$MISSED_LIST $name"
    else
      echo -e "${GREEN}✓ $name${NC} — clean pass ($CASE_DESC)"
      CAUGHT=$((CAUGHT + 1))
    fi
    rm -f "$OUT"
    continue
  fi

  if [[ $rc -eq 0 ]]; then
    echo -e "${RED}✗ $name — MISSED: gate passed despite planted violation${NC}  ($CASE_DESC)"
    MISSED=$((MISSED + 1)); MISSED_LIST="$MISSED_LIST $name"
  elif [[ -n "$EXPECT_PATTERN" ]] && ! grep -q "$EXPECT_PATTERN" "$OUT"; then
    echo -e "${RED}✗ $name — WRONG REASON: gate failed but output lacks '$EXPECT_PATTERN'${NC}"
    tail -5 "$OUT"
    MISSED=$((MISSED + 1)); MISSED_LIST="$MISSED_LIST $name"
  else
    echo -e "${GREEN}✓ $name${NC} — caught ($CASE_DESC)"
    CAUGHT=$((CAUGHT + 1))
  fi
  rm -f "$OUT"
done

echo ""
TOTAL=$((CAUGHT + MISSED))
if [[ $MISSED -gt 0 ]]; then
  echo -e "${BOLD}${RED}========== GATE SELF-TEST FAIL ($CAUGHT/$TOTAL caught) ==========${NC}"
  echo -e "${RED}missed:${MISSED_LIST}${NC}"
  echo -e "${YELLOW}A missed case means a gate lost its teeth — fix the gate, never delete the case.${NC}"
  exit 1
fi
echo -e "${BOLD}${GREEN}========== GATE SELF-TEST PASS ($CAUGHT/$TOTAL violations caught) ==========${NC}"
