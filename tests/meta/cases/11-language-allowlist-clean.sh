CASE_DESC="LANG-01 allowlist: Korean in DESIGN.md (the normative spec) must NOT be flagged"
GATE="scripts/check-language.sh"
EXPECT_PATTERN="allowlist"
EXPECT_PASS=1
plant() { printf '# DESIGN\n\n%s\n' "$(hangul)" > DESIGN.md; }
