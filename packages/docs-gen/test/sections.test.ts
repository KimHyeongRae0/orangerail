import { createRegistry } from 'orangerail-core';
import { z } from 'zod';
import { describe, expect, it } from 'vitest';

import {
  deriveTools,
  renderActionTypes,
  renderAgentGuide,
  renderLinkTypes,
  renderMcpTools,
  renderObjectTypes,
} from '../src/sections';
import { buildFixtureRegistry, buildReadOnlyRegistry } from './fixture';

describe('deriveTools (plan §3.6 — preset-aware naming)', () => {
  it('derives read + action + check tools under the default preset', () => {
    const names = deriveTools({
      registry: buildFixtureRegistry(),
      preset: 'approval-for-writes',
    }).map((tool) => tool.name);

    expect(new Set(names)).toEqual(
      new Set([
        'product_get',
        'product_list',
        'publish_product',
        'discount_product',
        'touch_counter',
        'sync_catalog',
        'check_approval',
      ]),
    );
  });

  it('drops action tools and check_approval under readonly', () => {
    const names = deriveTools({ registry: buildFixtureRegistry(), preset: 'readonly' }).map(
      (tool) => tool.name,
    );

    expect(new Set(names)).toEqual(new Set(['product_get', 'product_list']));
  });
});

describe('renderMcpTools', () => {
  it('emits a table whose header first cell is exactly "Tool"', () => {
    const out = renderMcpTools({ registry: buildFixtureRegistry(), preset: 'approval-for-writes' });
    expect(out).toContain('| Tool | Kind | Backing entity |');
    expect(out).toContain('| `product_get` |');
  });

  it('states dry-run semantics under sandbox', () => {
    const out = renderMcpTools({ registry: buildFixtureRegistry(), preset: 'sandbox' });
    expect(out).toContain("status: 'dry_run'");
    expect(out).toContain('no approval is ever created');
  });
});

describe('renderObjectTypes', () => {
  const out = renderObjectTypes({ registry: buildFixtureRegistry() });

  it('renders verbatim read-tool names for a resolve-bearing object', () => {
    expect(out).toContain('- read tools: `product_get`, `product_list`');
  });

  it('states no read tools for a resolve-less object', () => {
    expect(out).toContain('- read tools: none — no resolve contract');
  });

  it('marks optional fields in the field table', () => {
    expect(out).toContain('| price | number | yes |');
    expect(out).toContain('| id | string | no |');
  });
});

describe('renderLinkTypes', () => {
  it('renders the link table', () => {
    const out = renderLinkTypes({ registry: buildFixtureRegistry() });
    expect(out).toContain('| product_notes | product | internal_note | many |');
  });

  it('degrades coherently with zero links (no dangling table)', () => {
    const out = renderLinkTypes({ registry: buildReadOnlyRegistry() });
    expect(out).toContain('No link types are declared.');
    expect(out).not.toContain('| Link |');
  });
});

describe('renderActionTypes — truthful governance (AC-3)', () => {
  const out = renderActionTypes({
    registry: buildFixtureRegistry(),
    preset: 'approval-for-writes',
  });

  it('renders approval + roles + declarative where', () => {
    expect(out).toContain('- governance: [approval required]');
    expect(out).toContain('- approvers: editor');
    expect(out).toContain('- condition: only when status eq "draft"');
  });

  it('renders the approver-unspecified badge and a functional-where marker', () => {
    expect(out).toContain('- approver: unspecified — any authenticated identity may approve');
    expect(out).toContain(
      '- condition: custom code predicate — evaluated at runtime, not representable here',
    );
  });

  it('renders [auto] and the not-implemented stub badge', () => {
    expect(out).toContain('- governance: [auto]');
    expect(out).toContain('- [stub — not implemented]');
  });

  it('marks each action not exposed under readonly', () => {
    const readonly = renderActionTypes({ registry: buildFixtureRegistry(), preset: 'readonly' });
    const markers = readonly.match(/\[not exposed — readonly preset\]/g) ?? [];
    expect(markers.length).toBe(4);
  });

  it('degrades coherently with zero actions', () => {
    const out = renderActionTypes({
      registry: buildReadOnlyRegistry(),
      preset: 'approval-for-writes',
    });
    expect(out).toContain('No action types are declared.');
  });
});

describe('markdown-body injection resistance (AC-7)', () => {
  const buildHostileRegistry = () => {
    const registry = createRegistry();

    registry.defineObject({
      name: 'evil\n# INJECTED HEADING\n<script>alert(1)</script>',
      schema: z.object({ id: z.string() }),
    });

    registry.defineAction({
      name: 'evil_action\n## INJECTED SECTION',
      input: z.object({ x: z.string() }),
      policy: { approval: 'required', roles: ['role\n# INJECTED ROLE'] },
      execute: async () => ({ ok: true }),
    });

    return registry;
  };

  it('a hostile object name cannot inject a heading or raw HTML', () => {
    const out = renderObjectTypes({ registry: buildHostileRegistry() });

    expect(out).not.toMatch(/^# INJECTED HEADING/m);
    expect(out).not.toContain('<script>');
    expect(out).toContain('&lt;script&gt;');
  });

  it('hostile action and role names cannot inject headings', () => {
    const out = renderActionTypes({
      registry: buildHostileRegistry(),
      preset: 'approval-for-writes',
    });

    expect(out).not.toMatch(/^## INJECTED SECTION/m);
    expect(out).not.toMatch(/^# INJECTED ROLE/m);
    expect(out).toContain('- approvers: role # INJECTED ROLE');
  });
});

describe('renderAgentGuide — preset + registry degradation (AC-4 / §3.5)', () => {
  it('default preset teaches the staging lifecycle and names approval-required actions', () => {
    const out = renderAgentGuide({
      registry: buildFixtureRegistry(),
      preset: 'approval-for-writes',
    });
    expect(out).toContain('approval_pending');
    expect(out).toContain('approvalId');
    expect(out).toContain('check_approval');
    expect(out).toContain('consumed');
    expect(out).toContain('`discount_product`, `publish_product`');
  });

  it('readonly preset renders a read-only guide', () => {
    const out = renderAgentGuide({ registry: buildFixtureRegistry(), preset: 'readonly' });
    expect(out).toContain('read-only');
    expect(out).toContain('no `check_approval`');
  });

  it('sandbox preset replaces staging with a dry-run guide', () => {
    const out = renderAgentGuide({ registry: buildFixtureRegistry(), preset: 'sandbox' });
    expect(out).toContain("status: 'dry_run'");
    expect(out).toContain('never create approvals');
    expect(out).not.toContain('approval_pending');
  });

  it('degrades to "executes immediately" when no action requires approval', () => {
    const registry = createRegistry();
    registry.defineAction({
      name: 'ping',
      input: z.object({ x: z.string() }),
      execute: async () => ({ ok: true }),
    });

    const out = renderAgentGuide({ registry, preset: 'approval-for-writes' });
    expect(out).toContain('every action executes immediately');
    expect(out).not.toContain('approval_pending');
  });
});
