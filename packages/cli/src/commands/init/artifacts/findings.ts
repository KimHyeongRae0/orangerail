import { groupThreads, rootOf } from './graph';
import type {
  EmployeeMetric,
  IncidentInstance,
  MetricOrUnavailable,
  OrgFinding,
  ParsedSlack,
  Person,
  ServiceInstance,
  SlackIdentity,
  SlackMessage,
} from './types';

/**
 * Org findings by direct computation, each carrying its evidence pointer(s)
 * (plan Step 7). No finding appears without a data pointer, and none is a
 * semantic read: workload concentration is a story-point share, bus factor is a
 * distinct-assignee set, knowledge hubs are help-graph in-degree, and the
 * process-gap / approval-vacuum findings are structural chat patterns
 * (ticket-less incident threads; deploy threads with no approval reply after
 * the historical approver stops appearing). All boundaries are derived from the
 * data, never pinned.
 */

const ISSUE_KEY = /\bCOM-\d+\b/;
const APPROVAL = /\b(approv\w*|go for it|green light|ship it|👍|go ahead|ok to ship|lgtm)\b/i;
const DEPLOY_INTENT = /\b(deploy\w*|releas\w*|shipping|ship|going out|hotfix|rollback)\b/i;
const DEPLOY_CHANNELS = new Set(['deploys', '#deploys']);

const firstKey = ({ text }: { text: string }): string | null => {
  const match = ISSUE_KEY.exec(text);
  return match === null ? null : match[0];
};

/**
 * Coerce a possibly-`"unavailable"` metric to a number for arithmetic. Only
 * ever reached on the both-sources path (where help metrics are numeric); the
 * Slack-dependent builders early-return a not-evaluated note before any help
 * arithmetic when no Slack export was provided.
 */
const num = ({ value }: { value: MetricOrUnavailable }): number =>
  value === 'unavailable' ? 0 : value;

/**
 * A Slack-dependent finding that could not be measured on a Jira-only run:
 * keep the slot's id/title, but state honestly that it was not evaluated
 * rather than asserting a superlative over an absent value.
 */
const notEvaluated = ({
  id,
  title,
  signal,
}: {
  id: number;
  title: string;
  signal: string;
}): OrgFinding => ({
  id,
  title,
  detail: `Not evaluated: no Slack export was provided, so ${signal} could not be measured.`,
  pointer: { notEvaluated: true, reason: 'no Slack export' },
});

/** Workload concentration: the two people carrying the most story points. */
const workloadFinding = ({ employees }: { employees: EmployeeMetric[] }): OrgFinding | null => {
  const total = employees.reduce((sum, e) => sum + e.storyPointsTotal, 0);

  // R1: no evidence (no people or no story points at all) -> no confident finding.
  if (employees.length === 0 || total === 0) {
    return null;
  }

  const ranked = [...employees].sort(
    (a, b) => b.storyPointsTotal - a.storyPointsTotal || a.accountId.localeCompare(b.accountId),
  );
  const top = ranked.slice(0, 2);
  const topPoints = top.reduce((sum, e) => sum + e.storyPointsTotal, 0);

  // ONT-013 D1: a "share of team total" can never exceed 100%. The D2 parse
  // boundary already excludes negative points (so `total >= 0` and, since `top`
  // is a subset of `employees`, `topPoints <= total`), and the R1 gate above
  // drops the finding when `total === 0`; this clamp is self-documenting
  // defense-in-depth — a strict no-op on valid input (a real top-2 share is
  // already <= 100) that makes an above-100 percentage structurally impossible.
  const share = Math.min(100, Math.round((topPoints / total) * 1000) / 10);

  return {
    id: 1,
    title: 'WORKLOAD CONCENTRATION',
    detail:
      `Top 2 by story points carry ${share}% of the team total (${topPoints}/${total}). ` +
      'Formula: sum(storyPoints) per assignee, top-2 share of the grand total.',
    pointer: {
      accountIds: top.map((e) => e.accountId),
      names: top.map((e) => e.displayName),
      topStoryPoints: topPoints,
      totalStoryPoints: total,
      sharePct: share,
    },
  };
};

/** Invisible value: high chat-help / low tracker weight and the inverse. */
const invisibleValueFinding = ({
  employees,
  slackProvided,
  orgEmpty,
}: {
  employees: EmployeeMetric[];
  slackProvided: boolean;
  orgEmpty: boolean;
}): OrgFinding | null => {
  // H2/H4: help is Slack-derived. Mark, never assert a superlative over 0/absent.
  // ONT-013 D3: on a truly empty org there is nothing to not-evaluate, so drop
  // the placeholder entirely (never emit a "not evaluated" note for no one).
  if (!slackProvided) {
    return orgEmpty
      ? null
      : notEvaluated({
          id: 2,
          title: 'INVISIBLE VALUE (chat help vs tracker weight)',
          signal: 'chat help versus tracker weight (helpGiven)',
        });
  }

  // R1: no people -> no finding.
  if (employees.length === 0) {
    return null;
  }

  const topHelper = [...employees].sort(
    (a, b) =>
      num({ value: b.helpGiven }) - num({ value: a.helpGiven }) ||
      a.accountId.localeCompare(b.accountId),
  )[0];
  const noHelp = employees
    .filter((e) => e.helpGiven === 0 && e.ticketCount > 0)
    .sort((a, b) => b.ticketCount - a.ticketCount || a.accountId.localeCompare(b.accountId));

  return {
    id: 2,
    title: 'INVISIBLE VALUE (chat help vs tracker weight)',
    detail:
      `${topHelper?.displayName ?? 'n/a'} is the top help-giver (helpGiven=${topHelper?.helpGiven ?? 0}) ` +
      'while carrying mid-pack story points; high-ticket / zero-help people show the inverse. ' +
      'Formula: helpGiven (Slack help-edge out-degree) vs storyPointsTotal.',
    pointer: {
      topHelperAccountId: topHelper?.accountId ?? null,
      topHelperHelpGiven: topHelper?.helpGiven ?? 0,
      zeroHelpHighTicket: noHelp
        .slice(0, 3)
        .map((e) => ({ accountId: e.accountId, ticketCount: e.ticketCount, helpGiven: 0 })),
    },
  };
};

/** Process gaps: ticket-less incident threads + ticket-less deploy hotfixes. */
const processGapFinding = ({
  incidents,
  slack,
  identity,
  slackProvided,
  orgEmpty,
}: {
  incidents: IncidentInstance[];
  slack: ParsedSlack;
  identity: SlackIdentity;
  slackProvided: boolean;
  orgEmpty: boolean;
}): OrgFinding | null => {
  // H2/H4: both halves of this finding are Slack-derived.
  // ONT-013 D3: drop the placeholder on a truly empty org.
  if (!slackProvided) {
    return orgEmpty
      ? null
      : notEvaluated({
          id: 3,
          title: 'PROCESS GAPS (Slack-only incidents + ticket-less deploys)',
          signal: 'Slack-only incidents and ticket-less deploy threads',
        });
  }

  const ticketlessIncidents = incidents
    .filter((incident) => !incident.hasTrackerIssue)
    .map((incident) => ({
      accountId: incident.leadResponderAccountId,
      who: incident.leadResponder,
      when: incident.date,
      thread_ts: incident.threadTs,
    }));

  const hotfixNoTicket: { thread_ts: string; note: string }[] = [];
  let deployThreadCount = 0;
  const threads = groupThreads({ messages: slack.messages });
  for (const messages of threads.values()) {
    const root = rootOf({ messages });
    if (!DEPLOY_CHANNELS.has(root.channel)) {
      continue;
    }
    if (DEPLOY_INTENT.test(root.text)) {
      deployThreadCount += 1;
    }
    const hasKey = messages.some((m) => ISSUE_KEY.test(m.text));
    if (hasKey || !DEPLOY_INTENT.test(root.text)) {
      continue;
    }
    hotfixNoTicket.push({ thread_ts: root.threadTs, note: root.text.slice(0, 120) });
  }
  hotfixNoTicket.sort((a, b) => a.thread_ts.localeCompare(b.thread_ts));

  void identity;

  // R1: no incidents and no deploy threads -> no evidence, no finding.
  if (incidents.length === 0 && deployThreadCount === 0) {
    return null;
  }

  return {
    id: 3,
    title: 'PROCESS GAPS (Slack-only incidents + ticket-less deploys)',
    detail:
      `${ticketlessIncidents.length} incident thread(s) handled only in Slack (no linked Jira key) ` +
      `and ${hotfixNoTicket.length} deploy thread(s) with no ticket reference. ` +
      'Formula: incidents-channel threads with no COM-key + deploys-channel deploy threads with no COM-key.',
    pointer: { ticketlessIncidents, hotfixNoTicket },
  };
};

/** Approval vacuum: deploy threads with no approval after the approver leaves. */
const approvalVacuumFinding = ({
  slack,
  identity,
  people,
  slackProvided,
  orgEmpty,
}: {
  slack: ParsedSlack;
  identity: SlackIdentity;
  people: Person[];
  slackProvided: boolean;
  orgEmpty: boolean;
}): OrgFinding | null => {
  // H2/H4: entirely Slack deploy-thread derived.
  // ONT-013 D3: drop the placeholder on a truly empty org.
  if (!slackProvided) {
    return orgEmpty
      ? null
      : notEvaluated({
          id: 4,
          title: 'APPROVAL VACUUM (post-departure deploys)',
          signal: 'the post-departure approval vacuum in deploy threads',
        });
  }

  const threads = groupThreads({ messages: slack.messages });
  const deployThreads: { threadTs: string; ts: number; messages: SlackMessage[] }[] = [];

  for (const messages of threads.values()) {
    const root = rootOf({ messages });
    if (!DEPLOY_CHANNELS.has(root.channel)) {
      continue;
    }
    if (!ISSUE_KEY.test(root.text) && !DEPLOY_INTENT.test(root.text)) {
      continue;
    }
    deployThreads.push({
      threadTs: root.threadTs,
      ts: Number.parseFloat(root.threadTs),
      messages,
    });
  }

  // R1: no deploy threads -> no evidence, no finding.
  if (deployThreads.length === 0) {
    return null;
  }

  // The dominant approver = the account that authored the most approval replies.
  const approvalRepliesBy = new Map<string, number>();
  for (const { messages } of deployThreads) {
    const root = rootOf({ messages });
    for (const message of messages) {
      if (message === root || message.userId === root.userId) {
        continue;
      }
      if (APPROVAL.test(message.text)) {
        const account = identity.userToAccount.get(message.userId);
        if (account !== undefined) {
          approvalRepliesBy.set(account, (approvalRepliesBy.get(account) ?? 0) + 1);
        }
      }
    }
  }

  const dominant = [...approvalRepliesBy.entries()].sort(
    (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
  )[0]?.[0];

  // Boundary = the dominant approver's last activity anywhere in the export.
  let boundary = Number.NEGATIVE_INFINITY;
  if (dominant !== undefined) {
    for (const message of slack.messages) {
      if (identity.userToAccount.get(message.userId) === dominant) {
        boundary = Math.max(boundary, Number.parseFloat(message.ts));
      }
    }
  }

  const vacuum = deployThreads
    .filter(({ ts, messages }) => {
      if (ts <= boundary) {
        return false;
      }
      const root = rootOf({ messages });
      const approved = messages.some(
        (m) => m !== root && m.userId !== root.userId && APPROVAL.test(m.text),
      );
      return !approved;
    })
    .sort((a, b) => a.ts - b.ts)
    .map(({ threadTs, messages }) => {
      const root = rootOf({ messages });
      const deployerAccountId = identity.userToAccount.get(root.userId) ?? null;
      return {
        key: firstKey({ text: root.text }),
        thread_ts: threadTs,
        deployerAccountId,
      };
    });

  const nameOf = new Map(people.map((p) => [p.accountId, p.displayName]));

  return {
    id: 4,
    title: 'APPROVAL VACUUM (post-departure deploys)',
    detail:
      `${vacuum.length} deploy(s) shipped with no approval reply after the historical approver ` +
      `(${dominant === undefined ? 'none' : (nameOf.get(dominant) ?? dominant)}) stopped appearing. ` +
      'Formula: deploy threads after the dominant approver last activity with no approval reply.',
    pointer: { dominantApproverAccountId: dominant ?? null, deployVacuumThreads: vacuum },
  };
};

/** Bus factor: per-service distinct-assignee set (low = concentration risk). */
const busFactorFinding = ({ services }: { services: ServiceInstance[] }): OrgFinding | null => {
  // R1: no services -> no evidence, no finding.
  if (services.length === 0) {
    return null;
  }

  return {
    id: 5,
    title: 'BUS FACTOR (per-service ownership)',
    detail:
      'Distinct assignee set per service; a small set concentrates knowledge risk. ' +
      'Formula: count of distinct assignees per Jira component (>=5 issues = meaningful owner).',
    pointer: {
      services: services.map((service) => ({
        id: service.id,
        distinctAssignees: service.distinctAssignees,
        busFactor: service.busFactor,
        assignees: service.assignees,
      })),
    },
  };
};

/** Knowledge flow: help-graph in-degree (who the team leans on). */
const knowledgeFlowFinding = ({
  helpGiven,
  people,
  slackProvided,
  orgEmpty,
}: {
  helpGiven: Map<string, number>;
  people: Person[];
  slackProvided: boolean;
  orgEmpty: boolean;
}): OrgFinding | null => {
  // H2/H4: the help graph is Slack-derived — never a superlative over 0/absent.
  // ONT-013 D3: drop the placeholder on a truly empty org.
  if (!slackProvided) {
    return orgEmpty
      ? null
      : notEvaluated({
          id: 6,
          title: 'KNOWLEDGE FLOW (help hubs)',
          signal: 'help-graph hubs (help interactions)',
        });
  }

  const helpGivenByAccountId: Record<string, number> = {};
  for (const person of people) {
    helpGivenByAccountId[person.accountId] = helpGiven.get(person.accountId) ?? 0;
  }

  const total = Object.values(helpGivenByAccountId).reduce((sum, n) => sum + n, 0);
  const top = Object.entries(helpGivenByAccountId).sort((a, b) => b[1] - a[1])[0];

  // R1: no help interactions at all -> no evidence, no finding.
  if (total === 0) {
    return null;
  }

  return {
    id: 6,
    title: 'KNOWLEDGE FLOW (help hubs)',
    detail:
      `${total} help interactions total; they concentrate on a few hubs (top: ${top?.[0] ?? 'n/a'} = ${top?.[1] ?? 0}). ` +
      'Formula: help-edge out-degree per person (mentions/thanks in another author thread).',
    pointer: { helpGivenByAccountId },
  };
};

/** Compute the full ordered finding set. */
export const computeFindings = ({
  employees,
  services,
  incidents,
  helpGiven,
  slack,
  identity,
  people,
  slackProvided,
}: {
  employees: EmployeeMetric[];
  services: ServiceInstance[];
  incidents: IncidentInstance[];
  helpGiven: Map<string, number>;
  slack: ParsedSlack;
  identity: SlackIdentity;
  people: Person[];
  slackProvided: boolean;
}): OrgFinding[] => {
  // ONT-013 D3: employees are derived from Jira accounts, so 0 recognized
  // issues -> 0 accounts -> 0 employees. On a truly empty org there is nothing
  // to not-evaluate, so the Slack-dependent placeholder findings are dropped.
  const orgEmpty = employees.length === 0;

  return [
    workloadFinding({ employees }),
    invisibleValueFinding({ employees, slackProvided, orgEmpty }),
    processGapFinding({ incidents, slack, identity, slackProvided, orgEmpty }),
    approvalVacuumFinding({ slack, identity, people, slackProvided, orgEmpty }),
    busFactorFinding({ services }),
    knowledgeFlowFinding({ helpGiven, people, slackProvided, orgEmpty }),
  ].filter((finding): finding is OrgFinding => finding !== null);
};
