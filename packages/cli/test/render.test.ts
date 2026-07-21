import type { ApprovalRecord } from 'orangerail-core';
import { describe, expect, it } from 'vitest';

import { previewInput, renderApprovalDetail, renderApprovalList, sanitize } from '../src/render';

/** ESC (U+001B) built at runtime so this source file carries no control bytes. */
const ESC = String.fromCharCode(27);

const record = ({
  id = 'a1',
  requestedBy = 'agent',
  devMode = false,
  input = { note: 'hi' },
}: Partial<ApprovalRecord> = {}): ApprovalRecord => ({
  id,
  actionName: 'publish_document',
  input,
  signatureHash: 'sig',
  status: 'pending',
  requestedBy,
  requestedByRoles: [],
  devMode,
  createdAt: new Date().toISOString(),
});

describe('render — sanitization (approval-deception defense, §3.5)', () => {
  it('strips ANSI escape sequences and control characters', () => {
    const malicious = `${ESC}[31mred${ESC}[0mbell`;
    const out = sanitize({ value: malicious });

    expect(out).not.toContain(ESC);
    expect(out).toContain('red');
  });

  it('neutralizes ANSI embedded in staged input previews', () => {
    const preview = previewInput({ input: { note: `${ESC}[2Jcleared` } });

    expect(preview).not.toContain(ESC);
    expect(preview).toContain('cleared');
  });

  it('caps a long preview to a single short line', () => {
    const preview = previewInput({ input: { note: 'x'.repeat(500) } });

    expect(preview.length).toBeLessThanOrEqual(80);
    expect(preview.endsWith('...')).toBe(true);
  });
});

describe('render — approval list surface (§3.5)', () => {
  it('shows the full id, action, requestedBy, and [dev] marker', () => {
    const out = renderApprovalList({
      approvals: [record({ id: 'abc-123', requestedBy: 'local-dev', devMode: true })],
    });

    expect(out).toContain('abc-123');
    expect(out).toContain('publish_document');
    expect(out).toContain('[dev]');
    expect(out).toContain('1 pending approval(s).');
  });

  it('reports an empty queue plainly', () => {
    expect(renderApprovalList({ approvals: [] })).toBe('No pending approvals.\n');
  });
});

describe('render — approval detail (§3.5)', () => {
  it('keeps the pretty-printed layout newlines in the input block', () => {
    const out = renderApprovalDetail({
      record: record({ input: { documentId: 'doc-1', note: 'ship it' } }),
    });

    const inputBlock = out.slice(out.indexOf('input (agent-supplied):'));
    expect(inputBlock).toContain('\n  "documentId": "doc-1"');
    expect(inputBlock).toContain('\n  "note": "ship it"');
  });

  it('still strips raw C1 controls that JSON.stringify does not escape', () => {
    const csi = String.fromCharCode(0x9b);
    const out = renderApprovalDetail({
      record: record({ input: { note: `${csi}31mforged` } }),
    });

    expect(out).not.toContain(csi);
    expect(out).toContain('forged');
  });
});
