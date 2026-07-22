#!/usr/bin/env bash
# tests/e2e/ONT-009-mcp-embed-mastra.sh
#
# Real Mastra MCP client seam e2e (ticket section 5): a real `@mastra/mcp`
# client (fixtures/ont-009/harness) connects to a generated orangerail MCP server
# over stdio and exercises the full governed-write loop — tool discovery + read,
# staged write (approval_pending as DATA), CLI approval, execution through the
# orangerail execute wrapper, and audit verify — with NO LLM in the loop. Scenario
# logic lives in the sibling driver (ONT-009-mcp-embed-mastra.scenario.mjs, pure
# Node stdlib); it spawns the harness phases as child processes and freezes their
# JSON contract, bridging stage and check with the `orangerail approvals` CLI.
#
# RED (pre-implementation): the harness directory
# (tests/e2e/fixtures/ont-009/harness) does not exist yet, so the driver's
# harness-absent assertion fails before any phase runs, and DESIGN.md item 9 is
# still unchecked — this script exits non-zero while verify.sh stays green.

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

RED='\033[0;31m'
GREEN='\033[0;32m'
BOLD='\033[1m'
NC='\033[0m'

echo -e "${BOLD}── ONT-009 mcp-embed-mastra e2e ──${NC}"

# The scenario drives the SHIPPED artifacts (dist bins), not source imports.
if ! pnpm -r run build > /dev/null 2>&1; then
  echo -e "${BOLD}${RED}workspace build failed${NC}"
  echo -e "${BOLD}${RED}========== ONT-009 MCP-EMBED-MASTRA E2E FAIL ==========${NC}"
  exit 1
fi

if node tests/e2e/ONT-009-mcp-embed-mastra.scenario.mjs; then
  echo -e "${BOLD}${GREEN}========== ONT-009 MCP-EMBED-MASTRA E2E PASS ==========${NC}"
  exit 0
fi

echo -e "${BOLD}${RED}========== ONT-009 MCP-EMBED-MASTRA E2E FAIL ==========${NC}"
exit 1
