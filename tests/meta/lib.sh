# tests/meta/lib.sh
#
# Shared helpers for gate self-test cases (sourced by scripts/check-gates.sh).
# Case `plant()` functions run with CWD = a sandbox copy of the gate scripts,
# so anything created here never touches the real repository.

# Two Hangul syllables built from raw bytes at runtime, so no file in the
# golden set contains Hangul itself (the corpus must pass its own LANG-01 gate).
hangul() { printf '\xed\x95\x9c\xea\xb8\x80'; }

# A minimal layout-compliant pnpm workspace. Structure cases start from this
# (or an empty skeleton) and mutate exactly one thing, so a catch proves that
# single violation is detected (and the baseline proves the skeleton is clean).
plant_valid_workspace() {
  cat > pnpm-workspace.yaml <<'YAML'
packages:
  - "packages/*"
YAML
  cat > package.json <<'JSON'
{
  "name": "orangerail-root",
  "private": true
}
JSON
  mkdir -p packages/core
  printf '{ "name": "orangerail-core", "private": true }\n' > packages/core/package.json
}

# A plan document that satisfies every section check in agent-review.sh,
# parameterized by verdict checkbox state ("x" = checked, " " = unchecked)
# and verdict word. Optional args mutate the rubric scorecard:
#   $4 omit_id — leave this rubric row out entirely
#   $5 fail_id — score this rubric row FAIL (others PASS)
# Review cases mutate exactly one of verdict / rubric per case.
plant_plan_doc() {
  local ticket="$1" check="$2" verdict="$3" omit_id="${4:-}" fail_id="${5:-}"
  mkdir -p .docs/analysis
  {
    cat <<MD
# ${ticket} Plan (gate self-test fixture)

## 7. Test Plan
- e2e: tests/e2e/${ticket}-case.sh; RED: exits 1 before impl; GREEN: exits 0 after.

## 8. Feature Tags
- gate-test

## 8.5 References Consulted (REF-01)
| Reference | Consulted | Note |
|---|---|---|
| fixture reference | Y (2026-01-01) | fixture note |

## 9. Agent Review
### Reviewer
- Model: gate-test-fixture
### Verdict
- [${check}] ${verdict}
### Rubric
| ID | Item | Verdict | Evidence |
|---|---|---|---|
MD
    local id v
    for id in P1 P2 P3 P4 P5 P6 P7; do
      [[ "$id" == "$omit_id" ]] && continue
      v="PASS"
      [[ "$id" == "$fail_id" ]] && v="FAIL"
      printf '| %s | fixture item | %s | fixture evidence |\n' "$id" "$v"
    done
    cat <<MD
### Comments
1. fixture review

## 10. Final Plan Status
- Agent: ${verdict}
MD
  } > ".docs/analysis/${ticket}_plan.md"
}
