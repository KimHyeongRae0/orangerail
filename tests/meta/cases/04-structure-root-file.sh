CASE_DESC="ST-01: unexpected file at repository root"
GATE="scripts/check-structure.sh"
EXPECT_PATTERN="ST-01"
plant() { echo "scratch notes" > NOTES.md; }
