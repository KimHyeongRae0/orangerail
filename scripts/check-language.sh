#!/usr/bin/env bash
# scripts/check-language.sh
#
# LANG-01 gate — every repository artifact must be English.
# Greps tracked project files for Hangul characters; any hit is a BLOCK.
#
# Allowlist (the normative spec is authored in Korean; product data, not prose):
#   - DESIGN.md   (the Korean normative spec, imported as-is at ONT-001)
# Allowlisted hits are reported as an INFO line and never block.
#
# Usage:
#   ./scripts/check-language.sh            # scan the whole project
#   ./scripts/check-language.sh <path>...  # scan specific paths

set -uo pipefail

PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$PROJECT_ROOT"

# shellcheck source=lib/gate-log.sh
source "$PROJECT_ROOT/scripts/lib/gate-log.sh"
gate_log_init "check-language" "-" "${*:-}"

RED='\033[0;31m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
BOLD='\033[1m'
NC='\033[0m'

# Scan scope: everything that would land in git. Scratch output is excluded
# because preflight stages may quote the (Korean) live conversation context.
TARGETS=("$@")
if [[ ${#TARGETS[@]} -eq 0 ]]; then
  TARGETS=(.)
fi

# Build a locale-independent Hangul matcher (U+AC00..U+D7A3) as raw UTF-8
# byte alternations, constructed at runtime so this file itself contains no
# Hangul bytes and passes its own gate. A character-class range like
# [<hangul>-<hangul>] silently stops matching under GNU grep's C locale
# (caught by CI on ubuntu — the macOS BSD grep happened to accept it), so we
# pin LC_ALL=C and match the encoded bytes directly:
#   U+AC00..U+AFFF: EA B0-BF 80-BF
#   U+B000..U+CFFF: EB-EC 80-BF 80-BF
#   U+D000..U+D7A3: ED 80-9E 80-BF (over-matches to U+D7BF; still Korean)
export LC_ALL=C
b() { printf "\\x$1"; }
P1="$(b ea)[$(b b0)-$(b bf)][$(b 80)-$(b bf)]"
P2="[$(b eb)$(b ec)][$(b 80)-$(b bf)][$(b 80)-$(b bf)]"
P3="$(b ed)[$(b 80)-$(b 9e)][$(b 80)-$(b bf)]"
HANGUL_RE="(${P1}|${P2}|${P3})"

# LANG-01 allowlist — see header. Paths are compared without a leading "./".
is_allowlisted() {
  local p="${1#./}"
  [[ "$p" == "DESIGN.md" ]] && return 0
  return 1
}

RAW_HITS=$(grep -rnIlEa \
  --include='*.md' --include='*.ts' --include='*.tsx' --include='*.js' \
  --include='*.jsx' --include='*.mjs' --include='*.cjs' --include='*.sh' \
  --include='*.yml' --include='*.yaml' --include='*.json' \
  --include='*.txt' --include='LICENSE*' --include='*.gitignore' \
  --exclude-dir=node_modules --exclude-dir=dist --exclude-dir=.git --exclude-dir=scratch \
  -e "$HANGUL_RE" "${TARGETS[@]}" 2>/dev/null || true)

HITS=""
SKIPPED=""
while IFS= read -r f; do
  [[ -z "$f" ]] && continue
  if is_allowlisted "$f"; then
    SKIPPED="${SKIPPED}${f}"$'\n'
  else
    HITS="${HITS}${f}"$'\n'
  fi
done <<< "$RAW_HITS"
HITS="${HITS%$'\n'}"
SKIPPED="${SKIPPED%$'\n'}"

if [[ -n "$SKIPPED" ]]; then
  echo -e "${BLUE}ℹ️  LANG-01 allowlist — skipped (product locale data, not prose):${NC}"
  echo "$SKIPPED" | sed 's/^/      /'
fi

if [[ -n "$HITS" ]]; then
  echo -e "${BOLD}${RED}========== LANG-01 BLOCK — Korean text found ==========${NC}"
  echo "$HITS" | while read -r f; do
    echo -e "${RED}  ✗ $f${NC}"
    grep -nIEa -m 3 -e "$HANGUL_RE" "$f" | sed 's/^/      /'
  done
  echo ""
  echo "All repository artifacts must be English (CLAUDE.md LANG-01)."
  exit 1
fi

echo -e "${GREEN}✅ LANG-01 PASS — no Korean text in repository artifacts${NC}"
