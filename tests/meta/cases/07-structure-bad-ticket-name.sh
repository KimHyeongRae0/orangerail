CASE_DESC="ST-04: ticket file not named ONT-###_<kebab-slug>.md"
GATE="scripts/check-structure.sh"
EXPECT_PATTERN="ST-04"
plant() { echo "x" > .docs/tickets/randomnotes.md; }
