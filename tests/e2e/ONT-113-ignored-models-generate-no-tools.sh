#!/usr/bin/env bash
# tests/e2e/ONT-113-ignored-models-generate-no-tools.sh
#
# `@@ignore` e2e (ticket section 5): builds the workspace, then hands off to the
# sibling driver (ONT-113-ignored-models-generate-no-tools.scenario.mjs), which
# runs the SHIPPED CLI's `init` against schemas written the way `prisma db pull`
# writes them and reads the result off disk.
#
# The build is not optional: the driver drives packages/cli/dist/main.js, which
# is not committed.
#
# RED (pre-implementation): Phase 1 fails on the first ignored model — the
# scanner emits `createevents.mjs` for a model Prisma Client cannot serve.

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

RED='\033[0;31m'
GREEN='\033[0;32m'
BOLD='\033[1m'
NC='\033[0m'

echo -e "${BOLD}── ONT-113 ignored models generate no tools e2e ──${NC}"

if ! pnpm install > /dev/null 2>&1 || ! pnpm -r run build > /dev/null 2>&1; then
  echo -e "${BOLD}${RED}workspace build failed${NC}"
  echo -e "${BOLD}${RED}========== ONT-113 E2E FAIL ==========${NC}"
  exit 1
fi

if node tests/e2e/ONT-113-ignored-models-generate-no-tools.scenario.mjs; then
  echo -e "${BOLD}${GREEN}========== ONT-113 E2E PASS ==========${NC}"
  exit 0
fi

echo -e "${BOLD}${RED}========== ONT-113 E2E FAIL ==========${NC}"
exit 1
