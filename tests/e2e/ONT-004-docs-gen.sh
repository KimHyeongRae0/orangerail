#!/usr/bin/env bash
# tests/e2e/ONT-004-docs-gen.sh
#
# Prompt-rail e2e (ticket §5): the real `orangerail docs` CLI generates the
# agent-facing domain document from a full-feature fixture ontology —
# sections, truthful governance badges, escaped Mermaid, byte-identical
# re-runs — and the document's MCP tools table is proven EQUAL to a live
# `orangerail mcp` process's tools/list under the default preset and under
# readonly. Scenario logic lives in the sibling driver
# (ONT-004-docs-gen.scenario.mjs, pure Node stdlib).
#
# RED (pre-implementation): packages/docs-gen does not exist and the CLI
# has no `docs` command, so the driver's first CLI run fails and this
# script exits non-zero.

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

RED='\033[0;31m'
GREEN='\033[0;32m'
BOLD='\033[1m'
NC='\033[0m'

echo -e "${BOLD}── ONT-004 docs-gen e2e ──${NC}"

# The scenario drives the SHIPPED artifacts (dist bins), not source imports.
if ! pnpm -r run build > /dev/null 2>&1; then
  echo -e "${BOLD}${RED}workspace build failed${NC}"
  echo -e "${BOLD}${RED}========== ONT-004 DOCS-GEN E2E FAIL ==========${NC}"
  exit 1
fi

if node tests/e2e/ONT-004-docs-gen.scenario.mjs; then
  echo -e "${BOLD}${GREEN}========== ONT-004 DOCS-GEN E2E PASS ==========${NC}"
  exit 0
fi

echo -e "${BOLD}${RED}========== ONT-004 DOCS-GEN E2E FAIL ==========${NC}"
exit 1
