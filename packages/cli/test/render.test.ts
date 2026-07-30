import type { ApprovalRecord, AuditPrior } from 'orangerail-core';
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

describe('render — the target block on the approver screen (§3.11 / ONT-057)', () => {
  it('shows the current row above the input, so a stock change has two sides', () => {
    const out = renderApprovalDetail({
      record: record({ input: { id: 'p3', stock: 25 } }),
      prior: { state: 'value', value: { id: 'p3', stock: 0 } },
    });

    expect(out.indexOf('target (current state, read now):')).toBeLessThan(
      out.indexOf('input (agent-supplied):'),
    );
    expect(out).toContain('"stock": 0');
    expect(out).toContain('"stock": 25');
  });

  it('names each non-value state instead of printing an empty block', () => {
    const cases: { prior: AuditPrior; expected: string }[] = [
      { prior: { state: 'none' }, expected: 'NONE' },
      { prior: { state: 'withheld' }, expected: 'WITHHELD' },
      { prior: { state: 'unavailable', reason: 'no_target' }, expected: 'no target object' },
      { prior: { state: 'unavailable', reason: 'no_id' }, expected: 'no value at the target id' },
      { prior: { state: 'unreadable', error: 'boom' }, expected: 'COULD NOT READ' },
    ];

    for (const entry of cases) {
      expect(renderApprovalDetail({ record: record(), prior: entry.prior })).toContain(
        entry.expected,
      );
    }
  });

  it('omits the block entirely when no prior was resolved', () => {
    expect(renderApprovalDetail({ record: record() })).not.toContain('target (current state');
  });

  it('sanitizes a datasource error before it reaches the terminal', () => {
    const out = renderApprovalDetail({
      record: record(),
      prior: { state: 'unreadable', error: `${ESC}[31mrelation "users" does not exist` },
    });

    expect(out).not.toContain(ESC);
    expect(out).toContain('relation');
  });
});

/**
 * The full bidi / invisible-formatting set render.ts neutralizes. Built from
 * code points at runtime so this source file stays plain ASCII: a literal
 * U+202E here would reverse the rendering of the test file itself.
 */
const INVISIBLE_CODE_POINTS = [
  0x00ad, // soft hyphen
  0x061c, // Arabic letter mark
  0x180e, // Mongolian vowel separator
  0x200b, // zero-width space
  0x200c, // zero-width non-joiner
  0x200d, // zero-width joiner
  0x200e, // left-to-right mark
  0x200f, // right-to-left mark
  0x202a, // left-to-right embedding
  0x202b, // right-to-left embedding
  0x202c, // pop directional formatting
  0x202d, // left-to-right override
  0x202e, // RIGHT-TO-LEFT OVERRIDE - the Trojan Source lead
  0x2028, // line separator
  0x2029, // paragraph separator
  0x2060, // word joiner
  0x2066, // left-to-right isolate
  0x2067, // right-to-left isolate
  0x2068, // first strong isolate
  0x2069, // pop directional isolate
  0x206f, // nominal digit shapes (deprecated format control)
  0xfeff, // zero-width no-break space / BOM
  0xfff9, // interlinear annotation anchor
  0xe0041, // TAG LATIN CAPITAL LETTER A (ASCII-smuggling block)
];

/** U+202E, never written literally. */
const RLO = String.fromCodePoint(0x202e);

describe('render - bidi and invisible formatting (Trojan Source, ONT-044 F)', () => {
  it('escapes U+202E in requestedBy rather than letting it reverse the line', () => {
    const out = renderApprovalList({
      approvals: [record({ requestedBy: `agent${RLO}gnitset-efas` })],
    });

    expect(out).not.toContain(RLO);
    expect(out).toContain('\\u202e');
    expect(out).toContain('agent');
  });

  it('escapes U+202E inside a staged input preview', () => {
    const out = previewInput({ input: { status: `${RLO}sredro ELBAT PORD` } });

    expect(out).not.toContain(RLO);
    expect(out).toContain('\\u202e');
  });

  it('escapes U+202E in the approval detail input block', () => {
    const out = renderApprovalDetail({ record: record({ input: { status: `${RLO}x` } }) });

    expect(out).not.toContain(RLO);
    expect(out).toContain('\\u202e');
  });

  it('lets no code point from the neutralized set reach the terminal', () => {
    for (const codePoint of INVISIBLE_CODE_POINTS) {
      const raw = String.fromCodePoint(codePoint);
      const surfaces = [
        sanitize({ value: `a${raw}b` }),
        previewInput({ input: { note: `a${raw}b` } }),
        renderApprovalDetail({
          record: record({ requestedBy: `a${raw}b`, input: { note: `a${raw}b` } }),
        }),
      ];

      for (const surface of surfaces) {
        expect(surface, `U+${codePoint.toString(16)} survived`).not.toContain(raw);
      }
    }
  });

  it('ESCAPES rather than deletes, so the operator sees something unusual is there', () => {
    const out = sanitize({ value: `safe${RLO}` });

    // A silent delete would render the hostile string as the innocent one.
    expect(out).not.toBe('"safe"');
    expect(out).toBe('"safe\\u202e"');
  });

  it('escapes an astral TAG character as a surrogate pair, keeping output ASCII', () => {
    const out = sanitize({ value: `a${String.fromCodePoint(0xe0041)}b` });

    expect(out).toBe('"a\\udb40\\udc41b"');
    expect(/^[\x00-\x7f]*$/.test(out)).toBe(true);
  });

  it('leaves ordinary non-ASCII text alone', () => {
    expect(sanitize({ value: 'caf\u00e9 \u2014 ok' })).toBe('"caf\u00e9 \u2014 ok"');
  });

  it('still caps the preview at 80 chars after escaping', () => {
    const preview = previewInput({ input: { note: RLO.repeat(200) } });

    expect(preview.length).toBeLessThanOrEqual(80);
    expect(preview).not.toContain(RLO);
  });
});

describe('render - approval detail input cap (ONT-044 G)', () => {
  const flood = () => record({ id: 'e2be42b8-cafe', input: { status: 'A'.repeat(1024 * 1024) } });

  it('keeps a 1 MB input from scrolling the decision context off-screen', () => {
    const out = renderApprovalDetail({ record: flood() });

    // A 1 MB value is ONE logical line; what buries the header is the ~13,000
    // lines the terminal wraps it into. So the character count is the assertion
    // that matters here, and the line count is checked alongside it.
    expect(out.length).toBeLessThan(4000);
    expect(out.split('\n').length).toBeLessThan(60);
    expect(out).toContain('id:           e2be42b8-cafe');
    expect(out).toContain('action:       "publish_document"');
    expect(out).toContain('status:       pending');
  });

  it('states the truncation with exact counts and warns it is not the whole value', () => {
    const out = renderApprovalDetail({ record: flood() });

    expect(out).toContain('TRUNCATED');
    expect(out).toMatch(/showing \d+ of \d+ character\(s\), \d+ of \d+ line\(s\)/);
    expect(out).toContain('NOT the whole input');
  });

  it('names the command that prints the value in full', () => {
    expect(renderApprovalDetail({ record: flood() })).toContain(
      'orangerail approvals show e2be42b8-cafe --full',
    );
  });

  it('prints everything under --full', () => {
    const out = renderApprovalDetail({ record: flood(), full: true });

    expect(out).not.toContain('TRUNCATED');
    expect(out.length).toBeGreaterThan(1024 * 1024);
  });

  it('caps on line count too, not only on characters', () => {
    const wide = Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`k${i}`, i]));
    const out = renderApprovalDetail({ record: record({ input: wide }) });

    expect(out).toContain('TRUNCATED');
    expect(out.split('\n').length).toBeLessThan(60);
  });

  it('leaves a small input untouched, with no truncation notice', () => {
    const out = renderApprovalDetail({ record: record({ input: { documentId: 'doc-1' } }) });

    expect(out).not.toContain('TRUNCATED');
    expect(out).toContain('"documentId": "doc-1"');
  });
});
