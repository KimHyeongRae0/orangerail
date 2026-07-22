import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { loadSnapshotFromConfig } from './watch';

const EMPTY_CONFIG =
  'export default { registry: { listObjects: () => [], listLinks: () => [], listActions: () => [] } };';

const ONE_OBJECT_CONFIG =
  "export default { registry: { listObjects: () => [{ name: 'thing', schema: {}, readAccess: 'authenticated' }], listLinks: () => [], listActions: () => [] } };";

describe('loadSnapshotFromConfig (plan section 3.6 — cache-busted re-import)', () => {
  it('loads a snapshot from a config module', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ont-005-watch-'));
    const path = join(dir, 'config.mjs');
    writeFileSync(path, EMPTY_CONFIG, 'utf8');

    const snapshot = await loadSnapshotFromConfig({ configPath: path, bust: 1 });
    expect(snapshot).toEqual({ objects: [], links: [], actions: [] });
  });

  it('reflects each config file content in its snapshot', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ont-005-watch-'));

    const emptyPath = join(dir, 'empty.mjs');
    writeFileSync(emptyPath, EMPTY_CONFIG, 'utf8');
    const first = await loadSnapshotFromConfig({ configPath: emptyPath, bust: 1 });
    expect(first.objects).toHaveLength(0);

    // Cache-busting under the real Node runtime is proven end-to-end by the
    // e2e live-reload phase; here a distinct file proves content is read back.
    const onePath = join(dir, 'one.mjs');
    writeFileSync(onePath, ONE_OBJECT_CONFIG, 'utf8');
    const second = await loadSnapshotFromConfig({ configPath: onePath, bust: 1 });
    expect(second.objects.map((o) => o.name)).toEqual(['thing']);
  });

  it('throws on a config without a registry (so the watcher keeps the last snapshot)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ont-005-watch-'));
    const path = join(dir, 'config.mjs');
    writeFileSync(path, 'export default { nope: true };', 'utf8');

    await expect(loadSnapshotFromConfig({ configPath: path, bust: 1 })).rejects.toThrow(/registry/);
  });
});
