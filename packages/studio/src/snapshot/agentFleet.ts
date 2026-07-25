/**
 * Deterministic, offline agent-fleet governance model. A pure function over a
 * fleet manifest that derives the governance facts a fleet of orchestrating
 * agents raises: authority overlaps, per-agent direct-vs-effective blast radius,
 * delegation cycles, recursive spawners, and ungated destructive actions. No
 * network, no LLM, no clock, no randomness — every output is a pure function of
 * the input and every list is sorted, so the snapshot is byte-stable for a fixed
 * manifest (the same determinism posture as `buildInstanceSnapshot` /
 * `buildHelpMatrix`).
 *
 * The per-action shape is taken directly from the real product types
 * (`packages/core/src/types.ts`): `AgentAction` mirrors `ActionDefinition`
 * (`name`, `target`, `targetIdFrom`, `policy`) and `AgentPolicy` mirrors
 * `RuntimePolicy` (`approval` + `roles`). The whole authority-overlap /
 * object-writer / ungated-destructive layer falls straight out of that declared
 * action+policy data at N=1. Everything above the single-action level — `verb`
 * (scanner-classified), `delegatesTo`, `spawns`, `role`, `spawnedBy`,
 * `ephemeral` — is between-agent / run-time metadata that no single config
 * expresses today; a fleet manifest (A2A Agent Card-style) supplies it.
 */

/** Write verb, classified by the action scanner (not on `ActionDefinition` today). */
export type ActionVerb = 'create' | 'update' | 'delete';

/** Coarse agent classification for the view's supervisor/spawner badges. */
export type AgentRole = 'supervisor' | 'worker' | 'hybrid';

/**
 * Shaped from the real `RuntimePolicy` (`approval?: 'required'` + `roles`). A
 * manifest may encode an auto action as `approval: null`; both `null` and absent
 * are treated as auto, and only the literal `'required'` as gated.
 */
export interface AgentPolicy {
  approval?: 'required' | null;
  roles?: string[];
}

/**
 * One declared write-action, shaped from `ActionDefinition`. `target` is the
 * object type name (the real type carries the full `ObjectDefinition`; a manifest
 * only needs its `.name`).
 */
export interface AgentAction {
  name: string;
  target: string;
  verb: ActionVerb;
  policy?: AgentPolicy;
  targetIdFrom?: string;
}

/** A recursive-spawn template (run-time fan-out, in no config). */
export interface SpawnTemplate {
  template: string;
  recursive: boolean;
  note?: string;
}

/**
 * One agent = one orangerail registry (its declared `actions`) plus the
 * between-agent fleet-manifest edges (`delegatesTo`, `spawns`, `spawnedBy`).
 */
export interface AgentConfig {
  id: string;
  name: string;
  role?: AgentRole;
  purpose?: string;
  actions: AgentAction[];
  delegatesTo?: string[];
  spawns?: SpawnTemplate;
  ephemeral?: boolean;
  spawnedBy?: string;
}

/** The fleet manifest — the shape a scan of N configs plus a delegation source yields. */
export interface FleetManifest {
  domain?: string;
  objects?: string[];
  approverRoles?: string[];
  agents: AgentConfig[];
}

/** An (action, object) pair declared by more than one agent. */
export interface AuthorityOverlap {
  action: string;
  object: string;
  agents: string[];
}

/** An object with more than one distinct writer (any action). */
export interface ObjectWriters {
  object: string;
  agents: string[];
}

/**
 * Direct (self-declared) vs effective (transitive) write authority for one
 * agent. The gap between `directObjects` and `effectiveObjects` is the headline
 * supervisor risk. `unbounded` is true when the reachable closure contains a
 * recursive spawner — the run-time fan-out is not knowable from config.
 */
export interface BlastRadius {
  agentId: string;
  directActions: number;
  directObjects: string[];
  effectiveActions: number;
  effectiveObjects: string[];
  reachableAgents: string[];
  destructiveObjects: string[];
  unbounded: boolean;
}

/** A strongly-connected component in the delegation graph (a cycle). */
export interface DelegationCycle {
  agents: string[];
}

/** An agent that spawns sub-agents at run time from a template. */
export interface RecursiveSpawner {
  agentId: string;
  template: string;
  recursive: boolean;
  spawnedChildren: string[];
}

/** A destructive (`delete`) action with no approval gate on the rail. */
export interface UngatedDestructiveAction {
  agentId: string;
  action: string;
  object: string;
}

/** The full derived governance snapshot for a fleet. */
export interface AgentFleetSnapshot {
  agentCount: number;
  authorityOverlaps: AuthorityOverlap[];
  objectWriters: ObjectWriters[];
  blastRadius: BlastRadius[];
  delegationCycles: DelegationCycle[];
  recursiveSpawners: RecursiveSpawner[];
  ungatedDestructiveActions: UngatedDestructiveAction[];
}

/** The empty snapshot — the natural degrade when no fleet manifest is present. */
export const emptyAgentFleetSnapshot = (): AgentFleetSnapshot => ({
  agentCount: 0,
  authorityOverlaps: [],
  objectWriters: [],
  blastRadius: [],
  delegationCycles: [],
  recursiveSpawners: [],
  ungatedDestructiveActions: [],
});

/** A write-action is gated only when its policy demands human approval. */
const isGated = ({ action }: { action: AgentAction }): boolean =>
  action.policy?.approval === 'required';

/** A write-action is destructive when its verb erases the target object. */
const isDestructive = ({ action }: { action: AgentAction }): boolean => action.verb === 'delete';

/** Distinct object targets an agent itself declares a write on, sorted. */
const directObjectsOf = ({ agent }: { agent: AgentConfig }): string[] =>
  [...new Set(agent.actions.map((a) => a.target))].sort();

/**
 * (action, object) pairs held by more than one agent — the split-authority /
 * accountability conflict (e.g. `issueRefund` on `Refund` by refund + billing).
 * Deterministic: keyed on (action, object), agents and rows both sorted.
 */
export const deriveAuthorityOverlaps = ({
  manifest,
}: {
  manifest: FleetManifest;
}): AuthorityOverlap[] => {
  const byPair = new Map<string, { action: string; object: string; agents: Set<string> }>();

  for (const agent of manifest.agents) {
    for (const action of agent.actions) {
      const key = `${action.name} ${action.target}`;
      const entry = byPair.get(key) ?? {
        action: action.name,
        object: action.target,
        agents: new Set(),
      };

      entry.agents.add(agent.id);
      byPair.set(key, entry);
    }
  }

  return [...byPair.values()]
    .filter((e) => e.agents.size > 1)
    .map((e) => ({ action: e.action, object: e.object, agents: [...e.agents].sort() }))
    .sort((a, b) => a.action.localeCompare(b.action) || a.object.localeCompare(b.object));
};

/**
 * Objects written by more than one agent (across any action) — the object-focus
 * hotspot ("who can write `Order`?"). Complements the (action, object) overlaps
 * with the coarser object-level conflict.
 */
export const deriveObjectWriters = ({ manifest }: { manifest: FleetManifest }): ObjectWriters[] => {
  const byObject = new Map<string, Set<string>>();

  for (const agent of manifest.agents) {
    for (const action of agent.actions) {
      const set = byObject.get(action.target) ?? new Set<string>();

      set.add(agent.id);
      byObject.set(action.target, set);
    }
  }

  return [...byObject.entries()]
    .filter(([, agents]) => agents.size > 1)
    .map(([object, agents]) => ({ object, agents: [...agents].sort() }))
    .sort((a, b) => a.object.localeCompare(b.object));
};

/**
 * Reachability adjacency: an agent reaches every agent it delegates to AND every
 * child it spawns (children carry `spawnedBy`). Both are how authority flows down
 * a tree, so both count toward effective blast radius. Unknown ids (dangling
 * references) are dropped. Neighbours are sorted for determinism.
 */
const buildReachEdges = ({ manifest }: { manifest: FleetManifest }): Map<string, string[]> => {
  const known = new Set(manifest.agents.map((a) => a.id));
  const spawnedByParent = new Map<string, string[]>();

  for (const agent of manifest.agents) {
    if (agent.spawnedBy && known.has(agent.spawnedBy)) {
      const children = spawnedByParent.get(agent.spawnedBy) ?? [];

      children.push(agent.id);
      spawnedByParent.set(agent.spawnedBy, children);
    }
  }

  const edges = new Map<string, string[]>();

  for (const agent of manifest.agents) {
    const delegates = (agent.delegatesTo ?? []).filter((id) => known.has(id));
    const spawns = spawnedByParent.get(agent.id) ?? [];
    const out = [...new Set([...delegates, ...spawns])].sort();

    edges.set(agent.id, out);
  }

  return edges;
};

/**
 * Delegation-only adjacency (`delegatesTo`, excluding spawns) — the graph whose
 * cycles are the delegation cycles (billing ⇄ dunning). Spawned children never
 * delegate back, so keeping spawns out of cycle detection keeps recursion a
 * separate, clearly-labelled finding.
 */
const buildDelegationEdges = ({ manifest }: { manifest: FleetManifest }): Map<string, string[]> => {
  const known = new Set(manifest.agents.map((a) => a.id));
  const edges = new Map<string, string[]>();

  for (const agent of manifest.agents) {
    edges.set(
      agent.id,
      [...new Set((agent.delegatesTo ?? []).filter((id) => known.has(id)))].sort(),
    );
  }

  return edges;
};

/** BFS closure of the reachable agents from `startId` (excludes `startId`). */
const reachableFrom = ({
  startId,
  edges,
}: {
  startId: string;
  edges: Map<string, string[]>;
}): Set<string> => {
  const seen = new Set<string>();
  const queue = [...(edges.get(startId) ?? [])];

  while (queue.length > 0) {
    const next = queue.shift()!;

    if (seen.has(next) || next === startId) {
      continue;
    }

    seen.add(next);
    queue.push(...(edges.get(next) ?? []));
  }

  return seen;
};

/**
 * Per-agent direct-vs-effective blast radius over the delegation+spawn closure.
 * A leaf worker's two radii are equal; a supervisor's diverge sharply (the
 * ops-supervisor 1-vs-12 headline). Destructive reach and an `unbounded` flag (a
 * recursive spawner sits in the closure) are computed alongside. One row per
 * agent, rows sorted by id, every list sorted.
 */
export const deriveBlastRadius = ({ manifest }: { manifest: FleetManifest }): BlastRadius[] => {
  const byId = new Map(manifest.agents.map((a) => [a.id, a] as const));
  const edges = buildReachEdges({ manifest });

  return manifest.agents
    .map((agent) => {
      const reachable = reachableFrom({ startId: agent.id, edges });
      const closure = [agent, ...[...reachable].map((id) => byId.get(id)!)];

      const effectiveObjects = new Set<string>();
      const destructiveObjects = new Set<string>();
      let effectiveActions = 0;
      let unbounded = false;

      for (const member of closure) {
        effectiveActions += member.actions.length;

        for (const action of member.actions) {
          effectiveObjects.add(action.target);

          if (isDestructive({ action })) {
            destructiveObjects.add(action.target);
          }
        }

        if (member.spawns?.recursive) {
          unbounded = true;
        }
      }

      return {
        agentId: agent.id,
        directActions: agent.actions.length,
        directObjects: directObjectsOf({ agent }),
        effectiveActions,
        effectiveObjects: [...effectiveObjects].sort(),
        reachableAgents: [...reachable].sort(),
        destructiveObjects: [...destructiveObjects].sort(),
        unbounded,
      };
    })
    .sort((a, b) => a.agentId.localeCompare(b.agentId));
};

/**
 * Strongly-connected components (Tarjan) of the delegation graph, reported when
 * they represent a cycle: a component of 2+ agents, or a single agent that
 * delegates to itself. Node and neighbour iteration is sorted so the SCC set and
 * each member list are byte-stable.
 */
export const deriveDelegationCycles = ({
  manifest,
}: {
  manifest: FleetManifest;
}): DelegationCycle[] => {
  const edges = buildDelegationEdges({ manifest });
  const nodes = [...edges.keys()].sort();

  const indexOf = new Map<string, number>();
  const lowlink = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const components: string[][] = [];
  let counter = 0;

  // Iterative Tarjan (explicit work stack) — deterministic over sorted nodes.
  const strongConnect = ({ root }: { root: string }): void => {
    const work: { node: string; edgeIndex: number }[] = [{ node: root, edgeIndex: 0 }];

    indexOf.set(root, counter);
    lowlink.set(root, counter);
    counter += 1;
    stack.push(root);
    onStack.add(root);

    while (work.length > 0) {
      const frame = work[work.length - 1]!;
      const neighbours = edges.get(frame.node) ?? [];

      if (frame.edgeIndex < neighbours.length) {
        const child = neighbours[frame.edgeIndex]!;

        frame.edgeIndex += 1;

        if (!indexOf.has(child)) {
          indexOf.set(child, counter);
          lowlink.set(child, counter);
          counter += 1;
          stack.push(child);
          onStack.add(child);
          work.push({ node: child, edgeIndex: 0 });
        } else if (onStack.has(child)) {
          lowlink.set(frame.node, Math.min(lowlink.get(frame.node)!, indexOf.get(child)!));
        }

        continue;
      }

      if (lowlink.get(frame.node) === indexOf.get(frame.node)) {
        const component: string[] = [];
        let member: string;

        do {
          member = stack.pop()!;
          onStack.delete(member);
          component.push(member);
        } while (member !== frame.node);

        components.push(component.sort());
      }

      work.pop();

      if (work.length > 0) {
        const parent = work[work.length - 1]!.node;

        lowlink.set(parent, Math.min(lowlink.get(parent)!, lowlink.get(frame.node)!));
      }
    }
  };

  for (const node of nodes) {
    if (!indexOf.has(node)) {
      strongConnect({ root: node });
    }
  }

  const selfLoops = new Set(nodes.filter((n) => (edges.get(n) ?? []).includes(n)));

  return components
    .filter((c) => c.length > 1 || selfLoops.has(c[0]!))
    .map((agents) => ({ agents }))
    .sort((a, b) => a.agents[0]!.localeCompare(b.agents[0]!));
};

/**
 * Agents that spawn sub-agents at run time (`spawns` present). The declared
 * children (`spawnedBy` back-references) are an upper bound on what a spawned
 * child may touch; the live count is unbounded.
 */
export const deriveRecursiveSpawners = ({
  manifest,
}: {
  manifest: FleetManifest;
}): RecursiveSpawner[] => {
  const spawnedByParent = new Map<string, string[]>();

  for (const agent of manifest.agents) {
    if (agent.spawnedBy) {
      const children = spawnedByParent.get(agent.spawnedBy) ?? [];

      children.push(agent.id);
      spawnedByParent.set(agent.spawnedBy, children);
    }
  }

  return manifest.agents
    .filter((agent) => agent.spawns !== undefined)
    .map((agent) => ({
      agentId: agent.id,
      template: agent.spawns!.template,
      recursive: agent.spawns!.recursive,
      spawnedChildren: [...(spawnedByParent.get(agent.id) ?? [])].sort(),
    }))
    .sort((a, b) => a.agentId.localeCompare(b.agentId));
};

/**
 * Destructive (`delete`) actions with no approval gate — a delete with no signal
 * on the rail (e.g. `data-cleanup-agent.deleteTicket`). Sorted by agent, action.
 */
export const deriveUngatedDestructiveActions = ({
  manifest,
}: {
  manifest: FleetManifest;
}): UngatedDestructiveAction[] =>
  manifest.agents
    .flatMap((agent) =>
      agent.actions
        .filter((action) => isDestructive({ action }) && !isGated({ action }))
        .map((action) => ({ agentId: agent.id, action: action.name, object: action.target })),
    )
    .sort((a, b) => a.agentId.localeCompare(b.agentId) || a.action.localeCompare(b.action));

/**
 * Assemble the full `AgentFleetSnapshot` from a fleet manifest. Pure and
 * deterministic — the single entry point the studio agent view consumes.
 */
export const buildAgentFleetSnapshot = ({
  manifest,
}: {
  manifest: FleetManifest;
}): AgentFleetSnapshot => ({
  agentCount: manifest.agents.length,
  authorityOverlaps: deriveAuthorityOverlaps({ manifest }),
  objectWriters: deriveObjectWriters({ manifest }),
  blastRadius: deriveBlastRadius({ manifest }),
  delegationCycles: deriveDelegationCycles({ manifest }),
  recursiveSpawners: deriveRecursiveSpawners({ manifest }),
  ungatedDestructiveActions: deriveUngatedDestructiveActions({ manifest }),
});
