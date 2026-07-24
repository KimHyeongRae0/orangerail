#!/usr/bin/env bash
# tests/e2e/ONT-018-prisma-write-actions.sh
#
# Governed Prisma write-action e2e (ticket section 5): builds the workspace,
# then hands off to the sibling driver (ONT-018-prisma-write-actions.scenario.mjs),
# which copies the ont-018 fixture into scratch run dirs and drives the SHIPPED
# CLI + a pure-Node MCP stdio client:
#
#   Phase 1 (AC-1/2/3): `orangerail init` over the SQLite Prisma fixture emits real
#     create/update/delete actions (execute = prisma.note.<op>, NOT the
#     notImplemented stub). The MCP client discovers `createNote`, stages it
#     (approval_pending, audited), a human approves via `orangerail approvals
#     approve`, and — against a real SQLite DB from `prisma db push` — the write
#     executes exactly once (row observably created), a re-call is consumed, and
#     `orangerail audit verify` passes. Only the DB-dependent execute+observe
#     sub-block is capability-gated (skip-with-loud-notice, DEV-01) — discover,
#     staging, approval, and audit-verify always run.
#   Phase 2 (AC-4): a write with no DATABASE_URL fails at execute with an
#     actionable diagnostic (names the object + DATABASE_URL), never a raw crash;
#     the generated AGENTS.md carries no false "[stub — not implemented]" line.
#   Phase 3 (AC-6): an OpenAPI-source fixture emits a byte-identical action file
#     vs a captured pre-ONT-018 reference (the OpenAPI stub path is untouched).
#
# No browser / studio phase — this ticket touches the Prisma scan → IR path and
# the action emitter, so the driver runs init with --no-studio and asserts on
# generated files, a real MCP tool loop, and a real SQLite mutation.
#
# RED (pre-implementation): the Prisma scanner emits ZERO write actions, so init
# generates no ontology/createNote.mjs and tools/list has no `createNote` — the
# driver fails at Phase 1's first discover assertion ("no createNote action
# exists"), before any db push / staging. That is the genuine RED (not a setup
# error); Phases 2/3 are never reached.

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

RED='\033[0;31m'
GREEN='\033[0;32m'
BOLD='\033[1m'
NC='\033[0m'

echo -e "${BOLD}── ONT-018 prisma-write-actions e2e ──${NC}"

# The scenario drives the SHIPPED artifacts (dist bins), not source imports.
if ! pnpm -r run build > /dev/null 2>&1; then
  echo -e "${BOLD}${RED}workspace build failed${NC}"
  echo -e "${BOLD}${RED}========== ONT-018 PRISMA-WRITE-ACTIONS E2E FAIL ==========${NC}"
  exit 1
fi

if node tests/e2e/ONT-018-prisma-write-actions.scenario.mjs; then
  echo -e "${BOLD}${GREEN}========== ONT-018 PRISMA-WRITE-ACTIONS E2E PASS ==========${NC}"
  exit 0
fi

echo -e "${BOLD}${RED}========== ONT-018 PRISMA-WRITE-ACTIONS E2E FAIL ==========${NC}"
exit 1
