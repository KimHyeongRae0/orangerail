#!/usr/bin/env bash
# tests/e2e/ONT-077-yes-does-not-serve.sh
#
# `--yes` does not serve e2e (ticket section 5): builds the workspace, then hands
# off to the sibling driver (ONT-077-yes-does-not-serve.scenario.mjs), which
# drives the SHIPPED CLI over the ont-056 Prisma/SQLite fixture through:
#   1. `orangerail init --yes` -> exits 0 ON ITS OWN, prints no `serving on`,
#      and still names `orangerail studio` as the next command.
#   2. `orangerail init --yes --studio --no-open --port 4877` -> DOES serve, and
#      /api/registry answers; the explicit flag beats the new default.
#   3. `--yes` and `--yes --no-studio` -> identical stdout and an identical
#      generated tree, file for file.
#
# No database and no browser: this scenario is about whether a process returns,
# not about what the studio renders.
#
# RED (pre-implementation, `88b3849`): phase 1 fails at its first assertion —
# `init --yes` scaffolds in ~0.45s and then serves indefinitely, so the driver
# kills it at the 20s budget and reports "must return on its own".

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

RED='\033[0;31m'
GREEN='\033[0;32m'
BOLD='\033[1m'
NC='\033[0m'

echo -e "${BOLD}── ONT-077 --yes does not serve e2e ──${NC}"

# The scenario drives the SHIPPED artifacts (dist bins), not source imports.
if ! pnpm -r run build > /dev/null 2>&1; then
  echo -e "${BOLD}${RED}workspace build failed${NC}"
  echo -e "${BOLD}${RED}========== ONT-077 E2E FAIL ==========${NC}"
  exit 1
fi

if node tests/e2e/ONT-077-yes-does-not-serve.scenario.mjs; then
  echo -e "${BOLD}${GREEN}========== ONT-077 E2E PASS ==========${NC}"
  exit 0
fi

echo -e "${BOLD}${RED}========== ONT-077 E2E FAIL ==========${NC}"
exit 1
