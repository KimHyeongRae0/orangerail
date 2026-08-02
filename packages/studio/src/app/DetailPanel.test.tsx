// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import type { InstanceEmployee } from '../snapshot/instances';
import { PersonScorecard } from './DetailPanel';

const HOSTILE = '<img src=x onerror="window.__ont_score_xss=1">Zed';

/**
 * The marker `/api/instances` serves for a field whose value is `undefined`
 * (`packages/cli/src/render.ts:102,191`). Spelled out here rather than derived,
 * so a change to either surface's wording fails on this line instead of leaving
 * a reader with two vocabularies for one fact (AC-4).
 */
const MISSING_MARKER = '<UNRENDERABLE — undefined, which JSON drops key and all>';

const employee = ({ displayName = 'Felix Braun' }: { displayName?: string }): InstanceEmployee => ({
  accountId: 'acc_felix',
  displayName,
  active: true,
  ticketCount: 20,
  storyPointsTotal: 53,
  complexityMix: { hi: 2, med: 5, lo: 13 },
  medianCycleDaysFirstHalf: 3,
  medianCycleDaysSecondHalf: 2,
  reopenRate: 'unavailable',
  reassignmentsGiven: 1,
  reassignmentsReceived: 0,
  helpGiven: 12,
  helpReceived: 4,
  weekendOffHoursShare: 8,
});

/**
 * A row the datasource returned, cast into the type it was declared to have.
 * That cast is exactly what happens on the wire — `defineObject` stores the
 * schema and never parses `resolve` output with it
 * (`packages/core/src/define/object.ts:31-38`) — so these fixtures are rows the
 * app really can receive, not hypotheticals.
 */
const nonconforming = ({ row }: { row: Record<string, unknown> }): InstanceEmployee =>
  row as unknown as InstanceEmployee;

/** The conforming row minus the named keys — the shape ONT-072 was reported on. */
const without = ({ keys }: { keys: string[] }): InstanceEmployee => {
  const row: Record<string, unknown> = { ...employee({}) };

  for (const key of keys) {
    delete row[key];
  }

  return nonconforming({ row });
};

/** The conforming row with one field replaced by a value it was never declared to hold. */
const withField = ({ key, value }: { key: string; value: unknown }): InstanceEmployee =>
  nonconforming({ row: { ...employee({}), [key]: value } });

const scorecardOf = ({ container }: { container: HTMLElement }): HTMLElement => {
  const panel = container.querySelector<HTMLElement>('[data-testid="scorecard"]');

  if (panel === null) {
    throw new Error('the scorecard did not render at all');
  }

  return panel;
};

/** The value cell of the row whose label starts with `label`. */
const valueOf = ({ container, label }: { container: HTMLElement; label: string }): string => {
  const row = Array.from(scorecardOf({ container }).querySelectorAll('div')).find((candidate) =>
    (candidate.firstElementChild?.textContent ?? '').startsWith(label),
  );

  return row?.lastElementChild?.textContent ?? '';
};

afterEach(cleanup);

describe('PersonScorecard (plan section 3.3 — honesty contract, AC-3)', () => {
  it('shows the metric labels and value, no ranking / composite score', () => {
    const { container } = render(<PersonScorecard employee={employee({})} onClose={() => {}} />);

    const panel = container.querySelector('[data-testid="scorecard"]');
    const text = panel?.textContent ?? '';

    expect(text).toContain('Felix Braun');
    expect(/story points/i.test(text)).toBe(true);
    expect(/help given/i.test(text)).toBe(true);
    expect(/reopen/i.test(text)).toBe(true);

    expect(container.querySelectorAll('[data-testid="rank"]').length).toBe(0);
    expect(/overall score|composite score|rank #\d/i.test(text)).toBe(false);
  });

  it('renders the literal "unavailable" verbatim, never 0 or blank', () => {
    const { container } = render(<PersonScorecard employee={employee({})} onClose={() => {}} />);

    expect(container.textContent).toContain('unavailable');
  });

  it('renders a hostile displayName as inert text', () => {
    const { container } = render(
      <PersonScorecard employee={employee({ displayName: HOSTILE })} onClose={() => {}} />,
    );

    expect(container.querySelectorAll('img').length).toBe(0);
    expect((window as unknown as { __ont_score_xss?: number }).__ont_score_xss).toBeUndefined();
    expect(container.textContent).toContain('onerror');
  });
});

/**
 * The markup a fully conforming row produced before ONT-072, captured from the
 * shipped component at `487e846` and asserted verbatim (AC-5). The CSS-module
 * hash suffix is stripped first: it is a bundler artifact of
 * `DetailPanel.module.css`, not output of this component, and pinning it would
 * make an unrelated stylesheet edit fail here for the wrong reason.
 */
const GOLDEN_CONFORMING_HTML =
  '<aside class="_panel" data-testid="scorecard"><div class="_header"><span class="_title" title="Felix Braun">Felix Braun</span><button type="button" class="_close" data-testid="scorecard-close" aria-label="Close scorecard">×</button></div><section class="_section"><h3 class="_sectionTitle">Evidence metrics</h3><div class="_row"><span class="_rowKey" title="Assigned issues in the export window.">Ticket count</span><span class="_rowValue">20</span></div><div class="_row"><span class="_rowKey" title="Sum of story points across assigned issues.">Story points</span><span class="_rowValue">53</span></div><div class="_row"><span class="_rowKey" title="Assigned issues bucketed by story points.">Complexity mix (hi/med/lo)</span><span class="_rowValue">2 / 5 / 13</span></div><div class="_row"><span class="_rowKey" title="Median created-to-resolved days, first half of the window.">Median cycle days (first half)</span><span class="_rowValue">3</span></div><div class="_row"><span class="_rowKey" title="Median created-to-resolved days, second half of the window.">Median cycle days (second half)</span><span class="_rowValue">2</span></div><div class="_row"><span class="_rowKey" title="Percent of assigned issues with a reopen transition.">Reopen rate</span><span class="_rowValue">unavailable</span></div><div class="_row"><span class="_rowKey" title="Issues this person reassigned away.">Reassignments given</span><span class="_rowValue">1</span></div><div class="_row"><span class="_rowKey" title="Issues reassigned onto this person.">Reassignments received</span><span class="_rowValue">0</span></div><div class="_row"><span class="_rowKey" title="Out-degree in the Slack help graph.">Help given</span><span class="_rowValue">12</span></div><div class="_row"><span class="_rowKey" title="In-degree in the Slack help graph.">Help received</span><span class="_rowValue">4</span></div><div class="_row"><span class="_rowKey" title="Percent of activity outside standard hours.">Weekend / off-hours share</span><span class="_rowValue">8</span></div></section></aside>';

/** Drop the CSS-module content hash so the golden pins markup, not a bundler id. */
const withoutModuleHash = ({ html }: { html: string }): string =>
  html.replace(/(_[A-Za-z][A-Za-z0-9]*)_[0-9a-f]{6}\b/g, '$1');

describe('PersonScorecard — a row that does not match its declared shape (ONT-072)', () => {
  it('AC-5: a fully conforming row renders byte-identically to before the fix', () => {
    const { container } = render(<PersonScorecard employee={employee({})} onClose={() => {}} />);

    expect(withoutModuleHash({ html: container.innerHTML })).toBe(GOLDEN_CONFORMING_HTML);
  });

  it('AC-1: a row without complexityMix names that metric and keeps every other one', () => {
    const { container } = render(
      <PersonScorecard employee={without({ keys: ['complexityMix'] })} onClose={() => {}} />,
    );

    expect(valueOf({ container, label: 'Complexity mix' })).toBe(MISSING_MARKER);

    // The siblings are untouched: a named absence must not take the rest of the
    // panel with it, which is the whole difference from the defect.
    expect(valueOf({ container, label: 'Ticket count' })).toBe('20');
    expect(valueOf({ container, label: 'Story points' })).toBe('53');
    expect(valueOf({ container, label: 'Help given' })).toBe('12');
    expect(valueOf({ container, label: 'Reopen rate' })).toBe('unavailable');
  });

  it('AC-4: the marker is exactly what /api/instances serves for the same field', () => {
    const { container } = render(
      <PersonScorecard employee={without({ keys: ['complexityMix'] })} onClose={() => {}} />,
    );

    const cell = scorecardOf({ container }).querySelector('[data-unrenderable="true"]');

    expect(cell?.textContent).toBe(MISSING_MARKER);
  });

  it('names the field when complexityMix carries only one of hi / med / lo', () => {
    const { container } = render(
      <PersonScorecard
        employee={withField({ key: 'complexityMix', value: { hi: 1 } })}
        onClose={() => {}}
      />,
    );

    expect(valueOf({ container, label: 'Complexity mix' })).toBe(
      '<UNRENDERABLE — its med is undefined, which JSON drops key and all>',
    );
    expect(valueOf({ container, label: 'Ticket count' })).toBe('20');
  });

  it('names the field when complexityMix is not an object at all', () => {
    const cases = [
      {
        value: 'lots',
        expected:
          '<UNRENDERABLE — a string ("lots") where the row declares an object with hi / med / lo>',
      },
      {
        value: 7,
        expected:
          '<UNRENDERABLE — the number 7 where the row declares an object with hi / med / lo>',
      },
      {
        value: null,
        expected: '<UNRENDERABLE — null where the row declares an object with hi / med / lo>',
      },
    ];

    for (const { value, expected } of cases) {
      const { container } = render(
        <PersonScorecard
          employee={withField({ key: 'complexityMix', value })}
          onClose={() => {}}
        />,
      );

      expect(valueOf({ container, label: 'Complexity mix' })).toBe(expected);
      expect(valueOf({ container, label: 'Ticket count' })).toBe('20');
      cleanup();
    }
  });

  it('is not specific to one metric: ticketCount and storyPointsTotal get the same treatment', () => {
    const { container } = render(
      <PersonScorecard
        employee={without({ keys: ['ticketCount', 'storyPointsTotal'] })}
        onClose={() => {}}
      />,
    );

    expect(valueOf({ container, label: 'Ticket count' })).toBe(MISSING_MARKER);
    expect(valueOf({ container, label: 'Story points' })).toBe(MISSING_MARKER);
    expect(valueOf({ container, label: 'Complexity mix' })).toBe('2 / 5 / 13');
  });

  it('renders as a panel, not an empty box, when every metric is absent', () => {
    const { container } = render(
      <PersonScorecard
        employee={nonconforming({ row: { displayName: 'Nia' } })}
        onClose={() => {}}
      />,
    );

    const panel = scorecardOf({ container });

    expect(panel.textContent).toContain('Nia');
    expect(panel.textContent).toContain('Evidence metrics');
    expect(panel.querySelectorAll('[data-testid="scorecard-close"]').length).toBe(1);

    // Eleven metric rows, every one of them named rather than dropped (ONT-070).
    expect(panel.querySelectorAll('[data-unrenderable="true"]').length).toBe(11);
  });

  it('keeps a header for a row whose identity field is itself unrenderable', () => {
    const { container } = render(
      <PersonScorecard employee={without({ keys: ['displayName'] })} onClose={() => {}} />,
    );

    const title = scorecardOf({ container }).querySelector('[title]');

    expect(title?.textContent).toBe(MISSING_MARKER);
    expect(title?.getAttribute('title')).toBe(MISSING_MARKER);
    expect(valueOf({ container, label: 'Ticket count' })).toBe('20');
  });

  it('passes the server marker through verbatim rather than re-describing it', () => {
    const served = '<UNRENDERABLE — a bigint (42)>';
    const { container } = render(
      <PersonScorecard
        employee={withField({ key: 'storyPointsTotal', value: served })}
        onClose={() => {}}
      />,
    );

    expect(valueOf({ container, label: 'Story points' })).toBe(served);
  });

  it('names a field whose getter throws instead of letting the throw escape', () => {
    const row: Record<string, unknown> = { ...employee({}) };
    Object.defineProperty(row, 'helpGiven', {
      enumerable: true,
      get: () => {
        throw new Error('column dropped');
      },
    });

    const { container } = render(
      <PersonScorecard employee={nonconforming({ row })} onClose={() => {}} />,
    );

    expect(valueOf({ container, label: 'Help given' })).toBe(
      '<UNRENDERABLE — reading it threw: column dropped>',
    );
    expect(valueOf({ container, label: 'Help received' })).toBe('4');
  });
});
