import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import {
  buildAgentFleetSnapshot,
  emptyAgentFleetSnapshot,
  type AgentFleetSnapshot,
  type FleetManifest,
} from 'orangerail-studio/snapshot';

/**
 * Read the agent-fleet manifest from the config's sibling `data/fleet.json` and
 * derive its governance snapshot. The manifest is the between-agent metadata a
 * scan of N registries plus a delegation source (A2A Agent Cards / an explicit
 * fleet file) produces; it is reachable no other way in v0 (the core registry
 * models one agent, not a fleet). A missing or unparseable file — the common
 * case for a project with no fleet — degrades to the empty snapshot, so the
 * studio's agent category simply stays unavailable rather than erroring.
 *
 * `buildAgentFleetSnapshot` is pure and deterministic, so ordering/derivation
 * live in one place (the same posture as `gatherInstances`).
 */
export const gatherFleet = ({ configPath }: { configPath: string }): AgentFleetSnapshot => {
  try {
    const file = join(dirname(configPath), 'data', 'fleet.json');
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));

    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      !Array.isArray((parsed as { agents?: unknown }).agents)
    ) {
      return emptyAgentFleetSnapshot();
    }

    return buildAgentFleetSnapshot({ manifest: parsed as FleetManifest });
  } catch {
    return emptyAgentFleetSnapshot();
  }
};
