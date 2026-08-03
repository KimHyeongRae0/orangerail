#!/usr/bin/env bash
# tests/e2e/ONT-093-quickstart-runs-as-documented.sh
#
# Quickstart-as-documented e2e (ticket section 5): builds the workspace once,
# then hands off to the sibling driver
# (ONT-093-quickstart-runs-as-documented.scenario.mjs), which lifts the commands
# out of README.md's "## Quickstart" section and executes them verbatim in a
# scratch project holding only the two-model Prisma schema the page names, with
# DATABASE_URL stripped from the environment.
#
# The driver asserts the governed write the page promises and could not reach:
# an auto action returns a row, the gated deleteCustomer stages, a CLI approval
# lifted from the page is consumed by the agent's next `check_approval`, and the
# row is gone afterwards.
#
# WHAT IT PROVES: the driver installs THIS TREE's packed tarballs, not the
# `orangerail` published on npm. A green run says the documented SEQUENCE works
# against this source tree — it says nothing about the published tarball, which
# is the release gate's job.
#
# The build below is the one command the driver does not run itself: `pnpm pack`
# ships whatever is under each package's dist, which is not committed.
#
# RED (pre-implementation): drop step 4 (`@prisma/client` / `prisma generate` /
# `prisma db push`) from the README's Quickstart and the driver fails in phase 2
# with `the datasource client is not installed or has never been generated`.

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

RED='\033[0;31m'
GREEN='\033[0;32m'
BOLD='\033[1m'
NC='\033[0m'

echo -e "${BOLD}── ONT-093 quickstart runs as documented e2e ──${NC}"

if ! pnpm install > /dev/null 2>&1 || ! pnpm -r run build > /dev/null 2>&1; then
  echo -e "${BOLD}${RED}workspace build failed${NC}"
  echo -e "${BOLD}${RED}========== ONT-093 E2E FAIL ==========${NC}"
  exit 1
fi

if node tests/e2e/ONT-093-quickstart-runs-as-documented.scenario.mjs; then
  echo -e "${BOLD}${GREEN}========== ONT-093 E2E PASS ==========${NC}"
  exit 0
fi

echo -e "${BOLD}${RED}========== ONT-093 E2E FAIL ==========${NC}"
exit 1
