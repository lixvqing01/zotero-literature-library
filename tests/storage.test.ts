import test from 'node:test';
import assert from 'node:assert/strict';
import { formatBytes, removeResultArchives, storageUsage } from '../src/storage';

test('storage usage reports cache, model and database bytes independently', async () => {
  const root = '/profile/literature-library';
  const dirs: Record<string, string[]> = {
    [`${root}/documents`]: [`${root}/documents/paper`],
    [`${root}/documents/paper`]: [`${root}/documents/paper/chart.png`, `${root}/documents/paper/result.zip`],
    [`${root}/models`]: [`${root}/models/model.onnx`]
  };
  const sizes: Record<string, number> = {
    [`${root}/documents/paper/chart.png`]: 1200,
    [`${root}/documents/paper/result.zip`]: 3000,
    [`${root}/models/model.onnx`]: 9000,
    [`${root}/library.sqlite`]: 500,
    [`${root}/library.sqlite-wal`]: 100
  };
  const io = {
    getChildren: async (path: string) => { if (!(path in dirs)) throw Error('missing'); return dirs[path]; },
    stat: async (path: string) => path in dirs ? { type: 'directory' } : { type: 'regular', size: sizes[path] },
    remove: async (path: string) => { delete sizes[path]; }
  };
  const oldIO = (globalThis as any).IOUtils, oldPaths = (globalThis as any).PathUtils;
  (globalThis as any).IOUtils = io;
  (globalThis as any).PathUtils = { join: (...parts: string[]) => parts.join('/') };
  try {
    assert.deepEqual(await storageUsage(root), { documents: 4200, models: 9000, database: 600, total: 13800 });
    assert.equal(await removeResultArchives(`${root}/documents`, io), 1);
    assert.equal(sizes[`${root}/documents/paper/chart.png`], 1200);
    assert.equal(sizes[`${root}/documents/paper/result.zip`], undefined);
    assert.deepEqual(await storageUsage(root), { documents: 1200, models: 9000, database: 600, total: 10800 });
  } finally {
    (globalThis as any).IOUtils = oldIO;
    (globalThis as any).PathUtils = oldPaths;
  }
});

test('storage byte labels stay compact across units', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(1024), '1.0 KB');
  assert.equal(formatBytes(5 * 1024 ** 3), '5.0 GB');
});
