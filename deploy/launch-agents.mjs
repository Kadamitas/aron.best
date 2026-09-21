import { execFile } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

function runLaunchctl(arguments_, timeoutMilliseconds = 10_000) {
  return new Promise(resolve => {
    execFile('/bin/launchctl', arguments_, { timeout: Math.max(1, timeoutMilliseconds), maxBuffer: 128 * 1024, encoding: 'utf8' }, (error, stdout, stderr) => {
      resolve({ status: error ? typeof error.code === 'number' ? error.code : null : 0, stdout, stderr, error });
    });
  });
}

function processExists(pid) {
  try { process.kill(pid, 0); return true; } catch (error) {
    if (error.code === 'ESRCH') return false;
    throw error;
  }
}

const defaults = { run: runLaunchctl, pause: delay, now: Date.now, processExists, report: console.log };

function failure(operation, result) {
  return new Error(`launchctl ${operation} failed (${result.status ?? 'timeout or execution error'}): ${(result.stderr || result.error?.message || result.stdout || 'no diagnostic').trim()}`);
}

export function parseServiceState(result) {
  if (result.status === 0) {
    return {
      registered: true,
      pid: Number(result.stdout.match(/^\s*pid = (\d+)\s*$/m)?.[1]) || null,
      path: result.stdout.match(/^\s*path = (.+)\s*$/m)?.[1]?.trim() ?? null,
    };
  }
  if (result.status === 113 && /Could not find service\b/.test(`${result.stdout}\n${result.stderr}`)) return { registered: false, pid: null, path: null };
  throw failure('print', result);
}

export async function unloadAgent(serviceTarget, overrides = {}) {
  const dependencies = { ...defaults, ...overrides };
  const initial = parseServiceState(await dependencies.run(['print', serviceTarget]));
  if (!initial.registered) return;
  dependencies.report(`Stopping ${serviceTarget}; waiting for its registration and process to exit.`);
  const result = await dependencies.run(['bootout', serviceTarget]);
  if (result.status !== 0) {
    const current = parseServiceState(await dependencies.run(['print', serviceTarget]));
    if (current.registered) throw failure('bootout', result);
  }
  const deadline = dependencies.now() + 60_000;
  let nextProgressAt = dependencies.now() + 15_000;
  while (true) {
    if (dependencies.now() >= deadline) {
      throw new Error(`${serviceTarget} is still stopping after 60 seconds. No replacement was started and no process was forcibly terminated; its graceful shutdown may continue.`);
    }
    const current = parseServiceState(await dependencies.run(['print', serviceTarget], Math.min(10_000, deadline - dependencies.now())));
    const processRunning = initial.pid !== null && dependencies.processExists(initial.pid);
    if (!current.registered && !processRunning) return;
    if (dependencies.now() >= nextProgressAt) {
      dependencies.report(`Still waiting for ${serviceTarget} to finish graceful shutdown.`);
      nextProgressAt = dependencies.now() + 15_000;
    }
    await dependencies.pause(Math.max(0, Math.min(250, deadline - dependencies.now())));
  }
}

export async function loadAgent(launchDomain, plistPath, serviceTarget, overrides = {}) {
  const dependencies = { ...defaults, ...overrides };
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const result = await dependencies.run(['bootstrap', launchDomain, plistPath]);
    const current = parseServiceState(await dependencies.run(['print', serviceTarget]));
    if (current.registered) {
      if (current.path !== plistPath) throw new Error(`${serviceTarget} is registered from another plist. The existing registration was left untouched.`);
      if (result.status === 0 || result.status === 5) return;
    }
    if (result.status !== 5 || attempt === 3) throw failure('bootstrap', result);
    // launchd can release the public label just before completing internal cleanup.
    await dependencies.pause(250 * 2 ** attempt);
  }
}
