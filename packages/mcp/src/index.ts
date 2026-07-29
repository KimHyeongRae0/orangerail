/**
 * orangerail-mcp — generate a governed MCP server from an ontology registry.
 *
 * The ONLY package that depends on `@modelcontextprotocol/sdk` (NOLLM-01 scope
 * rule). Exposes {@link createMcpServer}: read tools for resolvable objects,
 * one governed tool per action (stage → approval_pending), and a
 * `check_approval` re-check tool that completes execution in-process once a
 * human approves. See the package README for the plaintext-storage and
 * dev-mode caveats.
 */
export { createMcpServer } from './server';
export type { CreateMcpServerArgs, HostApprovalPrompt, McpPreset, ReportFailure } from './server';
export { redactFailure } from './redact';
export type { FailureChannel, FailureStatus, RedactedFailure } from './redact';
export { validateToolName } from './names';
export { deriveInputSchema } from './schema';
export type { JsonSchema } from './schema';
