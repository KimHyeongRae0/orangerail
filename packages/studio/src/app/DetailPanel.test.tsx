// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import type { InstanceEmployee } from '../snapshot/instances';
import { PersonScorecard } from './DetailPanel';

const HOSTILE = '<img src=x onerror="window.__ont_score_xss=1">Zed';

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
