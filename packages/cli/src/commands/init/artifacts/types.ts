/**
 * Instance/metric shapes for the human-source (Jira/Slack) scanner (plan Step
 * 1). These are deliberately distinct from the type-level `ir.ts`: the
 * Prisma/OpenAPI IR models object/action *types*, whereas this scanner emits
 * concrete org *instances* (people, teams, services) plus per-person structural
 * metrics — a concept the type-level IR cannot carry. Everything here is pure
 * data derived mechanically from the exports; no field is a verdict.
 */

/** A person identity, keyed by Jira accountId (the merge key — never a name). */
export interface Person {
  accountId: string;
  displayName: string;
}

/** One normalized Jira issue, stripped to the fields the metrics need. */
export interface JiraIssue {
  key: string;
  issuetype: string;
  summary: string;
  status: string;
  assigneeId: string | null;
  assigneeName: string | null;
  reporterId: string | null;
  reporterName: string | null;
  storyPoints: number | null;
  components: string[];
  labels: string[];
  created: string | null;
  resolutiondate: string | null;
  /** `toString` of every changelog `status` transition (for reopen counting). */
  statusTransitions: string[];
  /** Every changelog `assignee` change as from/to accountIds. */
  assigneeChanges: { from: string | null; to: string | null }[];
}

/** The parsed Jira export plus derived identity and diagnostics. */
export interface ParsedJira {
  projectKey: string;
  projectName: string;
  issues: JiraIssue[];
  /** accountId -> displayName for every account seen as assignee or reporter. */
  accounts: Map<string, string>;
  /**
   * Whether the export carries changelog history at all. When false, reopen /
   * reassignment metrics are reported as `"unavailable"`, never a silent 0.
   */
  changelogAvailable: boolean;
  /**
   * Whether any issue in the export carries a numeric story-point value. When
   * false, the complexity mix degrades to a single `lo` bucket rather than
   * fabricating a hi/med/lo spread from issue type (consistent with a
   * story-point total of 0).
   */
  storyPointsAvailable: boolean;
  diagnostics: string[];
}

/** One normalized Slack message. */
export interface SlackMessage {
  channel: string;
  ts: string;
  userId: string;
  text: string;
  threadTs: string;
}

/** The parsed Slack export plus its user listing. */
export interface ParsedSlack {
  /** Slack userId -> { real_name, is_bot }. */
  users: Map<string, { realName: string; isBot: boolean }>;
  messages: SlackMessage[];
  diagnostics: string[];
}

/** Resolved Slack->Jira identity: which Slack userIds map to which accountId. */
export interface SlackIdentity {
  /** Slack userId -> Jira accountId (only for users matched by real_name). */
  userToAccount: Map<string, string>;
  diagnostics: string[];
}

/** A metric that is `"unavailable"` when the source lacks the history it needs. */
export type MetricOrUnavailable = number | 'unavailable';

/** Per-employee structural metrics (layer 1: field math only). */
export interface EmployeeMetric {
  accountId: string;
  displayName: string;
  active: boolean;
  ticketCount: number;
  storyPointsTotal: number;
  complexityMix: { hi: number; med: number; lo: number };
  medianCycleDaysFirstHalf: number;
  medianCycleDaysSecondHalf: number;
  reopenRate: MetricOrUnavailable;
  reassignmentsGiven: MetricOrUnavailable;
  reassignmentsReceived: MetricOrUnavailable;
  helpGiven: MetricOrUnavailable;
  helpReceived: MetricOrUnavailable;
  weekendOffHoursShare: number;
}

/** A weighted edge between two nodes, keyed by id (accountId / service / team). */
export interface Edge {
  from: string;
  to: string;
  weight: number;
}

/** A service instance derived from Jira components, with its bus-factor set. */
export interface ServiceInstance {
  id: string;
  name: string;
  ticketCount: number;
  distinctAssignees: number;
  busFactor: number;
  assignees: { accountId: string; displayName: string; count: number }[];
}

/** The single team instance derived from the Jira project. */
export interface TeamInstance {
  id: string;
  name: string;
  project: string;
}

/** A chat-only incident reconstructed from an incidents-channel thread. */
export interface IncidentInstance {
  id: string;
  date: string;
  channel: string;
  threadTs: string;
  leadResponderAccountId: string;
  leadResponder: string;
  hasTrackerIssue: boolean;
  participantAccountIds: string[];
}

/**
 * A layer-2 lexical candidate: an evidence-linked record carrying the matched
 * span and a source pointer. It is NEVER a verdict about a person — it has no
 * boolean/score field. A message matching no pattern yields no candidate.
 */
export interface Candidate {
  kind: 'approval' | 'reassign' | 'thanks';
  authorAccountId: string | null;
  matchedSpan: string;
  source: { channel: string; ts: string };
}

/** An org finding: a direct computation carrying its evidence pointer(s). */
export interface OrgFinding {
  id: number;
  title: string;
  detail: string;
  pointer: unknown;
}

/** The complete extracted org ontology, ready for emission. */
export interface ExtractedOntology {
  employees: EmployeeMetric[];
  team: TeamInstance;
  services: ServiceInstance[];
  incidents: IncidentInstance[];
  memberOf: Edge[];
  worksOn: Edge[];
  helps: Edge[];
  candidates: Candidate[];
  findings: OrgFinding[];
  deployGateEvidenced: boolean;
  /**
   * Whether a Slack export was provided to this run (the single honest signal:
   * `slackRaw !== undefined`, not a message count). Drives how Slack-derived
   * metrics/findings and the report header are rendered. Never serialized into
   * `data/*.json` — the emitter serializes ontology fields one by one.
   */
  slackProvided: boolean;
}
