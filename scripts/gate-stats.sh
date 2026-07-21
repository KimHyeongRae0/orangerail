#!/usr/bin/env bash
# scripts/gate-stats.sh
#
# Observability summary (OBS-01) over .docs/scratch/gate-runs.jsonl — the
# append-only log written by scripts/lib/gate-log.sh on every gate run.
# Answers operational questions about the WORKFLOW itself:
#   - which gates fail most often (and on which step)?
#   - how many test-loop rounds does a ticket take to reach GREEN?
#   - how long do gate runs take?
#
# Read-only: never blocks anything; this is a dashboard, not a gate.
#
# Usage:
#   ./scripts/gate-stats.sh                # summary over the whole log
#   ./scripts/gate-stats.sh --ticket ONT-001   # only one ticket's runs
#   ./scripts/gate-stats.sh --tail 10      # also print the last N raw records

set -uo pipefail

PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$PROJECT_ROOT"

LOG_FILE=".docs/scratch/gate-runs.jsonl"

BOLD='\033[1m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
NC='\033[0m'

TICKET_FILTER=""
TAIL_N=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --ticket) TICKET_FILTER="${2:-}"; shift 2 ;;
    --tail)   TAIL_N="${2:-0}"; shift 2 ;;
    -h|--help) sed -n '3,18p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown flag: $1" >&2; exit 2 ;;
  esac
done

if [[ ! -s "$LOG_FILE" ]]; then
  echo "no gate runs logged yet ($LOG_FILE is missing or empty)"
  echo "records appear automatically as gate scripts run"
  exit 0
fi

echo -e "${BOLD}${BLUE}══ gate-run observability — $LOG_FILE ══${NC}"
echo ""

awk -v ticket_filter="$TICKET_FILTER" '
# BSD-awk-compatible key sort (no gawk asorti on macOS)
function sortkeys(arr, out,    k, n, i, j, tmp) {
  n = 0
  for (k in arr) out[++n] = k
  for (i = 1; i < n; i++)
    for (j = i + 1; j <= n; j++)
      if (out[j] < out[i]) { tmp = out[i]; out[i] = out[j]; out[j] = tmp }
  return n
}
function field(name,    re, s) {
  re = "\"" name "\":\"[^\"]*\""
  if (match($0, re)) {
    s = substr($0, RSTART, RLENGTH)
    sub("^\"" name "\":\"", "", s); sub("\"$", "", s)
    return s
  }
  re = "\"" name "\":[0-9-]+"
  if (match($0, re)) {
    s = substr($0, RSTART, RLENGTH)
    sub("^\"" name "\":", "", s)
    return s
  }
  return ""
}
{
  if (index($0, "\"sandbox\":true") > 0) next
  gate = field("gate"); tkt = field("ticket"); result = field("result")
  dur = field("duration_s") + 0; detail = field("detail"); ts = field("ts")
  if (ticket_filter != "" && tkt != ticket_filter) next

  total++
  runs[gate]++; dursum[gate] += dur
  if (result == "FAIL") {
    fails[gate]++
    nf++; f_ts[nf] = ts; f_gate[nf] = gate; f_tkt[nf] = tkt; f_detail[nf] = detail
  }

  # TDD rounds: test-loop attempts per ticket, in log (= chronological) order.
  # State-gate blocks are stage-order rejections, not test rounds — the loop
  # never ran, so they are excluded from rounds-to-GREEN.
  if (tkt != "-" && tkt != "") seen_ticket[tkt] = 1
  if (gate == "test-loop:red" && tkt != "" && detail != "state-gate") {
    red_runs[tkt]++
    if (result == "PASS" && !red_ok[tkt]) red_ok[tkt] = red_runs[tkt]
  }
  if (gate == "test-loop:green" && tkt != "" && detail != "state-gate") {
    green_runs[tkt]++
    if (result == "PASS" && !green_ok[tkt]) green_ok[tkt] = green_runs[tkt]
  }
}
END {
  if (total == 0) { print "no matching records"; exit }

  printf "── per gate (%d runs) ──\n", total
  printf "%-22s %5s %5s %5s %6s %7s\n", "gate", "runs", "pass", "fail", "fail%", "avg_s"
  n = sortkeys(runs, sorted)
  for (i = 1; i <= n; i++) {
    g = sorted[i]
    f = fails[g] + 0
    printf "%-22s %5d %5d %5d %5.0f%% %7.1f\n", g, runs[g], runs[g]-f, f, 100*f/runs[g], dursum[g]/runs[g]
  }

  has_tdd = 0
  for (t in seen_ticket) if (red_runs[t] || green_runs[t]) has_tdd = 1
  if (has_tdd) {
    printf "\n── TDD rounds per ticket ──\n"
    printf "%-12s %18s %20s\n", "ticket", "RED ok at attempt", "GREEN ok at attempt"
    m = sortkeys(seen_ticket, tsorted)
    for (i = 1; i <= m; i++) {
      t = tsorted[i]
      if (!red_runs[t] && !green_runs[t]) continue
      rs = red_ok[t]   ? sprintf("%d/%d", red_ok[t], red_runs[t])     : sprintf("-/%d", red_runs[t]+0)
      gs = green_ok[t] ? sprintf("%d/%d", green_ok[t], green_runs[t]) : sprintf("-/%d", green_runs[t]+0)
      printf "%-12s %18s %20s\n", t, rs, gs
    }
  }

  if (nf > 0) {
    printf "\n── last failures (max 5) ──\n"
    start = (nf > 5) ? nf - 4 : 1
    for (i = start; i <= nf; i++)
      printf "%s  %-20s %-10s %s\n", f_ts[i], f_gate[i], f_tkt[i], (f_detail[i] == "" ? "-" : f_detail[i])
  }
}' "$LOG_FILE"

if [[ "$TAIL_N" -gt 0 ]]; then
  echo ""
  echo -e "${YELLOW}── last $TAIL_N raw records ──${NC}"
  grep -v '"sandbox":true' "$LOG_FILE" | tail -n "$TAIL_N"
fi
