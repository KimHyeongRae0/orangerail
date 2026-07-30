import {
  canonicalJson,
  getShape,
  isNotImplemented,
  isOptionalField,
  type ObjectDefinition,
  type Registry,
  type RuntimeAction,
} from 'orangerail-core';

import { escapeInline, escapeTableCell } from './escape';
import { fieldTypeName } from './field';

/**
 * Runtime preset controlling what the MCP server exposes — the same union
 * `createMcpServer` takes. Re-declared locally because docs-gen must not depend
 * on `orangerail-mcp` (AC-9); the e2e pins the two rails together as set
 * equality against a live server (plan §3.6).
 */
export type DocsPreset = 'readonly' | 'sandbox' | 'approval-for-writes';

/** A tool the MCP server would expose under the active preset (plan §3.6). */
export interface DerivedTool {
  name: string;
  kind: string;
  backing: string;
}

const byName = <T extends { name: string }>(a: T, b: T): number => a.name.localeCompare(b.name);

const sortedObjects = ({ registry }: { registry: Registry }): ObjectDefinition[] =>
  [...registry.listObjects()].sort(byName);

const sortedActions = ({ registry }: { registry: Registry }): RuntimeAction[] =>
  [...registry.listActions()].sort(byName);

/**
 * Re-implement the MCP server's tool-naming convention locally, preset-aware
 * (plan §3.6): `${object.name}_get` for resolve-bearing objects, `_list` when
 * `resolve.list` exists, each action name verbatim plus `check_approval` unless
 * the preset is `readonly`. Output is alphabetical for deterministic rendering;
 * the e2e compares as a SET against the live `tools/list`, so order is free.
 */
export const deriveTools = ({
  registry,
  preset,
}: {
  registry: Registry;
  preset: DocsPreset;
}): DerivedTool[] => {
  const tools: DerivedTool[] = [];

  for (const object of sortedObjects({ registry })) {
    if (!object.resolve) {
      continue;
    }

    tools.push({ name: `${object.name}_get`, kind: 'read (get)', backing: object.name });

    if (object.resolve.list) {
      tools.push({ name: `${object.name}_list`, kind: 'read (list)', backing: object.name });
    }
  }

  if (preset !== 'readonly') {
    for (const action of sortedActions({ registry })) {
      tools.push({ name: action.name, kind: 'action', backing: action.name });
    }

    tools.push({ name: 'check_approval', kind: 'approval-check', backing: '—' });
  }

  return tools;
};

/** Verbatim read-tool names for one object, in the order the server lists them. */
const readToolNames = ({ object }: { object: ObjectDefinition }): string[] => {
  if (!object.resolve) {
    return [];
  }

  const names = [`${object.name}_get`];

  if (object.resolve.list) {
    names.push(`${object.name}_list`);
  }

  return names;
};

/** A three-column markdown field table (name / type / optional) for a schema. */
const fieldTable = ({ schema }: { schema: ObjectDefinition['schema'] }): string[] => {
  const shape = getShape({ schema });
  const fieldNames = Object.keys(shape).sort();

  if (fieldNames.length === 0) {
    return ['_No fields._'];
  }

  const rows = fieldNames.map((fieldName) => {
    const node = shape[fieldName];
    const optional = isOptionalField({ node }) ? 'yes' : 'no';

    return `| ${escapeTableCell({ value: fieldName })} | ${escapeTableCell({ value: fieldTypeName({ node }) })} | ${optional} |`;
  });

  return ['| Field | Type | Optional |', '| --- | --- | --- |', ...rows];
};

/** The MCP tools section — the document's own claim about exposure (§3.4). */
export const renderMcpTools = ({
  registry,
  preset,
}: {
  registry: Registry;
  preset: DocsPreset;
}): string => {
  const tools = deriveTools({ registry, preset });

  const lines: string[] = ['## MCP tools', ''];

  if (tools.length === 0) {
    lines.push('No tools are exposed under the active preset.');
    return lines.join('\n');
  }

  lines.push('| Tool | Kind | Backing entity |', '| --- | --- | --- |');

  for (const tool of tools) {
    lines.push(
      `| \`${escapeTableCell({ value: tool.name })}\` | ${escapeTableCell({ value: tool.kind })} | ${escapeTableCell({ value: tool.backing })} |`,
    );
  }

  lines.push('');

  if (preset === 'readonly') {
    lines.push(
      'Action tools and `check_approval` are not exposed under the readonly preset — only read tools are served.',
    );
  } else if (preset === 'sandbox') {
    lines.push(
      "Under the sandbox preset every action tool records a dry-run and returns `status: 'dry_run'` — no action ever executes and no approval is ever created; `check_approval` is served but has nothing to check.",
    );
  } else {
    // Counted off the registry rather than stated flat (ONT-056). Since `init`
    // stopped gating every write it generates, a blanket "each action tool
    // stages" is a false sentence in the one document an agent reads as
    // instructions — and the failure mode is an agent that calls a `create`
    // expecting an `approvalId`, gets a row instead, and has no reason to
    // believe anything went wrong.
    const actions = sortedActions({ registry });
    const gatedCount = actions.filter((action) => action.policy?.approval === 'required').length;

    if (gatedCount === actions.length) {
      lines.push(
        'Each action tool stages its call for human approval; `check_approval` re-checks a staged approval by id and completes execution once approved.',
      );
    } else if (gatedCount === 0) {
      lines.push(
        'No action tool stages: every action tool executes immediately when it is called. `check_approval` is served but has nothing to check.',
      );
    } else {
      lines.push(
        `${gatedCount} of ${actions.length} action tool(s) stage their call for human approval; the rest execute immediately when called. See **How to act in this domain** below for which is which. \`check_approval\` re-checks a staged approval by id and completes execution once approved.`,
      );
    }
  }

  return lines.join('\n');
};

/** The Object types section — one subsection per object (§3.4). */
export const renderObjectTypes = ({ registry }: { registry: Registry }): string => {
  const objects = sortedObjects({ registry });

  const lines: string[] = ['## Object types', ''];

  if (objects.length === 0) {
    lines.push('No object types are declared.');
    return lines.join('\n');
  }

  for (const object of objects) {
    lines.push(`### ${escapeInline({ value: object.name })}`, '');
    lines.push(...fieldTable({ schema: object.schema }));
    lines.push('');
    lines.push(`- readAccess: ${object.readAccess}`);

    const readTools = readToolNames({ object });
    if (readTools.length === 0) {
      lines.push('- read tools: none — no resolve contract');
    } else {
      lines.push(
        `- read tools: ${readTools.map((name) => `\`${escapeInline({ value: name })}\``).join(', ')}`,
      );
    }

    lines.push('');
  }

  return lines.join('\n').replace(/\n+$/, '');
};

/** The Link types section — a single table, or a coherent empty statement. */
export const renderLinkTypes = ({ registry }: { registry: Registry }): string => {
  const links = [...registry.listLinks()].sort(byName);

  const lines: string[] = ['## Link types', ''];

  if (links.length === 0) {
    lines.push('No link types are declared.');
    return lines.join('\n');
  }

  lines.push('| Link | From | To | Cardinality |', '| --- | --- | --- | --- |');

  for (const link of links) {
    lines.push(
      `| ${escapeTableCell({ value: link.name })} | ${escapeTableCell({ value: link.from.name })} | ${escapeTableCell({ value: link.to.name })} | ${link.cardinality} |`,
    );
  }

  return lines.join('\n');
};

/** The governance block for one action, rendered truthfully (§3.5 / AC-3). */
const governanceLines = ({ action }: { action: RuntimeAction }): string[] => {
  const policy = action.policy;
  const governed = policy?.approval === 'required';

  const lines: string[] = [`- governance: ${governed ? '[approval required]' : '[auto]'}`];

  if (governed) {
    const roles = policy?.roles ?? [];

    if (roles.length > 0) {
      lines.push(`- approvers: ${roles.map((role) => escapeInline({ value: role })).join(', ')}`);
    } else {
      lines.push('- approver: unspecified — any authenticated identity may approve');
    }
  }

  const where = policy?.where;
  if (where !== undefined) {
    if (typeof where === 'function') {
      lines.push(
        '- condition: custom code predicate — evaluated at runtime, not representable here',
      );
    } else {
      lines.push(
        `- condition: only when ${escapeInline({ value: where.field })} ${where.op} ${escapeInline({ value: canonicalJson({ value: where.value }) })}`,
      );
    }
  }

  if (isNotImplemented({ execute: action.execute })) {
    lines.push(
      '- [stub — not implemented] — a call is rejected at staging and audited as `not_implemented`.',
    );
  }

  return lines;
};

/** The Action types section — one subsection per action (§3.4 / §3.5). */
export const renderActionTypes = ({
  registry,
  preset,
}: {
  registry: Registry;
  preset: DocsPreset;
}): string => {
  const actions = sortedActions({ registry });

  const lines: string[] = ['## Action types', ''];

  if (actions.length === 0) {
    lines.push('No action types are declared.');
    return lines.join('\n');
  }

  for (const action of actions) {
    lines.push(`### ${escapeInline({ value: action.name })}`, '');
    lines.push(...fieldTable({ schema: action.input }));
    lines.push('');
    lines.push(`- target: ${action.target ? escapeInline({ value: action.target.name }) : 'none'}`);
    lines.push(...governanceLines({ action }));

    if (preset === 'readonly') {
      lines.push('- [not exposed — readonly preset]');
    }

    lines.push('');
  }

  return lines.join('\n').replace(/\n+$/, '');
};

/**
 * The agent-usage guide — assembled from registry facts AND the preset, never
 * hand-maintained prose (§3.5 / AC-4). It degrades honestly along both axes:
 * the preset selects read-only / dry-run / staging framing, and (in the
 * staging framing) a registry with zero approval-required actions collapses to
 * an "everything executes immediately" statement.
 */
export const renderAgentGuide = ({
  registry,
  preset,
}: {
  registry: Registry;
  preset: DocsPreset;
}): string => {
  const lines: string[] = ['## How to act in this domain', ''];

  if (preset === 'readonly') {
    lines.push(
      "This domain's MCP server is exposed **read-only**. Only read tools are served — there are no action tools and no `check_approval`. Do not attempt to stage, approve, or execute any write action; the server does not expose them. Use the read tools to inspect domain objects.",
    );
    return lines.join('\n');
  }

  if (preset === 'sandbox') {
    lines.push(
      "This domain's MCP server runs in **sandbox (dry-run)** mode. Every action call records a dry-run and returns `status: 'dry_run'` — no action ever executes and no state changes. Sandbox calls never create approvals, so `check_approval` (still served) has nothing to check. Treat every action result as a simulation.",
    );
    return lines.join('\n');
  }

  const approvalActions = sortedActions({ registry }).filter(
    (action) => action.policy?.approval === 'required',
  );

  if (approvalActions.length === 0) {
    lines.push(
      'No action in this domain requires approval — every action executes immediately when its tool is called. There is no staging step; `check_approval` exists only as a no-op re-check surface.',
    );
    return lines.join('\n');
  }

  const names = approvalActions
    .map((action) => `\`${escapeInline({ value: action.name })}\``)
    .join(', ');

  lines.push(
    "Write actions in this domain are governed by human-in-the-loop approval. Calling a governed action tool does not execute it immediately — it STAGES the call: the tool returns `status: 'approval_pending'` with an `approvalId`. A human then approves or rejects it out of band. Re-check the decision by calling `check_approval` with that `approvalId`:",
    '',
    '- while the decision is pending, `check_approval` reports `pending` — keep polling;',
    '- once approved, `check_approval` completes execution and returns the result; a consumed approval stays consumed (re-checking never runs it twice);',
    '- if rejected, the approval is dead — a fresh call must stage a new approval.',
    '',
    `The actions requiring approval are: ${names}. Actions not listed here execute immediately when called.`,
    '',
    'One exception precedes staging entirely: an action whose `execute` is not implemented (a stub) is rejected *before staging* with a `not_implemented` error — the rejection is audited and no approval is ever created, so you will never receive an `approvalId` for it. Treat a `not_implemented` result as "this action does not exist yet", not as a pending decision.',
  );

  return lines.join('\n');
};
