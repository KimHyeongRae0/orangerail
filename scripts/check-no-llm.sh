#!/usr/bin/env bash
# scripts/check-no-llm.sh
#
# NOLLM-01 gate — the "never bundle an LLM API" invariant (DESIGN.md §8.5).
# orangerail is deterministic: no package under packages/ may depend on or import
# an LLM-inference SDK. This gate BLOCKs when it finds a blocklisted dependency
# key in a packages/**/package.json OR a blocklisted import/require specifier in
# packages/ source.
#
# The blocklist below is the SINGLE SOURCE OF TRUTH. Two match modes:
#   exact  — the specifier is the package itself or a subpath (E, or E/...).
#   prefix — any specifier starting with E (covers @aws-sdk/client-bedrock*).
#
# @modelcontextprotocol/sdk is deliberately NOT blocklisted: it is a protocol
# server SDK, not an LLM-inference client (packages/mcp depends on it). The
# host-mode adapter exemption mechanism (a parking-lot feature) would add its
# adapter package to an allowlist here — the core prohibition stays permanent.
#
# Matching is by exact specifier only, so ordinary words that contain "ai"
# (e.g. "maintain") never false-positive — a clean-pass golden case locks this.
#
# Empty or absent packages/ => PASS with an info line (packages land ONT-002+).
#
# Usage:
#   ./scripts/check-no-llm.sh

set -uo pipefail

PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$PROJECT_ROOT"

# shellcheck source=lib/gate-log.sh
source "$PROJECT_ROOT/scripts/lib/gate-log.sh"
gate_log_init "check-no-llm" "-" "${*:-}"

RED='\033[0;31m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
BOLD='\033[1m'
NC='\033[0m'

# ---- blocklist (single source of truth) ----
BLOCKLIST_EXACT=(openai "@anthropic-ai/sdk" "@google/generative-ai" ai)
BLOCKLIST_PREFIX=("@aws-sdk/client-bedrock")

BLOCKS=0
block() { echo -e "${RED}  ✗ $1${NC}" >&2; BLOCKS=$((BLOCKS + 1)); }

if [[ ! -d packages ]]; then
  echo -e "${BLUE}ℹ️  NOLLM-01: no packages/ yet — nothing to scan (packages land ONT-002+)${NC}"
  echo -e "${GREEN}✅ NOLLM-01 PASS${NC}"
  exit 0
fi

SRC_FILES=()
while IFS= read -r f; do SRC_FILES+=("$f"); done < <(find packages -type f \
  \( -name '*.ts' -o -name '*.tsx' -o -name '*.js' -o -name '*.jsx' \
     -o -name '*.mjs' -o -name '*.cjs' \) 2>/dev/null)

MANIFESTS=()
while IFS= read -r f; do MANIFESTS+=("$f"); done < <(find packages -type f -name 'package.json' 2>/dev/null)

if [[ ${#SRC_FILES[@]} -eq 0 && ${#MANIFESTS[@]} -eq 0 ]]; then
  echo -e "${BLUE}ℹ️  NOLLM-01: packages/ has no source or manifests yet — nothing to scan${NC}"
  echo -e "${GREEN}✅ NOLLM-01 PASS${NC}"
  exit 0
fi

# specifier core regex for one entry: exact => E or E/...; prefix => E...
spec_core() {
  local e="$1" mode="$2"
  if [[ "$mode" == "prefix" ]]; then
    printf '%s[^"'\'']*' "$e"
  else
    printf '%s(/[^"'\'']*)?' "$e"
  fi
}

# import/require context around a specifier core
scan_imports() {
  local e="$1" mode="$2" core re
  core="$(spec_core "$e" "$mode")"
  re="(from[[:space:]]+|import[[:space:]]+|require\([[:space:]]*|import\([[:space:]]*)[\"']${core}[\"']"
  [[ ${#SRC_FILES[@]} -eq 0 ]] && return 0
  grep -rnE "$re" "${SRC_FILES[@]}" 2>/dev/null
}

# dependency KEY in a manifest: "E"<ws>:  (exact) / "E...":  (prefix)
scan_manifest() {
  local e="$1" mode="$2" re
  if [[ "$mode" == "prefix" ]]; then
    re="\"${e}[^\"]*\"[[:space:]]*:"
  else
    re="\"${e}\"[[:space:]]*:"
  fi
  [[ ${#MANIFESTS[@]} -eq 0 ]] && return 0
  grep -rnE "$re" "${MANIFESTS[@]}" 2>/dev/null
}

check_entry() {
  local e="$1" mode="$2" hits
  hits="$(scan_imports "$e" "$mode")"
  if [[ -n "$hits" ]]; then
    while IFS= read -r line; do
      [[ -z "$line" ]] && continue
      block "NOLLM-01: LLM SDK import '$e' — $line"
    done <<< "$hits"
  fi
  hits="$(scan_manifest "$e" "$mode")"
  if [[ -n "$hits" ]]; then
    while IFS= read -r line; do
      [[ -z "$line" ]] && continue
      block "NOLLM-01: LLM SDK dependency '$e' — $line"
    done <<< "$hits"
  fi
}

for e in "${BLOCKLIST_EXACT[@]}"; do check_entry "$e" exact; done
for e in "${BLOCKLIST_PREFIX[@]}"; do check_entry "$e" prefix; done

echo ""
if [[ $BLOCKS -gt 0 ]]; then
  echo -e "${BOLD}${RED}========== NOLLM-01 BLOCK — LLM SDK found in packages/ (${BLOCKS}) ==========${NC}" >&2
  echo -e "${RED}orangerail is deterministic: no LLM-inference SDK may be bundled (DESIGN.md §8.5).${NC}" >&2
  echo -e "${RED}The blocklist lives at the top of scripts/check-no-llm.sh (single source of truth).${NC}" >&2
  exit 1
fi
echo -e "${GREEN}✅ NOLLM-01 PASS — no LLM-inference SDK in packages/${NC}"
