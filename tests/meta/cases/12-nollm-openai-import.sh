CASE_DESC="NOLLM-01: a packages/ source file importing an LLM SDK (openai) is blocked"
GATE="scripts/check-no-llm.sh"
EXPECT_PATTERN="NOLLM-01"
plant() {
  mkdir -p packages/core/src
  printf 'import OpenAI from "openai";\nexport const client = new OpenAI();\n' > packages/core/src/bad.ts
}
