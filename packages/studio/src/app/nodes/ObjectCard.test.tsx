// @vitest-environment jsdom
import { ReactFlowProvider, type NodeProps } from '@xyflow/react';
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import type { SnapshotObject } from '../../snapshot/types';
import type { ObjectNode, ShowMode } from '../model';
import { ObjectCard } from './ObjectCard';

const HOSTILE = '<img src=x onerror="window.__ont_card_xss=1">';

const object: SnapshotObject = {
  name: HOSTILE,
  fields: [
    { name: 'id', type: 'string', optional: false, inLink: false },
    { name: 'note', type: 'string', optional: true, inLink: false },
  ],
  readAccess: 'authenticated',
  hasResolve: false,
};

const renderCard = ({ showMode }: { showMode: ShowMode }) => {
  const props = {
    data: { object, showMode, active: false, highlighted: false, dim: false },
  } as unknown as NodeProps<ObjectNode>;

  return render(
    <ReactFlowProvider>
      <ObjectCard {...props} />
    </ReactFlowProvider>,
  );
};

afterEach(cleanup);

describe('ObjectCard (plan section 3.3 — card anatomy, AC-8)', () => {
  it('renders a hostile name as inert text, never as markup', () => {
    const { container } = renderCard({ showMode: 'all' });

    const node = container.querySelector('[data-testid="object-node"]');
    expect(node?.getAttribute('data-object-name')).toBe(HOSTILE);
    expect(node?.textContent).toContain('onerror');
    expect(container.querySelectorAll('img').length).toBe(0);
    expect(container.querySelectorAll('script').length).toBe(0);
    expect((window as unknown as { __ont_card_xss?: number }).__ont_card_xss).toBeUndefined();
  });

  it('renders one row per field with its type in All Fields mode', () => {
    const { container } = renderCard({ showMode: 'all' });

    const rows = container.querySelectorAll('[data-testid="field-row"]');
    expect(rows.length).toBe(2);
    expect(container.textContent).toContain('string');
    expect(rows[0]?.getAttribute('data-field-name')).toBe('id');
  });

  it('collapses to header-only in Name Only mode', () => {
    const { container } = renderCard({ showMode: 'name' });

    expect(container.querySelectorAll('[data-testid="field-row"]').length).toBe(0);
  });
});
