#!/usr/bin/env bash
# Full e2e regression — thin wrapper so there is exactly ONE runner implementation.
# Scenario discovery, live-credential guards, and reporting live in scripts/e2e.sh
# (regression mode = no ticket argument).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

exec "$ROOT/scripts/e2e.sh"
