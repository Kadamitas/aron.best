import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { savedBackups, savedBackupPath } from './backup-history.js';

test('saved backups survive sessions and distinguish automatic and legacy manual snapshots', async t => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'backup-history-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  assert.deepEqual(await savedBackups(root, 'profile'), []);
  for (const [id, createdAt, kind] of [['2026-09-20-first', '2026-09-20T00:00:00.000Z', undefined], ['2026-09-21-second', '2026-09-21T00:00:00.000Z', 'automatic']] as const) {
    const snapshot = path.join(root, 'backups', id);
    await mkdir(snapshot, { recursive: true });
    await writeFile(path.join(snapshot, 'backup.json'), JSON.stringify({ createdAt, snapshotBytes: '42', ...(kind ? { kind } : {}) }));
  }
  await mkdir(path.join(root, 'backups', '.incomplete-test'));
  const result = await savedBackups(root, 'profile');
  assert.deepEqual(result.map(entry => entry.kind), ['automatic', 'manual']);
  assert.equal(result[0]!.sizeBytes, '42');
  assert.equal(await savedBackupPath(root, 'profile', result[0]!.id), path.join(root, 'backups', result[0]!.id));
  await assert.rejects(savedBackupPath(root, 'profile', '../minecraft'), /Choose/);
  await assert.rejects(savedBackupPath(root, 'profile', '2026-missing'), /no longer/);
});

test('backup history rejects redirected storage and linked or malformed metadata', async t => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'backup-history-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const outside = path.join(root, 'outside');
  await mkdir(outside);
  await symlink(outside, path.join(root, 'backups'));
  await assert.rejects(savedBackups(root, 'profile'), /linked/);
  await rm(path.join(root, 'backups'));
  const snapshot = path.join(root, 'backups', '2026-snapshot');
  await mkdir(snapshot, { recursive: true });
  const manifest = path.join(outside, 'manifest');
  await writeFile(manifest, '{}');
  await symlink(manifest, path.join(snapshot, 'backup.json'));
  await assert.rejects(savedBackups(root, 'profile'));
  await rm(path.join(snapshot, 'backup.json'));
  await writeFile(path.join(snapshot, 'backup.json'), '{}');
  await assert.rejects(savedBackups(root, 'profile'), /metadata is invalid/);
});
