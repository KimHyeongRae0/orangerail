#!/usr/bin/env bash
# tests/e2e/ONT-016-studio-server-hardening.sh
#
# Studio server-hardening e2e (ticket ONT-016 section 5): builds the workspace,
# then hands off to the sibling driver (ONT-016-studio-server-hardening.scenario.mjs),
# which reuses the shipped ONT-005 fixture ontology, launches the SHIPPED CLI
# `orangerail studio --no-open --config <cfg> --port <fixed>` against it, and probes
# the local server purely at the HTTP layer using Node's `net` module (raw HTTP/1.1
# requests with attacker- and loopback-controlled Host headers). No agent-browser
# and no Playwright are used — the server-layer hardening is fully HTTP-observable.
#
# RED (pre-implementation), against the current server:
#   - Phase 1 (AC-1, M-DNSREBIND): `GET /api/registry` and `GET /api/instances`
#     with `Host: evil.attacker.com` return 200 today — no Host allowlist exists
#     (server.ts:112-150) — so the "must be 403" assertions FAIL.
#   - Phase 2 (AC-2, L-SSE-UNBOUNDED): opening more than the intended SSE cap of
#     concurrent `/api/events` connections all succeed with 200 today — no cap
#     (server.ts:84,131-147) — so the "excess must be 503" assertion FAILS.
#   - Phase 3 (AC-3, L-SSE-PATHLEAK): forcing a config reload error broadcasts the
#     raw error message, which contains the absolute config path (index.ts:104),
#     so the "reload-error payload contains no absolute path" assertion FAILS.
# Phases 4 (regression: traversal still 404, POST still 405, bind is 127.0.0.1)
# and 5 (live reload still delivers a `change` event) PASS today AND after — the
# no-regression guards.

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

RED='\033[0;31m'
GREEN='\033[0;32m'
BOLD='\033[1m'
NC='\033[0m'

PORT=4893

echo -e "${BOLD}── ONT-016 studio server-hardening e2e ──${NC}"

# Free the fixed port first (best-effort) so a stale process never fails the run.
if command -v lsof > /dev/null 2>&1; then
  STALE="$(lsof -ti "tcp:${PORT}" 2>/dev/null || true)"
  if [[ -n "$STALE" ]]; then
    echo "freeing stale listener on port ${PORT}: ${STALE}"
    kill $STALE > /dev/null 2>&1 || true
    sleep 1
  fi
fi

# The scenario drives the SHIPPED artifacts (dist bins), not source imports.
if ! pnpm -r run build > /dev/null 2>&1; then
  echo -e "${BOLD}${RED}workspace build failed${NC}"
  echo -e "${BOLD}${RED}========== ONT-016 STUDIO E2E FAIL ==========${NC}"
  exit 1
fi

if node tests/e2e/ONT-016-studio-server-hardening.scenario.mjs; then
  echo -e "${BOLD}${GREEN}========== ONT-016 STUDIO E2E PASS ==========${NC}"
  exit 0
fi

echo -e "${BOLD}${RED}========== ONT-016 STUDIO E2E FAIL ==========${NC}"
exit 1
