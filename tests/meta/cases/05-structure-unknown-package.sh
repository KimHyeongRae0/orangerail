CASE_DESC="ST-02: packages/ dir that is not a registered package (core|cli|mcp|studio|docs-gen)"
GATE="scripts/check-structure.sh"
EXPECT_PATTERN="ST-02"
plant() { mkdir -p packages/webapp; }
