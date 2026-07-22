#!/usr/bin/env bash
# tests/e2e/ONT-007-openapi-component-resolution.sh
#
# OpenAPI component-resolution e2e (ticket section 5): builds the workspace,
# then hands off to the sibling driver
# (ONT-007-openapi-component-resolution.scenario.mjs), which copies two fixture
# repos into scratch run dirs and drives the SHIPPED CLI:
#
#   - clean fixture: a fully locally-resolvable document ($ref parameters
#     GitHub-style, $ref / nested / allOf request bodies cal.com/NestJS-style,
#     a hostile enum string inside a component schema). After resolution the
#     generated action inputs must carry every referenced field, the document
#     must emit ZERO openapi $ref / unresolvable / composition warnings, the
#     resolved fields must be visible over MCP tools/list, and two fresh runs
#     must be byte-identical (determinism).
#   - hostile fixture: a schema->schema cycle, a missing target, an external
#     pointer, a missing $ref parameter, and a oneOf composed body. Resolution
#     must never crash (init exits 0), the aggregated warning must name the
#     genuine unresolvables (missing / external / cycle), the oneOf must raise a
#     composition warning, and the union body must surface every branch field.
#
# No browser / studio phase — this ticket touches the scanner only, so the
# driver runs init with --no-studio and asserts on generated files + MCP.
#
# RED (pre-implementation): the scanner reads inline shapes only, so $ref params
# are counted-and-skipped and $ref / allOf / oneOf bodies produce no fields. The
# clean-fixture assertions on resolved fields (e.g. replaceTopics owner/repo)
# FAIL, and the always-emitted "$ref parameter(s)" warning keeps the
# fully-resolvable document from being warning-clean.

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

RED='\033[0;31m'
GREEN='\033[0;32m'
BOLD='\033[1m'
NC='\033[0m'

echo -e "${BOLD}── ONT-007 openapi component-resolution e2e ──${NC}"

# The scenario drives the SHIPPED artifacts (dist bins), not source imports.
if ! pnpm -r run build > /dev/null 2>&1; then
  echo -e "${BOLD}${RED}workspace build failed${NC}"
  echo -e "${BOLD}${RED}========== ONT-007 COMPONENT-RESOLUTION E2E FAIL ==========${NC}"
  exit 1
fi

if node tests/e2e/ONT-007-openapi-component-resolution.scenario.mjs; then
  echo -e "${BOLD}${GREEN}========== ONT-007 COMPONENT-RESOLUTION E2E PASS ==========${NC}"
  exit 0
fi

echo -e "${BOLD}${RED}========== ONT-007 COMPONENT-RESOLUTION E2E FAIL ==========${NC}"
exit 1
