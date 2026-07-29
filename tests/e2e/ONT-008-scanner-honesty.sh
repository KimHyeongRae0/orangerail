#!/usr/bin/env bash
# tests/e2e/ONT-008-scanner-honesty.sh
#
# Scanner honesty + runtime diagnostics e2e (ticket section 5): builds the
# workspace, then hands off to the sibling driver
# (ONT-008-scanner-honesty.scenario.mjs), which copies three fixture repos into
# scratch run dirs and drives the SHIPPED CLI:
#
#   - monorepo/ : the Prisma schema lives at packages/db/prisma/schema.prisma
#     (NO root schema) plus a root openapi.json contributing one governed write
#     action. Root-level `init` must DETECT the nested schema and generate its
#     models (AC-1), emit ONE aggregated view-skip warning naming the fixture
#     view (AC-2), the generated read tool must surface an ACTIONABLE, CLASSIFIED
#     failure when the Prisma client is absent — redacted for the agent, full on
#     the operator sink, one correlationId across both (AC-3, retargeted at
#     ONT-032/ONT-045) — and the generated AGENTS.md must carry the
#     not-implemented stub-path wording (AC-4).
#   - both/ : a root prisma/schema.prisma AND a nested packages/db/prisma one,
#     each with a different model — ALL hits must be scanned, root first
#     (ticket §4 precedence edge case).
#   - root/ : an ONT-006-shaped root-only repo — two fresh inits must be
#     byte-identical (AC-5 regression: the detection change leaves root-only
#     repos untouched).
#
# No browser / studio phase — this ticket touches the scanner, codegen resolve
# wrapping, and docs-gen wording, so the driver runs init with --no-studio and
# asserts on generated files + a real MCP tool call.
#
# RED (pre-implementation): root-only detection never finds the monorepo's
# nested schema, so init generates no models from it — Phase 1's model-file
# assertions FAIL (init still exits 0). The aggregated view warning is absent
# (Phase 2), the no-client read-tool error is the raw "Cannot find module" text
# without the object name or `prisma generate` (Phase 4), and the AGENTS.md
# governed section lacks the "rejected before staging" stub wording (Phase 5).

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

RED='\033[0;31m'
GREEN='\033[0;32m'
BOLD='\033[1m'
NC='\033[0m'

echo -e "${BOLD}── ONT-008 scanner-honesty + runtime-diagnostics e2e ──${NC}"

# The scenario drives the SHIPPED artifacts (dist bins), not source imports.
if ! pnpm -r run build > /dev/null 2>&1; then
  echo -e "${BOLD}${RED}workspace build failed${NC}"
  echo -e "${BOLD}${RED}========== ONT-008 SCANNER-HONESTY E2E FAIL ==========${NC}"
  exit 1
fi

if node tests/e2e/ONT-008-scanner-honesty.scenario.mjs; then
  echo -e "${BOLD}${GREEN}========== ONT-008 SCANNER-HONESTY E2E PASS ==========${NC}"
  exit 0
fi

echo -e "${BOLD}${RED}========== ONT-008 SCANNER-HONESTY E2E FAIL ==========${NC}"
exit 1
