CASE_DESC="NOLLM-01 clean-pass: @modelcontextprotocol/sdk + words containing 'ai' must NOT be flagged"
GATE="scripts/check-no-llm.sh"
EXPECT_PATTERN="NOLLM-01 PASS"
EXPECT_PASS=1
plant() {
  mkdir -p packages/mcp/src
  {
    printf '// We maintain invariants across the domain; this is not an ai import.\n'
    printf 'import { Server } from "@modelcontextprotocol/sdk/server/index.js";\n'
    printf 'export const detail = "retain the maintainer contact";\n'
    printf 'export const srv = new Server();\n'
  } > packages/mcp/src/ok.ts
  printf '{ "name": "orangerail-mcp", "dependencies": { "@modelcontextprotocol/sdk": "^1.0.0" } }\n' > packages/mcp/package.json
}
