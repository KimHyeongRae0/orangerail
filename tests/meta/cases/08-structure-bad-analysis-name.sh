CASE_DESC="ST-04: analysis file not ONT-###_plan.md / ONT-###_report.md"
GATE="scripts/check-structure.sh"
EXPECT_PATTERN="ST-04"
plant() { echo "x" > .docs/analysis/ONT-900_notes.md; }
