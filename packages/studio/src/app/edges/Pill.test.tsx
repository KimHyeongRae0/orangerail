// @vitest-environment jsdom
import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { SnapshotAction } from '../../snapshot/types';
import { SELECT_ACTION_EVENT } from '../model';
import { Pill } from './Pill';

const base: SnapshotAction = {
  name: 'publish_product',
  approval: 'auto',
  roles: [],
  where: 'none',
  notImplemented: false,
};

const renderPill = ({ action }: { action: SnapshotAction }) =>
  render(<Pill action={action} active={false} highlighted={false} dim={false} />);

afterEach(cleanup);

describe('Pill (plan section 3.3 — action-edge grammar)', () => {
  it('shows a governed lock chip with approver roles', () => {
    const { container } = renderPill({
      action: { ...base, approval: 'required', roles: ['editor'], target: 'product' },
    });

    expect(container.textContent).toContain('approval');
    expect(container.textContent).toContain('editor');
  });

  it('shows an auto chip for ungoverned actions', () => {
    const { container } = renderPill({ action: base });
    expect(container.textContent).toContain('auto');
  });

  it('fuses a declarative where inline and marks a stub', () => {
    const { container } = renderPill({
      action: {
        ...base,
        where: 'declarative',
        whereText: 'status eq "draft"',
        notImplemented: true,
      },
    });

    expect(container.textContent).toContain('only when');
    expect(container.textContent).toContain('status eq "draft"');
    expect(container.textContent?.toLowerCase()).toContain('stub');
  });

  it('renders a functional where as a code marker', () => {
    const { container } = renderPill({ action: { ...base, where: 'functional' } });
    expect(container.textContent).toContain('condition: code');
  });

  it('dispatches a selection event on click', () => {
    const handler = vi.fn();
    window.addEventListener(SELECT_ACTION_EVENT, handler);

    const { getByTestId } = renderPill({ action: base });
    fireEvent.click(getByTestId('action-node'));

    expect(handler).toHaveBeenCalledTimes(1);
    const event = handler.mock.calls[0]?.[0] as CustomEvent;
    expect(event.detail).toBe('publish_product');

    window.removeEventListener(SELECT_ACTION_EVENT, handler);
  });
});
