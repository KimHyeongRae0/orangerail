#!/usr/bin/env bash
# tests/e2e/ONT-019-npm-publish-readiness.sh
#
# npm publish-readiness e2e (ticket section 5): builds the workspace, then hands
# off to the sibling driver (ONT-019-npm-publish-readiness.scenario.mjs), a pure
# Node scenario (no browser) that packs the five release packages and asserts the
# publish contract entirely from the packed tarballs:
#
#   Phase 1 (AC-1/2/3, THE RED SOURCE): for each of the five packages (core,
#     docs-gen, mcp, studio, cli) `pnpm pack` into a scratch dir, read the
#     tarball's embedded package.json and assert the publish shape — version
#     0.1.0, publishConfig.access "public", license "MIT", no `private`, no
#     `workspace:` spec in any runtime dependency, `dist` (studio: dist/app +
#     dist/node) and LICENSE present in the tarball, and studio's runtime deps
#     free of react/react-dom/@xyflow/react/elkjs. On the current tree these FAIL
#     (tarballs are version 0.0.0, private, no publishConfig, studio still lists
#     the React/graph stack) — that is the genuine RED.
#   Phase 2 (AC-4, capability-gated): install ALL packed tarballs together into a
#     clean out-of-repo prefix (no repo node_modules on the resolution path), run
#     the installed `orangerail init --no-studio --yes` on the Prisma fixture in a
#     separate out-of-repo project dir, resolve `orangerail-core` there from the
#     same tarballs, boot `orangerail mcp`, and drive the ONT-018 governed write
#     loop (discover createNote -> approval_pending -> approve -> execute ->
#     `audit verify`). Wrapped in a network/toolchain capability probe that
#     skips-with-LOUD-notice (DEV-01) when the isolated install cannot run.
#   Phase 3 (AC-5, always-on): the shipped `orangerail init` in an out-of-repo dir
#     with NO resolvable orangerail-core prints the honest
#     `npm install orangerail-core zod` instruction (guards the already-correct
#     degrade guidance).
#
# RED (pre-implementation): Phase 1's first tarball-manifest assertion fails
# because the packed core tarball's version is "0.0.0" (not the required
# "0.1.0"); the run aborts there and Phases 2/3 are never reached. That FAIL is
# attributable to the absent publish-readiness feature, not a harness error.
# `verify.sh` still PASSes because the tree compiles and all suites pass.

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

RED='\033[0;31m'
GREEN='\033[0;32m'
BOLD='\033[1m'
NC='\033[0m'

echo -e "${BOLD}── ONT-019 npm-publish-readiness e2e ──${NC}"

# The scenario packs and inspects the SHIPPED build output (dist), so a build
# must precede it — `pnpm pack` ships whatever is under each package's dist.
if ! pnpm -r run build > /dev/null 2>&1; then
  echo -e "${BOLD}${RED}workspace build failed${NC}"
  echo -e "${BOLD}${RED}========== ONT-019 NPM-PUBLISH-READINESS E2E FAIL ==========${NC}"
  exit 1
fi

if node tests/e2e/ONT-019-npm-publish-readiness.scenario.mjs; then
  echo -e "${BOLD}${GREEN}========== ONT-019 NPM-PUBLISH-READINESS E2E PASS ==========${NC}"
  exit 0
fi

echo -e "${BOLD}${RED}========== ONT-019 NPM-PUBLISH-READINESS E2E FAIL ==========${NC}"
exit 1
