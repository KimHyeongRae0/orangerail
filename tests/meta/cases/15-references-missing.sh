CASE_DESC="REF-01: a mapped ticket (ONT-002) plan missing its required references is blocked"
GATE="scripts/check-references.sh .docs/analysis/ONT-002_plan.md"
EXPECT_PATTERN="REF-01"
plant() { plant_plan_doc ONT-002 "x" APPROVED; }
