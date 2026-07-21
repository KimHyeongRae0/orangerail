CASE_DESC="LANG-01: Hangul in a .txt fixture (former blind spot)"
GATE="scripts/check-language.sh"
EXPECT_PATTERN="LANG-01"
plant() { printf 'expected output %s\n' "$(hangul)" > docs/expected-output.txt; }
