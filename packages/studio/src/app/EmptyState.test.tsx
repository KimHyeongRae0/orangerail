// @vitest-environment jsdom
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import type { GraphSnapshot } from '../snapshot/types';
import { EmptyState, isEmptySnapshot } from './EmptyState';

const empty: GraphSnapshot = { objects: [], links: [], actions: [] };
const nonEmpty: GraphSnapshot = {
  objects: [{ name: 'x', fields: [], readAccess: 'authenticated', hasResolve: false }],
  links: [],
  actions: [],
};

afterEach(cleanup);

describe('EmptyState (ticket edge case)', () => {
  it('detects an empty snapshot', () => {
    expect(isEmptySnapshot({ snapshot: empty })).toBe(true);
    expect(isEmptySnapshot({ snapshot: nonEmpty })).toBe(false);
  });

  it('renders an explicit message, never a blank canvas', () => {
    const { getByTestId } = render(<EmptyState />);
    expect(getByTestId('empty-state').textContent).toContain('No ontology to map');
  });
});
