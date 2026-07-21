CASE_DESC="REF-01 exemption: ONT-001 plan needs no references (clean pass)"
GATE="scripts/check-references.sh .docs/analysis/ONT-001_plan.md"
EXPECT_PATTERN="exemption"
EXPECT_PASS=1
plant() { plant_plan_doc ONT-001 "x" APPROVED; }
