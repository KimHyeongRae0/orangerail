CASE_DESC="LANG-01: Hangul in a markdown file"
GATE="scripts/check-language.sh"
EXPECT_PATTERN="LANG-01"
plant() { printf 'note: %s test\n' "$(hangul)" > docs/note.md; }
