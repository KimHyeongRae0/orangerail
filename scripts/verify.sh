#!/usr/bin/env bash
# scripts/verify.sh
#
# Mandatory static verification after implementation.
# language + structure + gate self-test + no-llm + templates + typecheck + lint +
# test + build — all must pass.
#
# While the workspace has no package yet (packages/ lands from ONT-002), Node
# steps are skipped with a loud warning ("empty-workspace mode") so the
# harness-only bootstrap can still run the gate. The pnpm-workspace.yaml file
# ships at ONT-001, so the skip keys on the absence of any packages/*/package.json,
# not on the workspace manifest.

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$PROJECT_ROOT"

# shellcheck source=lib/gate-log.sh
source "$PROJECT_ROOT/scripts/lib/gate-log.sh"
gate_log_init "verify" "-" "${*:-}"

GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
BOLD='\033[1m'
NC='\033[0m'

fail() { GATE_LOG_DETAIL="$1"; echo -e "${RED}❌ $1 FAILED${NC}" >&2; exit 1; }
ok()   { echo -e "${GREEN}✅ $1 passed${NC}"; }
step() { echo -e "\n${BOLD}${YELLOW}>>> $1${NC}"; }
skip() { echo -e "${YELLOW}⏭  $1${NC}"; }

START_TS=$(date +%s)

# ---- 1. Language (LANG-01) ----
step "1/9 Language gate (LANG-01)"
./scripts/check-language.sh || fail "check-language"

# ---- 2. Structure (ST-*) ----
step "2/9 Structure gate"
./scripts/check-structure.sh || fail "check-structure"

# ---- 3. Gate self-test (golden set, tests/meta) ----
step "3/9 Gate self-test"
if [[ "${ORANGERAIL_GATE_SANDBOX:-0}" == "1" ]]; then
  skip "inside a gate sandbox — self-test skipped (recursion guard)"
else
  ./scripts/check-gates.sh || fail "check-gates"
fi

# ---- 4. No-LLM (NOLLM-01) ----
step "4/9 No-LLM gate (NOLLM-01)"
./scripts/check-no-llm.sh || fail "check-no-llm"

# ---- 5. Templates (TMPL-01) ----
step "5/9 Templates gate (TMPL-01)"
./scripts/check-templates.sh || fail "check-templates"

HAS_PKG=0
for p in packages/*/package.json; do
  [[ -f "$p" ]] && { HAS_PKG=1; break; }
done
if [[ "$HAS_PKG" -eq 0 ]]; then
  echo -e "\n${BOLD}${YELLOW}⚠️  ⚠️  ⚠️  EMPTY-WORKSPACE MODE — no packages/*/package.json yet; Node steps (typecheck/lint/test/build) SKIPPED ⚠️  ⚠️  ⚠️${NC}"
  skip "first package lands with ONT-002; until then verify runs in empty-workspace mode"
  echo -e "\n${BOLD}${GREEN}========== VERIFY PASS (empty-workspace mode, $(( $(date +%s) - START_TS ))s) ==========${NC}"
  exit 0
fi

command -v node >/dev/null || fail "node not found in PATH"
command -v pnpm >/dev/null || fail "pnpm not found in PATH"

# ---- 6. Typecheck ----
step "6/9 pnpm typecheck"
pnpm typecheck || fail "pnpm typecheck"
ok "typecheck"

# ---- 7. Lint ----
step "7/9 pnpm lint"
pnpm lint || fail "pnpm lint"
ok "lint"

# ---- 8. Tests ----
step "8/9 pnpm test"
pnpm test || fail "pnpm test"
ok "test"

# ---- 9. Build ----
step "9/9 pnpm build"
pnpm build || fail "pnpm build"
ok "build"

echo -e "\n${BOLD}${GREEN}========== VERIFY PASS ($(( $(date +%s) - START_TS ))s) ==========${NC}"
