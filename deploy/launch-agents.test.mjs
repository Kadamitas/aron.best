import assert from 'node:assert/strict';
import test from 'node:test';
import { loadAgent, parseServiceState, unloadAgent } from './launch-agents.mjs';

const absent = { status: 113, stdout: '', stderr: 'Bad request.\nCould not find service "best.aron.api" in domain for user gui: 501' };
const successful = { status: 0, stdout: '', stderr: '' };
const plist = '/temporary/LaunchAgents/best.aron.api.plist';
const loaded = { status: 0, stdout: `path = ${plist}\npid = 12345\nstate = running\n`, stderr: '' };
const bootstrapRace = { status: 5, stdout: '', stderr: 'Bootstrap failed: 5: Input/output error' };

test('unload waits for both launchd removal and the previous wrapper to exit', async () => {
  let clock = 0;
  let reads = 0;
  let bootouts = 0;
  await unloadAgent('gui/501/best.aron.api', {
    run: async arguments_ => {
      if (arguments_[0] === 'bootout') { bootouts += 1; return successful; }
      return ++reads < 3 ? loaded : absent;
    },
    processExists: () => clock < 750,
    now: () => clock,
    pause: async milliseconds => { clock += milliseconds; },
    report: () => undefined,
  });
  assert.equal(bootouts, 1);
  assert.equal(clock, 750);
  assert.ok(reads >= 5);
});

test('unload timeout preserves graceful shutdown and never bootstraps or kills', async () => {
  let clock = 0;
  const operations = [];
  await assert.rejects(unloadAgent('gui/501/best.aron.api', {
    run: async arguments_ => { operations.push(arguments_[0]); return arguments_[0] === 'print' ? loaded : successful; },
    processExists: () => true,
    now: () => clock,
    pause: async milliseconds => { clock += milliseconds; },
    report: () => undefined,
  }), /still stopping after 60 seconds/);
  assert.equal(clock, 60_000);
  assert.ok(operations.every(operation => ['print', 'bootout'].includes(operation)));
});

test('permission failures are never mistaken for an unloaded service', () => {
  assert.throws(() => parseServiceState({ status: 1, stdout: '', stderr: 'Operation not permitted' }), /Operation not permitted/);
  assert.throws(() => parseServiceState({ status: 113, stdout: '', stderr: 'unrelated error' }), /print failed/);
});

test('bootstrap retries only the bounded launchd I/O cleanup race', async () => {
  let attempts = 0;
  const delays = [];
  await loadAgent('gui/501', plist, 'gui/501/best.aron.api', {
    run: async arguments_ => arguments_[0] === 'bootstrap' ? ++attempts === 1 ? bootstrapRace : successful : attempts === 1 ? absent : loaded,
    pause: async milliseconds => { delays.push(milliseconds); },
  });
  assert.equal(attempts, 2);
  assert.deepEqual(delays, [250]);
  attempts = 0;
  await assert.rejects(loadAgent('gui/501', plist, 'gui/501/best.aron.api', {
    run: async arguments_ => { if (arguments_[0] === 'bootstrap') { attempts += 1; return bootstrapRace; } return absent; },
    pause: async () => undefined,
  }), /bootstrap failed/);
  assert.equal(attempts, 4);
});

test('bootstrap cannot silently accept a registration from a different plist', async () => {
  await assert.rejects(loadAgent('gui/501', plist, 'gui/501/best.aron.api', {
    run: async arguments_ => arguments_[0] === 'bootstrap' ? bootstrapRace : { ...loaded, stdout: 'path = /different/agent.plist\npid = 999\n' },
  }), /another plist/);
});
