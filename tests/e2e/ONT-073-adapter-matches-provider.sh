#!/usr/bin/env bash
# tests/e2e/ONT-073-adapter-matches-provider.sh
#
# The driver adapter follows the schema's `datasource` provider, not install
# order (ticket section 5). Builds the workspace, then hands off to the sibling
# driver (ONT-073-adapter-matches-provider.scenario.mjs), which drives the
# SHIPPED CLI in OUT-OF-REPO scratch dirs through:
#   1. a MySQL schema with only `@prisma/adapter-pg` present -> refusal, exit 1,
#      nothing written, and the one `npm install` that fixes it;
#   2. a schema with no declared provider -> byte-identical to a reference
#      captured on the merge base;
#   3. a single-adapter repo whose provider matches -> byte-identical to its own
#      merge-base reference;
#   4. a real prisma 7.9.1 install carrying BOTH adapters against a live MySQL ->
#      `PrismaMariaDb` emitted and named in the closing summary, and the shipped
#      MCP server reading the seeded rows back out of the database.
#
# Phase 4 is capability-gated (DEV-01): no reachable MySQL or no network install
# means a LOUD skip, never a silent pass. Point it at a server it may create its
# own database on with ORANGERAIL_ONT073_MYSQL_URL.
#
# RED (against 3c943f0): phases 2 and 3 pass — they are the controls. Phase 1
# fails by exiting 0 and generating a full ontology through `PrismaPg`, and phase
# 4 fails on the emitted class, which is the defect exactly as reported.

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

RED='\033[0;31m'
GREEN='\033[0;32m'
BOLD='\033[1m'
NC='\033[0m'

echo -e "${BOLD}── ONT-073 adapter matches provider e2e ──${NC}"

# The scenario drives the SHIPPED artifacts (dist bins), not source imports.
if ! pnpm -r run build > /dev/null 2>&1; then
  echo -e "${BOLD}${RED}workspace build failed${NC}"
  echo -e "${BOLD}${RED}========== ONT-073 E2E FAIL ==========${NC}"
  exit 1
fi

if node tests/e2e/ONT-073-adapter-matches-provider.scenario.mjs; then
  echo -e "${BOLD}${GREEN}========== ONT-073 E2E PASS ==========${NC}"
  exit 0
fi

echo -e "${BOLD}${RED}========== ONT-073 E2E FAIL ==========${NC}"
exit 1
