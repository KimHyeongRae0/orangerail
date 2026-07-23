/**
 * The instance wire format — the JSON the CLI serves at `/api/instances` and the
 * browser app's human category consumes (plan section 3.1 / 3.2). It carries the
 * *instances* the human-source ontology exposes (people, services, teams,
 * incidents) plus the collaboration edges (`helps`/`works_on`/`member_of`).
 * Kept in this node-consumable entry so the CLI gatherer and the app share one
 * source of truth without the CLI importing any React/Vite code.
 */

/** A per-person metric value; a field the scanner could not derive is the literal `'unavailable'`. */
export type MetricValue = number | 'unavailable';

/** The complexity bucketing of a person's assigned issues (by story points). */
export interface ComplexityMix {
  hi: number;
  med: number;
  lo: number;
}

/** One person instance, carrying the ONT-010 evidence-backed metrics verbatim. */
export interface InstanceEmployee {
  accountId: string;
  displayName: string;
  active: boolean;
  ticketCount: number;
  storyPointsTotal: number;
  complexityMix: ComplexityMix;
  medianCycleDaysFirstHalf: MetricValue;
  medianCycleDaysSecondHalf: MetricValue;
  reopenRate: MetricValue;
  reassignmentsGiven: MetricValue;
  reassignmentsReceived: MetricValue;
  helpGiven: number;
  helpReceived: number;
  weekendOffHoursShare: MetricValue;
}

/** One service instance. */
export interface InstanceService {
  id: string;
  name: string;
  ticketCount: number;
  distinctAssignees: number;
  busFactor: number;
}

/** One team instance. */
export interface InstanceTeam {
  id: string;
  name: string;
  project: string;
}

/** One incident instance (surfaced in the snapshot for completeness). */
export interface InstanceIncident {
  id: string;
  date: string;
  channel: string;
  leadResponder: string;
  leadResponderAccountId: string;
  hasTrackerIssue: boolean;
  participantAccountIds: string[];
}

/** A directed, weighted collaboration edge between two instances. */
export interface InstanceEdge {
  from: string;
  to: string;
  weight: number;
}

/** The complete, deterministic instance snapshot (stably ordered). */
export interface InstanceSnapshot {
  employees: InstanceEmployee[];
  services: InstanceService[];
  teams: InstanceTeam[];
  incidents: InstanceIncident[];
  edges: {
    helps: InstanceEdge[];
    works_on: InstanceEdge[];
    member_of: InstanceEdge[];
  };
}

const byAccountId = (a: InstanceEmployee, b: InstanceEmployee): number =>
  a.accountId.localeCompare(b.accountId);

const byId = <T extends { id: string }>(a: T, b: T): number => a.id.localeCompare(b.id);

const byEdge = (a: InstanceEdge, b: InstanceEdge): number =>
  a.from.localeCompare(b.from) || a.to.localeCompare(b.to);

/**
 * Normalize a raw edge array into `{ from, to, weight }` rows: only rows with
 * string endpoints survive, a missing/non-numeric weight defaults to `1`, and
 * the result is sorted `(from, to)` for byte-stable determinism (AC-7).
 */
const normalizeEdges = ({ rows }: { rows: unknown[] }): InstanceEdge[] =>
  rows
    .filter(
      (row): row is { from: string; to: string; weight?: unknown } =>
        typeof row === 'object' &&
        row !== null &&
        typeof (row as { from?: unknown }).from === 'string' &&
        typeof (row as { to?: unknown }).to === 'string',
    )
    .map((row) => ({
      from: row.from,
      to: row.to,
      weight: typeof row.weight === 'number' ? row.weight : 1,
    }))
    .sort(byEdge);

/**
 * Build the deterministic instance snapshot from the gathered instances and raw
 * edge rows (plan section 3.1). Pure, no I/O: people are sorted by `accountId`,
 * services/teams/incidents by `id`, edges by `(from, to)`, all with a stable
 * comparator and no timestamps — byte-stable for a fixed config/data set (the
 * same determinism rule as `buildSnapshot`). Metric values (including the
 * literal `'unavailable'`) pass through verbatim; every string later renders as
 * inert React text (AC-6).
 */
export const buildInstanceSnapshot = ({
  employees,
  services,
  teams,
  incidents,
  helps,
  worksOn,
  memberOf,
}: {
  employees: InstanceEmployee[];
  services: InstanceService[];
  teams: InstanceTeam[];
  incidents: InstanceIncident[];
  helps: unknown[];
  worksOn: unknown[];
  memberOf: unknown[];
}): InstanceSnapshot => ({
  employees: [...employees].sort(byAccountId),
  services: [...services].sort(byId),
  teams: [...teams].sort(byId),
  incidents: [...incidents].sort(byId),
  edges: {
    helps: normalizeEdges({ rows: helps }),
    works_on: normalizeEdges({ rows: worksOn }),
    member_of: normalizeEdges({ rows: memberOf }),
  },
});
