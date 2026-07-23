import type { EmployeeMetric, ParsedJira, ParsedSlack, Person, SlackIdentity } from './types';

/**
 * Layer-1 per-employee structural metrics — field math only, no text
 * interpretation (plan Step 4). Every formula is documented inline and echoed
 * in ANALYTICS.md. All rates are rounded to one decimal. Reopen and
 * reassignment metrics are reported as `"unavailable"` (never a silent 0) when
 * the export carries no changelog history. Same export -> identical numbers.
 */

const DAY_MS = 86_400_000;

/** Recent-activity window: a person with no activity in the trailing 14 days */
/** of the data is flagged inactive (the departed-person edge case). */
const INACTIVE_WINDOW_MS = 14 * DAY_MS;

/** Complexity band from story points (Fibonacci): lo <=2, med =3, hi >=5. */
const bandFromPoints = ({ points }: { points: number }): 'hi' | 'med' | 'lo' =>
  points <= 2 ? 'lo' : points === 3 ? 'med' : 'hi';

/**
 * Fallback band when an issue has no story points: derived from issue type so
 * every issue still lands in exactly one band (complexity mix sums to the
 * ticket count). Stories/epics read as higher effort than bugs and tasks.
 */
const bandFromType = ({ issuetype }: { issuetype: string }): 'hi' | 'med' | 'lo' => {
  const t = issuetype.toLowerCase();
  if (t === 'story' || t === 'epic') {
    return 'hi';
  }
  if (t === 'bug') {
    return 'med';
  }
  return 'lo';
};

const median = ({ values }: { values: number[] }): number | null => {
  if (values.length === 0) {
    return null;
  }

  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);

  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
};

const round1 = ({ value }: { value: number }): number => Math.round(value * 10) / 10;

/** Off-hours: weekend (Sat/Sun) OR hour<7 OR hour>=22, all in UTC. */
const isOffHours = ({ ms }: { ms: number }): boolean => {
  const date = new Date(ms);
  const dow = date.getUTCDay();
  const hour = date.getUTCHours();

  return dow === 0 || dow === 6 || hour < 7 || hour >= 22;
};

/**
 * The time-half split point, derived from the data (never a pinned constant):
 * the midpoint between the earliest and latest issue `created` timestamps.
 */
const deriveHalfSplit = ({ jira }: { jira: ParsedJira }): number => {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;

  for (const issue of jira.issues) {
    if (issue.created === null) {
      continue;
    }
    const ms = Date.parse(issue.created);
    min = Math.min(min, ms);
    max = Math.max(max, ms);
  }

  if (!Number.isFinite(min) || !Number.isFinite(max)) {
    return 0;
  }

  return (min + max) / 2;
};

interface Accumulator {
  ticketCount: number;
  storyPointsTotal: number;
  mix: { hi: number; med: number; lo: number };
  cycleFirstHalf: number[];
  cycleSecondHalf: number[];
  reopenedIssues: number;
  reassignmentsGiven: number;
  reassignmentsReceived: number;
  offHoursCount: number;
  timestampCount: number;
  lastActivity: number;
}

const emptyAccumulator = (): Accumulator => ({
  ticketCount: 0,
  storyPointsTotal: 0,
  mix: { hi: 0, med: 0, lo: 0 },
  cycleFirstHalf: [],
  cycleSecondHalf: [],
  reopenedIssues: 0,
  reassignmentsGiven: 0,
  reassignmentsReceived: 0,
  offHoursCount: 0,
  timestampCount: 0,
  lastActivity: Number.NEGATIVE_INFINITY,
});

/**
 * Compute per-employee metrics for every merged person. `people` is the
 * account roster (merged by accountId); `identity` maps Slack userIds onto
 * those accounts for the off-hours timestamp pass.
 */
export const computeMetrics = ({
  jira,
  slack,
  identity,
  people,
}: {
  jira: ParsedJira;
  slack: ParsedSlack;
  identity: SlackIdentity;
  people: Person[];
}): EmployeeMetric[] => {
  const halfSplit = deriveHalfSplit({ jira });
  const acc = new Map<string, Accumulator>();
  const ensure = ({ accountId }: { accountId: string }): Accumulator => {
    let existing = acc.get(accountId);
    if (existing === undefined) {
      existing = emptyAccumulator();
      acc.set(accountId, existing);
    }
    return existing;
  };

  for (const person of people) {
    ensure({ accountId: person.accountId });
  }

  for (const issue of jira.issues) {
    if (issue.assigneeId !== null) {
      const a = ensure({ accountId: issue.assigneeId });
      a.ticketCount += 1;
      a.storyPointsTotal += issue.storyPoints ?? 0;

      // When story points are absent across the whole corpus, every assigned
      // issue lands in the `lo` bucket rather than fabricating a hi/med/lo
      // spread from issue type — consistent with a story-point total of 0.
      const band = !jira.storyPointsAvailable
        ? 'lo'
        : issue.storyPoints === null
          ? bandFromType({ issuetype: issue.issuetype })
          : bandFromPoints({ points: issue.storyPoints });
      a.mix[band] += 1;

      const created = issue.created === null ? null : Date.parse(issue.created);
      const resolved = issue.resolutiondate === null ? null : Date.parse(issue.resolutiondate);

      if (created !== null) {
        a.timestampCount += 1;
        if (isOffHours({ ms: created })) {
          a.offHoursCount += 1;
        }
        a.lastActivity = Math.max(a.lastActivity, created);
      }
      if (resolved !== null) {
        a.timestampCount += 1;
        if (isOffHours({ ms: resolved })) {
          a.offHoursCount += 1;
        }
        a.lastActivity = Math.max(a.lastActivity, resolved);
      }

      // ONT-013 D2: only a non-inverted pair contributes a cycle sample. When
      // `created` post-dates `resolutiondate` (or either date is unparseable,
      // yielding NaN — for which `resolved >= created` is false), that issue's
      // cycle is unavailable, so the median is taken over the valid remainder
      // and can never render negative.
      if (created !== null && resolved !== null && resolved >= created) {
        const cycleDays = (resolved - created) / DAY_MS;
        if (created < halfSplit) {
          a.cycleFirstHalf.push(cycleDays);
        } else {
          a.cycleSecondHalf.push(cycleDays);
        }
      }

      if (issue.statusTransitions.some((toString) => toString === 'Reopened')) {
        a.reopenedIssues += 1;
      }
    }

    for (const change of issue.assigneeChanges) {
      if (change.from !== null) {
        ensure({ accountId: change.from }).reassignmentsGiven += 1;
      }
      if (change.to !== null) {
        ensure({ accountId: change.to }).reassignmentsReceived += 1;
      }
    }
  }

  for (const message of slack.messages) {
    const accountId = identity.userToAccount.get(message.userId);
    if (accountId === undefined) {
      continue;
    }

    const a = ensure({ accountId });
    const ms = Number.parseFloat(message.ts) * 1000;
    a.timestampCount += 1;
    if (isOffHours({ ms })) {
      a.offHoursCount += 1;
    }
    a.lastActivity = Math.max(a.lastActivity, ms);
  }

  let maxActivity = Number.NEGATIVE_INFINITY;
  for (const a of acc.values()) {
    if (Number.isFinite(a.lastActivity)) {
      maxActivity = Math.max(maxActivity, a.lastActivity);
    }
  }

  const nameOf = new Map(people.map((p) => [p.accountId, p.displayName]));

  const employees: EmployeeMetric[] = [];
  for (const [accountId, a] of acc) {
    const displayName = nameOf.get(accountId) ?? jira.accounts.get(accountId) ?? accountId;

    const firstHalf = median({ values: a.cycleFirstHalf });
    const secondHalf = median({ values: a.cycleSecondHalf });

    const active =
      !Number.isFinite(a.lastActivity) ||
      !Number.isFinite(maxActivity) ||
      maxActivity - a.lastActivity <= INACTIVE_WINDOW_MS;

    employees.push({
      accountId,
      displayName,
      active,
      ticketCount: a.ticketCount,
      storyPointsTotal: a.storyPointsTotal,
      complexityMix: { ...a.mix },
      medianCycleDaysFirstHalf: firstHalf === null ? 0 : round1({ value: firstHalf }),
      medianCycleDaysSecondHalf: secondHalf === null ? 0 : round1({ value: secondHalf }),
      reopenRate: jira.changelogAvailable
        ? a.ticketCount === 0
          ? 0
          : round1({ value: (a.reopenedIssues / a.ticketCount) * 100 })
        : 'unavailable',
      reassignmentsGiven: jira.changelogAvailable ? a.reassignmentsGiven : 'unavailable',
      reassignmentsReceived: jira.changelogAvailable ? a.reassignmentsReceived : 'unavailable',
      helpGiven: 0,
      helpReceived: 0,
      weekendOffHoursShare:
        a.timestampCount === 0 ? 0 : round1({ value: (a.offHoursCount / a.timestampCount) * 100 }),
    });
  }

  employees.sort((a, b) => a.accountId.localeCompare(b.accountId));

  return employees;
};
