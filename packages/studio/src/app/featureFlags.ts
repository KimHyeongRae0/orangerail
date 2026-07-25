/**
 * Build-time scope flags for the v0 first open.
 *
 * `AGENT_VIEW_ENABLED` gates the agent authority view (the `agent` source
 * category, rendered by FleetView). It is built but shelved: its data source is
 * not yet honest — no scanner turns real declared agent configs into a fleet
 * manifest — so the first open ships a single story (declare a domain → a
 * governed MCP server and a map you can trust) rather than surface a view fed by
 * a hand-authored sample.
 *
 * When off, the Agent tab is not rendered at all (not merely disabled — a greyed
 * tab still advertises a feature that is not part of v0). Flip to `true` to bring
 * the view back once a bounded, declared-source scanner exists; the FleetView
 * code path stays wired regardless. The bipartite agent↔object authority graph
 * lives on the `feat/agent-authority-graph` spike.
 */
export const AGENT_VIEW_ENABLED = false;
