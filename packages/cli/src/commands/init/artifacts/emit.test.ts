import { describe, expect, it } from 'vitest';

import { emitArtifacts } from './emit';
import type { ExtractedOntology } from './types';

const ontology = ({ gate }: { gate: boolean }): ExtractedOntology => ({
  employees: [
    {
      accountId: 'acc_a',
      displayName: 'Ann "quote" A */',
      active: true,
      ticketCount: 3,
      storyPointsTotal: 8,
      complexityMix: { hi: 1, med: 1, lo: 1 },
      medianCycleDaysFirstHalf: 1.2,
      medianCycleDaysSecondHalf: 1.4,
      reopenRate: 'unavailable',
      reassignmentsGiven: 'unavailable',
      reassignmentsReceived: 'unavailable',
      helpGiven: 2,
      helpReceived: 1,
      weekendOffHoursShare: 10,
    },
  ],
  team: { id: 'com', name: 'Commerce', project: 'COM' },
  services: [
    {
      id: 'svc-a',
      name: 'svc-a',
      ticketCount: 3,
      distinctAssignees: 1,
      busFactor: 0,
      assignees: [],
    },
  ],
  incidents: [],
  memberOf: [{ from: 'acc_a', to: 'com', weight: 1 }],
  worksOn: [{ from: 'acc_a', to: 'svc-a', weight: 3 }],
  helps: [],
  candidates: [],
  findings: [
    { id: 1, title: 'WORKLOAD CONCENTRATION', detail: 'x', pointer: { accountIds: ['acc_a'] } },
  ],
  deployGateEvidenced: gate,
});

const config = ({ files }: { files: ReturnType<typeof emitArtifacts> }): string =>
  files.find((f) => f.path === 'orangerail.config.mjs')!.content;

describe('emitArtifacts', () => {
  it('emits the config, per-object data files, and ANALYTICS.md', () => {
    const files = emitArtifacts({ ontology: ontology({ gate: true }) });
    const paths = files.map((f) => f.path).sort();

    for (const expected of [
      'orangerail.config.mjs',
      'data/employee.json',
      'data/team.json',
      'data/service.json',
      'data/member_of.json',
      'data/works_on.json',
      'data/helps.json',
      'data/finding.json',
      'ANALYTICS.md',
    ]) {
      expect(paths).toContain(expected);
    }
  });

  it('declares the three link types in the generated config', () => {
    const text = config({ files: emitArtifacts({ ontology: ontology({ gate: true }) }) });
    for (const link of ['member_of', 'works_on', 'helps']) {
      expect(text).toContain(link);
    }
  });

  it('emits a governed action only when a gate is evidenced', () => {
    expect(config({ files: emitArtifacts({ ontology: ontology({ gate: true }) }) })).toContain(
      'deploy_service',
    );
    expect(config({ files: emitArtifacts({ ontology: ontology({ gate: false }) }) })).not.toContain(
      'deploy_service',
    );
  });

  it('is byte-deterministic across two runs (same input -> same bytes)', () => {
    const a = emitArtifacts({ ontology: ontology({ gate: true }) });
    const b = emitArtifacts({ ontology: ontology({ gate: true }) });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('carries a hostile displayName safely inside a JSON data file, not the config body', () => {
    const files = emitArtifacts({ ontology: ontology({ gate: true }) });
    const employees = files.find((f) => f.path === 'data/employee.json')!.content;

    // The hostile string round-trips through JSON, and the config never inlines it.
    expect(JSON.parse(employees)[0].displayName).toBe('Ann "quote" A */');
    expect(config({ files }).includes('Ann "quote" A */')).toBe(false);
  });
});
