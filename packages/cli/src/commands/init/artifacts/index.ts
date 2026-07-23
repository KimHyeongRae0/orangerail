import { readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';

import { specifiersResolvable, smokeLoadStaged, writeFileSet } from '../atomic';
import { extractCandidates } from './candidates';
import { emitArtifacts } from './emit';
import { computeFindings } from './findings';
import { computeGraph } from './graph';
import { parseJira } from './jira';
import { computeMetrics } from './metrics';
import { parseSlack, resolveSlackIdentity } from './slack';
import type { ExtractedOntology, ParsedSlack, Person } from './types';

/**
 * Orchestrator for the flag-driven human-source scan path (plan Step 10):
 * parse -> metrics -> graph -> candidates -> findings -> emit config+data+report
 * -> reuse the atomic stage/smoke-load/write from the type-level path. Reads
 * only the explicitly-passed export files (never auto-detected), computes
 * everything from a uniform algorithm, and writes a byte-deterministic file set.
 */

/** Read + JSON-parse an export file resolved against the target repo. */
const readExport = ({ cwd, path }: { cwd: string; path: string }): unknown => {
  const absolute = isAbsolute(path) ? path : resolve(cwd, path);
  return JSON.parse(readFileSync(absolute, 'utf8'));
};

const emptySlack = (): ParsedSlack => ({ users: new Map(), messages: [], diagnostics: [] });

/** Build the extracted ontology from the parsed exports (pure, testable). */
export const buildOntology = ({
  jiraRaw,
  slackRaw,
}: {
  jiraRaw: unknown;
  slackRaw: unknown | undefined;
}): { ontology: ExtractedOntology; diagnostics: string[]; recognizedIssueCount: number } => {
  const jira = parseJira({ raw: jiraRaw });

  // The single honest signal: a Slack export was PROVIDED (not a message count).
  // `emptySlack()` produces a byte-identical shape to a provided-but-empty
  // export, so the provided-vs-absent fact must be captured here, before it is
  // lost, and threaded explicitly into every downstream layer.
  const slackProvided = slackRaw !== undefined;
  const slack = slackProvided ? parseSlack({ raw: slackRaw }) : emptySlack();

  const people: Person[] = [...jira.accounts.entries()]
    .map(([accountId, displayName]) => ({ accountId, displayName }))
    .sort((a, b) => a.accountId.localeCompare(b.accountId));

  const identity = resolveSlackIdentity({ slack, jiraAccounts: jira.accounts });

  const employees = computeMetrics({ jira, slack, identity, people });
  const graph = computeGraph({ jira, slack, identity, people });

  // H1: help metrics are Slack-derived. With no Slack export they are honestly
  // "unavailable" (the exact ONT-010 representation for missing-history
  // metrics), never a silent 0 that reads as "helps nobody".
  for (const employee of employees) {
    employee.helpGiven = slackProvided
      ? (graph.helpGiven.get(employee.accountId) ?? 0)
      : 'unavailable';
    employee.helpReceived = slackProvided
      ? (graph.helpReceived.get(employee.accountId) ?? 0)
      : 'unavailable';
  }

  const candidates = extractCandidates({ slack, identity });

  const findings = computeFindings({
    employees,
    services: graph.services,
    incidents: graph.incidents,
    helpGiven: graph.helpGiven,
    slack,
    identity,
    people,
    slackProvided,
  });

  const deployGateEvidenced = candidates.some((candidate) => candidate.kind === 'approval');

  const ontology: ExtractedOntology = {
    employees,
    team: graph.team,
    services: graph.services,
    incidents: graph.incidents,
    memberOf: graph.memberOf,
    worksOn: graph.worksOn,
    helps: graph.helps,
    candidates,
    findings,
    deployGateEvidenced,
    slackProvided,
  };

  const diagnostics = [...jira.diagnostics, ...slack.diagnostics, ...identity.diagnostics];

  // ONT-013 D3: the count of recognized Jira issues (never serialized). It is
  // 0 for every degenerate export shape (`[]`, `{}`, `{issues:{}}`, `{issues:[]}`)
  // but > 0 for a valid-but-all-unassigned export, so it is the correct signal
  // for "nothing was recognized" without false-positiving on an unassigned org.
  return { ontology, diagnostics, recognizedIssueCount: jira.issues.length };
};

/** Run the artifact-scan init path and write the generated file set in place. */
export const runInitFromArtifacts = async ({
  cwd,
  fromJira,
  fromSlack,
}: {
  cwd: string;
  fromJira: string;
  fromSlack?: string | undefined;
}): Promise<number> => {
  let jiraRaw: unknown;
  let slackRaw: unknown | undefined;

  try {
    jiraRaw = readExport({ cwd, path: fromJira });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`orangerail init: could not read --from-jira export: ${message}\n`);
    return 1;
  }

  if (fromSlack !== undefined) {
    try {
      slackRaw = readExport({ cwd, path: fromSlack });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`orangerail init: could not read --from-slack export: ${message}\n`);
      return 1;
    }
  }

  const { ontology, diagnostics, recognizedIssueCount } = buildOntology({ jiraRaw, slackRaw });

  for (const diagnostic of diagnostics) {
    process.stderr.write(`orangerail init: ${diagnostic}\n`);
  }

  const files = emitArtifacts({ ontology });

  if (specifiersResolvable({ cwd })) {
    await smokeLoadStaged({ files, cwd });
  }

  writeFileSet({ files, baseDir: cwd });

  // ONT-013 D3: an empty/wrong-shaped export that recognizes zero issues must
  // not report cheerful success. The files are still written and the exit code
  // stays 0 (the export was read; this is a data-quality warning, not a read
  // error), but the "extracted N ..." summary is suppressed in favor of an
  // honest "no issues recognized" warning naming the path (AC-4).
  if (recognizedIssueCount === 0) {
    process.stderr.write(`orangerail init: no issues recognized in ${fromJira}\n`);
    return 0;
  }

  // H3: the summary names only the sources actually read.
  const sources = ontology.slackProvided ? 'the Jira and Slack exports' : 'the Jira export';

  process.stdout.write(
    `orangerail init: extracted ${ontology.employees.length} employee(s), ` +
      `${ontology.services.length} service(s), and ${ontology.findings.length} finding(s) ` +
      `from ${sources}.\n` +
      'These files are yours — review ANALYTICS.md, then run `orangerail mcp` or `orangerail studio`.\n',
  );

  return 0;
};
