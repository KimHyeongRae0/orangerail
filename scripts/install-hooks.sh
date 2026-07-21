#!/usr/bin/env bash
# scripts/install-hooks.sh
#
# Installs git hooks into .git/hooks/ (run once per machine / fresh clone).
# Ported from the toklint install-hooks.sh; only the gates that exist in this
# project are wired (check-dev-rules / check-feedback are not ported yet).
#
# pre-commit runs, in order:
#   1. check-language.sh    LANG-01 (English-only artifacts, with allowlist)
#   2. check-structure.sh   layout + packages registry naming (ST-*)
#   3. check-templates.sh   TMPL-01 (ticket / PR / issue drafts match templates)
#
# The hook only ever BLOCKS commits — it never creates one (CR-01-safe).

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
HOOK_DIR="$REPO_ROOT/.git/hooks"

mkdir -p "$HOOK_DIR"

cat > "$HOOK_DIR/pre-commit" <<'EOF'
#!/usr/bin/env bash
# Installed by scripts/install-hooks.sh — do not edit here; edit the installer.
set -e
REPO_ROOT="$(git rev-parse --show-toplevel)"
cd "$REPO_ROOT"

echo ">>> pre-commit gate 1/3: language (LANG-01)"
./scripts/check-language.sh || { echo "❌ pre-commit blocked — LANG-01 violation."; exit 1; }

echo ">>> pre-commit gate 2/3: structure"
./scripts/check-structure.sh || { echo "❌ pre-commit blocked — structure violation."; exit 1; }

echo ">>> pre-commit gate 3/3: templates (TMPL-01)"
./scripts/check-templates.sh || { echo "❌ pre-commit blocked — TMPL-01 violation."; exit 1; }

echo "✅ pre-commit gates passed"
EOF

chmod +x "$HOOK_DIR/pre-commit"

echo "✅ pre-commit hook installed: $HOOK_DIR/pre-commit"
echo "   → every git commit runs language + structure + templates gates first."
