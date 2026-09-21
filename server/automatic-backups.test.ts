import assert from 'node:assert/strict';
import test from 'node:test';
import { AutomaticBackups } from './automatic-backups.js';

test('automatic scheduling processes due slots only and never overlaps ticks', async () => {
  const calls: string[] = [];
  let release!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  const scheduler = new AutomaticBackups({
    candidates: async () => [{ id: 'recent', due: false }, { id: 'due', due: true }],
    backup: async id => { calls.push(id); await waiting; return true; }, report: () => undefined,
  });
  const first = scheduler.tick();
  const second = scheduler.tick();
  await Promise.resolve();
  assert.deepEqual(calls, ['due']);
  release();
  await Promise.all([first, second]);
  assert.equal(scheduler.error, null);
  await scheduler.close();
});

test('idle skips retry on the next tick without logging a failure', async () => {
  let calls = 0;
  const reports: string[] = [];
  const scheduler = new AutomaticBackups({ candidates: async () => [{ id: 'playing', due: true }], backup: async () => { calls++; return false; }, report: message => reports.push(message) });
  await scheduler.tick();
  await scheduler.tick();
  assert.equal(calls, 2);
  assert.deepEqual(reports, []);
  await scheduler.close();
});

test('failed backups remain visible and retry after a bounded delay, not every tick', async () => {
  let now = 1_000;
  let calls = 0;
  let busy = false;
  const reports: string[] = [];
  const scheduler = new AutomaticBackups({
    candidates: async () => busy ? undefined : [{ id: 'world', due: true }],
    backup: async () => { if (++calls === 1) throw new Error('Disk reserve reached.'); return true; },
    report: message => reports.push(message), now: () => now,
  });
  await scheduler.tick();
  assert.match(scheduler.error!, /Disk reserve/);
  busy = true;
  await scheduler.tick();
  assert.match(scheduler.error!, /Disk reserve/);
  busy = false;
  now += 60_000;
  await scheduler.tick();
  assert.equal(calls, 1);
  now += 15 * 60_000;
  await scheduler.tick();
  assert.equal(calls, 2);
  assert.equal(scheduler.error, null);
  assert.equal(reports.length, 1);
  await scheduler.close();
});

test('shutdown awaits the current snapshot and never starts another slot', async () => {
  const calls: string[] = [];
  let release!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  const scheduler = new AutomaticBackups({ candidates: async () => [{ id: 'first', due: true }, { id: 'second', due: true }], backup: async id => { calls.push(id); await waiting; return true; }, report: () => undefined });
  const tick = scheduler.tick();
  await Promise.resolve();
  let closed = false;
  const close = scheduler.close().then(() => { closed = true; });
  await Promise.resolve();
  assert.equal(closed, false);
  release();
  await Promise.all([tick, close]);
  await scheduler.tick();
  assert.deepEqual(calls, ['first']);
});

test('scheduler listing errors are reported without unhandled rejections', async () => {
  const scheduler = new AutomaticBackups({ candidates: async () => { throw new Error('Registry unavailable.'); }, backup: async () => true, report: () => undefined });
  await scheduler.tick();
  assert.match(scheduler.error!, /Registry unavailable/);
  await scheduler.close();
});
