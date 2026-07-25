import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  buildAgentFleetSnapshot,
  deriveAuthorityOverlaps,
  deriveDelegationCycles,
  deriveRecursiveSpawners,
  deriveUngatedDestructiveActions,
  emptyAgentFleetSnapshot,
  type FleetManifest,
} from './agentFleet';

const sampleFleet: FleetManifest = JSON.parse(
  readFileSync(fileURLToPath(new URL('./agentFleet.sample.json', import.meta.url)), 'utf8'),
);

const blastFor = ({
  snapshot,
  id,
}: {
  snapshot: ReturnType<typeof buildAgentFleetSnapshot>;
  id: string;
}) => snapshot.blastRadius.find((b) => b.agentId === id)!;

describe('deriveAuthorityOverlaps — the split-authority headline', () => {
  it('flags refund-agent & billing-agent both declaring issueRefund on Refund', () => {
    const overlaps = deriveAuthorityOverlaps({ manifest: sampleFleet });
    const refundOverlap = overlaps.find(
      (o) => o.action === 'issueRefund' && o.object === 'Refund',
    )!;

    expect(refundOverlap).toBeDefined();
    expect(refundOverlap.agents).toEqual(['billing-agent', 'refund-agent']);
  });

  it('only reports (action, object) pairs held by more than one agent', () => {
    const overlaps = deriveAuthorityOverlaps({ manifest: sampleFleet });

    expect(overlaps.every((o) => o.agents.length > 1)).toBe(true);
  });

  it('is deterministic — same manifest yields byte-identical overlaps', () => {
    expect(deriveAuthorityOverlaps({ manifest: sampleFleet })).toEqual(
      deriveAuthorityOverlaps({ manifest: sampleFleet }),
    );
  });
});

describe('deriveBlastRadius — direct vs effective divergence', () => {
  it('ops-supervisor declares 1 action but reaches 12 objects transitively', () => {
    const snapshot = buildAgentFleetSnapshot({ manifest: sampleFleet });
    const supervisor = blastFor({ snapshot, id: 'ops-supervisor' });

    // Direct: exactly one auto action on one object.
    expect(supervisor.directActions).toBe(1);
    expect(supervisor.directObjects).toEqual(['Task']);

    // Effective: the near-entire object set via delegation + spawn closure.
    expect(supervisor.effectiveObjects.length).toBe(12);
    expect(supervisor.effectiveActions).toBeGreaterThan(supervisor.directActions);
    // The destructive leaves the top-level approval does NOT cover.
    expect(supervisor.destructiveObjects).toEqual([
      'Customer',
      'Invoice',
      'Order',
      'Shipment',
      'Ticket',
    ]);
    // A recursive spawner sits in the closure — run-time fan-out is unbounded.
    expect(supervisor.unbounded).toBe(true);
  });

  it('a leaf worker has equal direct and effective radius', () => {
    const snapshot = buildAgentFleetSnapshot({ manifest: sampleFleet });
    const leaf = blastFor({ snapshot, id: 'fulfillment-agent' });

    expect(leaf.reachableAgents).toEqual([]);
    expect(leaf.effectiveObjects).toEqual(leaf.directObjects);
    expect(leaf.unbounded).toBe(false);
  });
});

describe('deriveRecursiveSpawners & ungated destructive actions — data-cleanup-agent', () => {
  it('detects the recursive spawner and its declared erasure children', () => {
    const spawners = deriveRecursiveSpawners({ manifest: sampleFleet });

    expect(spawners.map((s) => s.agentId)).toEqual(['data-cleanup-agent']);
    expect(spawners[0]!.recursive).toBe(true);
    expect(spawners[0]!.template).toBe('object-eraser');
    expect(spawners[0]!.spawnedChildren).toEqual([
      'customer-eraser',
      'invoice-shredder',
      'order-purger',
    ]);
  });

  it('flags deleteTicket as the one ungated destructive action in the fleet', () => {
    const ungated = deriveUngatedDestructiveActions({ manifest: sampleFleet });

    expect(ungated).toEqual([
      { agentId: 'data-cleanup-agent', action: 'deleteTicket', object: 'Ticket' },
    ]);
  });
});

describe('deriveDelegationCycles — billing <-> dunning', () => {
  it('detects the billing/dunning delegation cycle', () => {
    const cycles = deriveDelegationCycles({ manifest: sampleFleet });
    const billingCycle = cycles.find((c) => c.agents.includes('billing-agent'))!;

    expect(billingCycle).toBeDefined();
    expect(billingCycle.agents).toEqual(['billing-agent', 'dunning-agent']);
  });

  it('reports no cycle for an acyclic delegation chain, and detects a self-loop', () => {
    const acyclic: FleetManifest = {
      agents: [
        { id: 'a', name: 'A', actions: [], delegatesTo: ['b'] },
        { id: 'b', name: 'B', actions: [], delegatesTo: ['c'] },
        { id: 'c', name: 'C', actions: [] },
      ],
    };
    const selfLooping: FleetManifest = {
      agents: [{ id: 'loop', name: 'Loop', actions: [], delegatesTo: ['loop'] }],
    };

    expect(deriveDelegationCycles({ manifest: acyclic })).toEqual([]);
    expect(deriveDelegationCycles({ manifest: selfLooping })).toEqual([{ agents: ['loop'] }]);
  });
});

describe('buildAgentFleetSnapshot — whole-snapshot determinism + empty degrade', () => {
  it('counts every agent and re-derives identically', () => {
    const first = buildAgentFleetSnapshot({ manifest: sampleFleet });
    const second = buildAgentFleetSnapshot({ manifest: sampleFleet });

    expect(first.agentCount).toBe(sampleFleet.agents.length);
    expect(first).toEqual(second);
  });

  it('an empty manifest degrades to the empty snapshot shape', () => {
    const built = buildAgentFleetSnapshot({ manifest: { agents: [] } });

    expect(built).toEqual(emptyAgentFleetSnapshot());
  });
});
