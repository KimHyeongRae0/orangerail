#!/usr/bin/env bash
# tests/e2e/ONT-067-prisma-7-default-generator.sh
#
# The Prisma 7 default generator block, end to end (ticket section 5). Builds the
# workspace, then hands off to the sibling driver
# (ONT-067-prisma-7-default-generator.scenario.mjs), which drives the SHIPPED CLI
# in OUT-OF-REPO scratch dirs through:
#   1. `prisma-client-js` and no generator block -> byte-identical to a reference
#      captured on main;
#   2. `prisma-client` with no `output` -> refuse, exit 1, write nothing;
#   3. an env() output and an out-of-project output -> the same refusal;
#   4. the literal `prisma init` block, a real prisma 7.9.1 install and a real
#      MySQL -> init emits an import that names the generated client, the MCP
#      server boots, and a read tool returns the seeded rows.
#
# Phase 4 is capability-gated (DEV-01): no reachable MySQL, no network install, or
# a Node that cannot run TypeScript means a LOUD skip, never a silent pass. Point
# it at a database it may create with ORANGERAIL_ONT067_MYSQL_URL.
#
# RED (pre-implementation): phase 2 fails first — init exits 0 and writes a full
# ontology for a schema whose client import cannot resolve. Phase 4 then fails at
# the first tool call, which is the defect exactly as reported.

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

RED='\033[0;31m'
GREEN='\033[0;32m'
BOLD='\033[1m'
NC='\033[0m'

echo -e "${BOLD}── ONT-067 Prisma 7 default generator e2e ──${NC}"

# The scenario drives the SHIPPED artifacts (dist bins), not source imports.
if ! pnpm -r run build > /dev/null 2>&1; then
  echo -e "${BOLD}${RED}workspace build failed${NC}"
  echo -e "${BOLD}${RED}========== ONT-067 E2E FAIL ==========${NC}"
  exit 1
fi

if node tests/e2e/ONT-067-prisma-7-default-generator.scenario.mjs; then
  echo -e "${BOLD}${GREEN}========== ONT-067 E2E PASS ==========${NC}"
  exit 0
fi

echo -e "${BOLD}${RED}========== ONT-067 E2E FAIL ==========${NC}"
exit 1
