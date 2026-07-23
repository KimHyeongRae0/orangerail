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
}): { ontology: ExtractedOntology; diagnostics: string[] } => {
  const jira = parseJira({ raw: jiraRaw });
  const slack = slackRaw === undefined ? emptySlack() : parseSlack({ raw: slackRaw });

  const people: Person[] = [...jira.accounts.entries()]
    .map(([accountId, displayName]) => ({ accountId, displayName }))
    .sort((a, b) => a.accountId.localeCompare(b.accountId));

  const identity = resolveSlackIdentity({ slack, jiraAccounts: jira.accounts });

  const employees = computeMetrics({ jira, slack, identity, people });
  const graph = computeGraph({ jira, slack, identity, people });

  for (const employee of employees) {
    employee.helpGiven = graph.helpGiven.get(employee.accountId) ?? 0;
    employee.helpReceived = graph.helpReceived.get(employee.accountId) ?? 0;
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
  };

  const diagnostics = [...jira.diagnostics, ...slack.diagnostics, ...identity.diagnostics];

  return { ontology, diagnostics };
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

  const { ontology, diagnostics } = buildOntology({ jiraRaw, slackRaw });

  for (const diagnostic of diagnostics) {
    process.stderr.write(`orangerail init: ${diagnostic}\n`);
  }

  const files = emitArtifacts({ ontology });

  if (specifiersResolvable({ cwd })) {
    await smokeLoadStaged({ files, cwd });
  }

  writeFileSet({ files, baseDir: cwd });

  process.stdout.write(
    `orangerail init: extracted ${ontology.employees.length} employee(s), ` +
      `${ontology.services.length} service(s), and ${ontology.findings.length} finding(s) ` +
      'from the Jira/Slack export(s).\n' +
      'These files are yours — review ANALYTICS.md, then run `orangerail mcp` or `orangerail studio`.\n',
  );

  return 0;
};
