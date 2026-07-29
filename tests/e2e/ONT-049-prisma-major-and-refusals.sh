#!/usr/bin/env bash
# tests/e2e/ONT-049-prisma-major-and-refusals.sh
#
# Prisma-major codegen + init refusal exit codes e2e (ticket section 5): builds
# the workspace, then hands off to the sibling driver
# (ONT-049-prisma-major-and-refusals.scenario.mjs), which drives the SHIPPED CLI
# in OUT-OF-REPO scratch dirs through:
#   1. no Prisma installed  -> the pre-7 `new PrismaClient()`;
#   2. Prisma 6.19.3        -> byte-identical to (1);
#   3. Prisma 7.9.1 + @prisma/adapter-pg -> an adapter-backed construction;
#   4. Prisma 7.9.1, no adapter -> refuse, exit 1, write nothing;
#   5. nothing to scan      -> refuse on stderr, exit 1, name the doc.
#
# RED (pre-implementation): phase 3 fails first — init emitted the pre-7
# constructor whatever was installed, which is code Prisma 7 cannot run. Phases
# 4 and 5 then fail on the exit code; both used to return 0.

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

RED='\033[0;31m'
GREEN='\033[0;32m'
BOLD='\033[1m'
NC='\033[0m'

echo -e "${BOLD}── ONT-049 prisma-major codegen + init refusal exit codes e2e ──${NC}"

# The scenario drives the SHIPPED artifacts (dist bins), not source imports.
if ! pnpm -r run build > /dev/null 2>&1; then
  echo -e "${BOLD}${RED}workspace build failed${NC}"
  echo -e "${BOLD}${RED}========== ONT-049 E2E FAIL ==========${NC}"
  exit 1
fi

if node tests/e2e/ONT-049-prisma-major-and-refusals.scenario.mjs; then
  echo -e "${BOLD}${GREEN}========== ONT-049 E2E PASS ==========${NC}"
  exit 0
fi

echo -e "${BOLD}${RED}========== ONT-049 E2E FAIL ==========${NC}"
exit 1
