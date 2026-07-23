#!/usr/bin/env bash
# tests/e2e/ONT-015-codegen-identifier-safety.sh
#
# codegen identifier-safety e2e (ticket section 5). Builds the workspace, then
# hands off to the sibling driver (ONT-015-codegen-identifier-safety.scenario.mjs),
# which copies crafted Prisma/OpenAPI fixtures into scratch run dirs under the
# repo and drives the SHIPPED CLI `node packages/cli/dist/main.js init …` over
# them (pure Node stdlib — no agent-browser, no Playwright).
#
# RED (pre-implementation):
#   - a `registry`/`z` model makes the emitted config throw
#     `SyntaxError: Identifier 'registry' has already been declared` on load, so
#     init aborts and no config is written (phase 1 AC-1);
#   - `A__B`/`A_B` (both sanitize to `A_B`) and a `Widget` object-vs-action clash
#     silently drop objects — 2 files where 4 are expected (phase 2 AC-2);
#   - the collision is not surfaced on stderr (phase 3 AC-3);
#   - the action file is named from the raw name `create-thing.mjs`, not the
#     re-sanitized binding `create_thing.mjs` (phase 4 AC-4).
# Phase 5 (byte-identity / determinism) holds today.

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

RED='\033[0;31m'
GREEN='\033[0;32m'
BOLD='\033[1m'
NC='\033[0m'

echo -e "${BOLD}── ONT-015 codegen identifier-safety e2e ──${NC}"

# The scenario drives the SHIPPED artifacts (dist bins), not source imports.
if ! pnpm -r run build > /dev/null 2>&1; then
  echo -e "${BOLD}${RED}workspace build failed${NC}"
  echo -e "${BOLD}${RED}========== ONT-015 CODEGEN E2E FAIL ==========${NC}"
  exit 1
fi

if node tests/e2e/ONT-015-codegen-identifier-safety.scenario.mjs; then
  echo -e "${BOLD}${GREEN}========== ONT-015 CODEGEN E2E PASS ==========${NC}"
  exit 0
fi

echo -e "${BOLD}${RED}========== ONT-015 CODEGEN E2E FAIL ==========${NC}"
exit 1
