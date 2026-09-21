import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const runner = join(dirname(fileURLToPath(import.meta.url)), 'run-service.mjs');

test('a noisy service cannot grow its retained logs beyond the configured budget', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'aron-log-retention-'));
  try {
    const settingsPath = join(directory, 'settings.json');
    await writeFile(settingsPath, JSON.stringify({
      projectRoot: directory,
      logDirectory: directory,
      services: {
        api: {
          binary: process.execPath,
          arguments: ['-e', 'const block = Buffer.alloc(1024 * 1024, 120); for (let index = 0; index < 23; index++) process.stdout.write(block);'],
          environment: {},
        },
      },
    }));
    const process_ = spawn(process.execPath, [runner, settingsPath, 'api'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let errors = '';
    process_.stderr.on('data', (chunk) => { errors += chunk; });
    const [code] = await once(process_, 'close');
    assert.equal(code, 0, errors);
    const logNames = (await readdir(directory)).filter((name) => name.startsWith('api.log'));
    assert.equal(logNames.length, 4);
    for (const name of logNames) assert.ok((await stat(join(directory, name))).size <= 5 * 1024 * 1024);
    assert.match(await readFile(join(directory, 'api.log'), 'utf8'), /api exited with 0/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
