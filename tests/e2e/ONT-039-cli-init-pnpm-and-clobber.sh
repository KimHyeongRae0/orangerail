#!/usr/bin/env bash
# tests/e2e/ONT-039-cli-init-pnpm-and-clobber.sh
#
# init-under-pnpm + clobber-guard e2e (ticket section 5): builds the workspace,
# then hands off to the sibling driver
# (ONT-039-cli-init-pnpm-and-clobber.scenario.mjs), which drives the SHIPPED CLI
# in OUT-OF-REPO scratch dirs through:
#   1. init with NODE_PATH exported (pnpm's bin shim in miniature) — must take
#      the degrade branch, write the whole file set, and exit 0;
#   2. the same under a real `pnpm pack` + `pnpm add` + pnpm bin shim
#      (capability-gated, skips loudly when the install cannot run);
#   3. a hand-edited ontology file plus a renamed `orangerail.config.ts` — must
#      refuse, keep the edit byte-for-byte, and write no shadowing config;
#   4. the same with no config at all.
#
# RED (pre-implementation): phase 1 fails — the shipped bin exits 1 with
# "Cannot find package 'orangerail-core'" and writes nothing, because the CJS
# dependency probe honors NODE_PATH where the ESM loader does not.

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

RED='\033[0;31m'
GREEN='\033[0;32m'
BOLD='\033[1m'
NC='\033[0m'

echo -e "${BOLD}── ONT-039 cli init pnpm-resolution + clobber-guard e2e ──${NC}"

# The scenario drives the SHIPPED artifacts (dist bins), not source imports.
if ! pnpm -r run build > /dev/null 2>&1; then
  echo -e "${BOLD}${RED}workspace build failed${NC}"
  echo -e "${BOLD}${RED}========== ONT-039 E2E FAIL ==========${NC}"
  exit 1
fi

if node tests/e2e/ONT-039-cli-init-pnpm-and-clobber.scenario.mjs; then
  echo -e "${BOLD}${GREEN}========== ONT-039 E2E PASS ==========${NC}"
  exit 0
fi

echo -e "${BOLD}${RED}========== ONT-039 E2E FAIL ==========${NC}"
exit 1
