import { describe, expect, it } from 'vitest';

import { version } from '../src/index';

describe('orangerail-core smoke', () => {
  it('exposes a version string', () => {
    expect(version).toBe('0.0.0');
  });
});
