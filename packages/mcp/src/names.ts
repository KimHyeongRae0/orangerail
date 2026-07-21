/**
 * MCP tool-name validation (§3.2). Names are validated at server BUILD time
 * (fail fast) rather than at call time, and collisions across read/action/
 * check tools are rejected there too.
 */
const TOOL_NAME_RE = /^[a-zA-Z0-9_-]{1,64}$/;

/** Throws if `name` is not a legal MCP tool name. */
export const validateToolName = ({ name }: { name: string }): void => {
  if (!TOOL_NAME_RE.test(name)) {
    throw new Error(
      `invalid MCP tool name "${name}": must match ${String(TOOL_NAME_RE)} (1-64 chars of [a-zA-Z0-9_-])`,
    );
  }
};
