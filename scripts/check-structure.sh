#!/usr/bin/env bash
# scripts/check-structure.sh
#
# Repository layout gate — validates the tree against CLAUDE.md "Layout".
# Ported from the toklint check-structure.sh (itself from kakaopay
# STRUCT-01..09), re-targeted at a pnpm monorepo + docs/ticket discipline.
#
# Violations:
#   ST-01  unknown file at repository root (whitelist)
#   ST-02  packages/ entry not a registered package (allowed: core, cli, mcp,
#          studio, docs-gen) — packages/ absent is fine (packages land at ONT-002+)
#   ST-04  .docs/tickets / .docs/analysis file naming broken (ONT-### chaining)
#   ST-05  tests/e2e scenario naming broken (ONT-###-*.sh | all.sh) or not executable
#   ST-06  scripts/*.sh not executable
#   ST-07  unknown top-level directory (warn)

set -uo pipefail
PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$PROJECT_ROOT"

# shellcheck source=lib/gate-log.sh
source "$PROJECT_ROOT/scripts/lib/gate-log.sh"
gate_log_init "check-structure" "-" "${*:-}"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

fail_msg() { echo -e "${RED}❌ $1${NC}" >&2; }
ok()       { echo -e "${GREEN}✅ $1${NC}"; }
warn()     { echo -e "${YELLOW}⚠️  $1${NC}"; }

BLOCKS=0
WARNS=0

block() { fail_msg "$1"; BLOCKS=$((BLOCKS + 1)); }
warned() { warn "$1"; WARNS=$((WARNS + 1)); }

# ---- ST-01: root file whitelist ----
ROOT_FILES_ALLOWED='^(CLAUDE\.md|DESIGN\.md|README\.md|LICENSE|\.gitignore|package\.json|pnpm-workspace\.yaml|pnpm-lock\.yaml|tsconfig\.json|tsconfig\.base\.json|\.npmrc|eslint\.config\.mjs|\.prettierrc|\.prettierignore)$'
for f in * .[!.]*; do
  [[ -f "$f" ]] || continue
  if ! [[ "$f" =~ $ROOT_FILES_ALLOWED ]]; then
    block "ST-01: unexpected root file '$f' — move it under docs/ (or extend the whitelist deliberately)"
  fi
done

# ---- ST-07: known top-level directories ----
KNOWN_DIRS='^(packages|docs|\.docs|scripts|tests|\.git|\.github|\.claude|node_modules)$'
for d in */ .[!.]*/; do
  [[ -d "$d" ]] || continue
  name="${d%/}"
  if ! [[ "$name" =~ $KNOWN_DIRS ]]; then
    warned "ST-07: unknown top-level directory '$name/' — update CLAUDE.md Layout + this whitelist, or relocate"
  fi
done

# ---- ST-02: packages/ registry (the allowed-packages list IS the registry) ----
# The five v0 packages (DESIGN.md §8.5 layout). packages/ absent is allowed
# without a warning — packages land from ONT-002 onward. When present, every
# entry must be a registered package name; an unknown one is a BLOCK.
PKG_ALLOWED='^(core|cli|mcp|studio|docs-gen)$'
if [[ -d packages ]]; then
  for d in packages/*/; do
    [[ -d "$d" ]] || continue
    name="$(basename "$d")"
    if ! [[ "$name" =~ $PKG_ALLOWED ]]; then
      block "ST-02: package dir 'packages/$name' is not a registered package (allowed: core, cli, mcp, studio, docs-gen) — register it in CLAUDE.md Layout + this whitelist first"
    fi
  done
fi

# ---- ST-04: .docs ticket / analysis naming ----
TICKET_NAME_RE='^(ONT-[0-9][0-9][0-9]_[a-z0-9]+(-[a-z0-9]+)*\.md|_TICKET_TEMPLATE\.md)$'
if [[ -d .docs/tickets ]]; then
  for f in .docs/tickets/*; do
    [[ -f "$f" ]] || continue
    name="$(basename "$f")"
    if ! [[ "$name" =~ $TICKET_NAME_RE ]]; then
      block "ST-04: ticket '$f' must be ONT-###_<kebab-slug>.md"
    fi
  done
fi
ANALYSIS_NAME_RE='^(ONT-[0-9][0-9][0-9]_(plan|report)\.md|_(PLAN|REPORT)_TEMPLATE\.md)$'
if [[ -d .docs/analysis ]]; then
  for f in .docs/analysis/*; do
    [[ -f "$f" ]] || continue
    name="$(basename "$f")"
    if ! [[ "$name" =~ $ANALYSIS_NAME_RE ]]; then
      block "ST-04: analysis '$f' must be ONT-###_plan.md or ONT-###_report.md"
    fi
  done
fi

# ---- ST-05: e2e scenario naming + executability ----
E2E_NAME_RE='^(ONT-[0-9][0-9][0-9]-.+\.sh|all\.sh)$'
if [[ -d tests/e2e ]]; then
  while IFS= read -r f; do
    [[ -z "$f" ]] && continue
    name="$(basename "$f")"
    case "$name" in
      README.md) continue ;;
    esac
    if [[ "$name" == *.sh ]]; then
      if ! [[ "$name" =~ $E2E_NAME_RE ]] && [[ "$(dirname "$f")" != *"/lib"* ]]; then
        block "ST-05: e2e scenario '$f' must be ONT-###-<slug>.sh (or all.sh / lib/ helpers)"
      fi
      if [[ ! -x "$f" ]]; then
        block "ST-05: e2e scenario '$f' is not executable (chmod +x)"
      fi
    fi
  done < <(find tests/e2e -type f 2>/dev/null)
fi

# ---- ST-06: scripts executable ----
for f in scripts/*.sh; do
  [[ -f "$f" ]] || continue
  if [[ ! -x "$f" ]]; then
    block "ST-06: '$f' is not executable (chmod +x)"
  fi
done

# ---- verdict ----
echo ""
if [[ $BLOCKS -gt 0 ]]; then
  echo -e "${RED}check-structure FAIL — ${BLOCKS} BLOCK(s) (see CLAUDE.md Layout)${NC}"
  [[ $WARNS -gt 0 ]] && echo -e "${YELLOW}plus ${WARNS} WARN(s)${NC}"
  exit 1
fi
if [[ $WARNS -gt 0 ]]; then
  ok "structure BLOCK rules satisfied — ${WARNS} WARN(s)"
else
  ok "structure rules satisfied"
fi
exit 0
