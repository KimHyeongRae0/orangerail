# scripts/lib/gate-log.sh
#
# Gate-run observability (OBS-01). Sourced by every gate script; appends exactly
# one JSONL record per gate run to .docs/scratch/gate-runs.jsonl (gitignored)
# via an EXIT trap, so every exit path — PASS or FAIL — is recorded.
#
# Record shape (one line per run):
#   {"ts":"...","gate":"verify","ticket":"ONT-001","result":"FAIL",
#    "exit_code":1,"duration_s":12,"sandbox":false,"detail":"lint","argv":""}
#
# Usage (inside a gate script, after PROJECT_ROOT is set and cd'd):
#   source "$PROJECT_ROOT/scripts/lib/gate-log.sh"
#   gate_log_init "<gate-name>" "<ticket-or-->" "<argv>"
#
# Failure attribution: set GATE_LOG_DETAIL before exiting (fail() helpers do
# this) so the record names the step that failed, not just the gate.
#
# Scripts with their own EXIT trap must chain instead of calling init's trap:
#   trap 'rc=$?; my_cleanup; gate_log_exit "$rc"' EXIT
#
# Logging must never change a gate's verdict: every write path here swallows
# its own errors and returns 0.

GATE_LOG_DETAIL="${GATE_LOG_DETAIL:-}"

gate_log_escape() {
  local s="$1"
  s="${s//\\/\\\\}"
  s="${s//\"/\\\"}"
  s="${s//$'\n'/ }"
  s="${s//$'\t'/ }"
  printf '%s' "$s"
}

gate_log_init() {
  GATE_LOG_GATE="$1"
  GATE_LOG_TICKET="${2:--}"
  GATE_LOG_ARGV="${3:-}"
  GATE_LOG_START="$(date +%s)"
  GATE_LOG_FILE="${PROJECT_ROOT:-$(pwd)}/.docs/scratch/gate-runs.jsonl"
  # Captured at init: a top-level run that later exports the sandbox guard
  # (check-gates.sh) must still be recorded as a real run.
  GATE_LOG_SANDBOX="false"
  [[ "${ORANGERAIL_GATE_SANDBOX:-0}" == "1" ]] && GATE_LOG_SANDBOX="true"
  trap 'gate_log_exit' EXIT
}

gate_log_exit() {
  local rc="${1:-$?}"
  [[ -z "${GATE_LOG_GATE:-}" ]] && return 0
  local result="PASS"
  [[ "$rc" -ne 0 ]] && result="FAIL"
  mkdir -p "$(dirname "$GATE_LOG_FILE")" 2>/dev/null || return 0
  printf '{"ts":"%s","gate":"%s","ticket":"%s","result":"%s","exit_code":%s,"duration_s":%s,"sandbox":%s,"detail":"%s","argv":"%s"}\n' \
    "$(date '+%Y-%m-%dT%H:%M:%S')" \
    "$(gate_log_escape "$GATE_LOG_GATE")" \
    "$(gate_log_escape "$GATE_LOG_TICKET")" \
    "$result" \
    "$rc" \
    "$(( $(date +%s) - GATE_LOG_START ))" \
    "$GATE_LOG_SANDBOX" \
    "$(gate_log_escape "$GATE_LOG_DETAIL")" \
    "$(gate_log_escape "$GATE_LOG_ARGV")" \
    >> "$GATE_LOG_FILE" 2>/dev/null || true
  return 0
}
