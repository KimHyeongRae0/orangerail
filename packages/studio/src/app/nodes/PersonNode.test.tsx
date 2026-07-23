// @vitest-environment jsdom
import { ReactFlowProvider, type NodeProps } from '@xyflow/react';
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import type { InstanceEmployee } from '../../snapshot/instances';
import type { PersonNode as PersonNodeType, PlaceNode as PlaceNodeType } from '../instanceModel';
import { PersonNode } from './PersonNode';
import { ServiceNode } from './ServiceNode';

const HOSTILE = '<img src=x onerror="window.__ont_person_xss=1">Zed';

const employee: InstanceEmployee = {
  accountId: 'acc_zed',
  displayName: HOSTILE,
  active: true,
  ticketCount: 1,
  storyPointsTotal: 40,
  complexityMix: { hi: 0, med: 0, lo: 1 },
  medianCycleDaysFirstHalf: 1,
  medianCycleDaysSecondHalf: 1,
  reopenRate: 1,
  reassignmentsGiven: 0,
  reassignmentsReceived: 0,
  helpGiven: 0,
  helpReceived: 0,
  weekendOffHoursShare: 0,
};

afterEach(cleanup);

describe('PersonNode (plan section 3.3, AC-6)', () => {
  it('renders a hostile displayName as inert text, never as markup', () => {
    const props = {
      data: { employee, radius: 40, active: false },
    } as unknown as NodeProps<PersonNodeType>;

    const { container } = render(
      <ReactFlowProvider>
        <PersonNode {...props} />
      </ReactFlowProvider>,
    );

    const node = container.querySelector('[data-instance-kind="person"]');
    expect(node?.textContent).toContain('onerror');
    expect(container.querySelectorAll('img').length).toBe(0);
    expect((window as unknown as { __ont_person_xss?: number }).__ont_person_xss).toBeUndefined();
  });

  it('sizes the circle by the given radius', () => {
    const props = {
      data: { employee, radius: 30, active: false },
    } as unknown as NodeProps<PersonNodeType>;

    const { container } = render(
      <ReactFlowProvider>
        <PersonNode {...props} />
      </ReactFlowProvider>,
    );

    const node = container.querySelector<HTMLElement>('[data-instance-kind="person"]');
    expect(node?.style.width).toBe('60px');
  });
});

describe('ServiceNode (plan section 3.3)', () => {
  it('marks a service with data-instance-kind="service"', () => {
    const props = {
      data: {
        kind: 'service',
        label: 'admin-console',
        service: {
          id: 'a',
          name: 'admin-console',
          ticketCount: 5,
          distinctAssignees: 2,
          busFactor: 2,
        },
      },
    } as unknown as NodeProps<PlaceNodeType>;

    const { container } = render(
      <ReactFlowProvider>
        <ServiceNode {...props} />
      </ReactFlowProvider>,
    );

    expect(container.querySelector('[data-instance-kind="service"]')).not.toBeNull();
    expect(container.textContent).toContain('admin-console');
  });
});
