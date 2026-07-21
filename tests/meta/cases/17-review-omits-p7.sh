CASE_DESC="REV-01/REF-01 sync: agent-review rejects a plan whose rubric omits P7"
GATE="scripts/agent-review.sh plan .docs/analysis/ONT-799_plan.md"
EXPECT_PATTERN="missing or unjudged"
plant() {
  plant_plan_doc ONT-799 "x" APPROVED P7
  scripts/workflow-state.sh stamp ONT-799 preflight >/dev/null 2>&1
}
