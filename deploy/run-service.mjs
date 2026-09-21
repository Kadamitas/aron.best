import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

const [settingsPath, serviceName] = process.argv.slice(2);
if (!settingsPath || !['api', 'nginx', 'caddy', 'router'].includes(serviceName)) {
  throw new Error('Expected an absolute service-settings.json path and api, nginx, caddy, or router.');
}
const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
const service = settings.services[serviceName];
const maximumLogBytes = 5 * 1024 * 1024;
const retainedLogFiles = 3;
mkdirSync(settings.logDirectory, { recursive: true, mode: 0o700 });
const logPath = join(settings.logDirectory, `${serviceName}.log`);
let logBytes = existsSync(logPath) ? statSync(logPath).size : 0;

function rotateLog() {
  const oldestPath = `${logPath}.${retainedLogFiles}`;
  if (existsSync(oldestPath)) unlinkSync(oldestPath);
  for (let index = retainedLogFiles - 1; index >= 1; index -= 1) {
    if (existsSync(`${logPath}.${index}`)) renameSync(`${logPath}.${index}`, `${logPath}.${index + 1}`);
  }
  if (existsSync(logPath)) renameSync(logPath, `${logPath}.1`);
  logBytes = 0;
}

function log(chunk) {
  const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
  for (let offset = 0; offset < data.length;) {
    if (logBytes >= maximumLogBytes) rotateLog();
    const length = Math.min(maximumLogBytes - logBytes, data.length - offset);
    appendFileSync(logPath, data.subarray(offset, offset + length), { mode: 0o600 });
    logBytes += length;
    offset += length;
  }
}

log(`\n${new Date().toISOString()} Starting ${serviceName}\n`);
const child = spawn(service.binary, service.arguments, {
  cwd: settings.projectRoot,
  env: { ...process.env, ...service.environment },
  shell: false,
  stdio: ['ignore', 'pipe', 'pipe'],
});
// Keep the Mac from idle-sleeping (-i, any power source) or sleeping on AC (-s)
// while the API and its Minecraft child run. Neither flag keeps the display on.
const sleepAssertion = process.platform === 'darwin' && serviceName === 'api' && child.pid
  ? spawn('/usr/bin/caffeinate', ['-i', '-s', '-w', String(child.pid)], { shell: false, stdio: 'ignore' })
  : undefined;
sleepAssertion?.once('error', error => log(`Could not prevent system sleep: ${error.message}\n`));
sleepAssertion?.once('exit', code => { if (code) log(`The sleep assertion exited with code ${code}.\n`); });
child.stdout.on('data', log);
child.stderr.on('data', log);
child.once('error', (error) => {
  log(`${new Date().toISOString()} Could not start ${serviceName}: ${error.message}\n`);
  process.exitCode = 1;
});

let shutdownTimer;
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    if (shutdownTimer) return;
    child.kill('SIGTERM');
    shutdownTimer = setTimeout(() => child.kill('SIGKILL'), 90_000);
    shutdownTimer.unref();
  });
}
child.once('close', (code, signal) => {
  if (shutdownTimer) clearTimeout(shutdownTimer);
  sleepAssertion?.kill('SIGTERM');
  log(`${new Date().toISOString()} ${serviceName} exited with ${code ?? signal}\n`);
  process.exitCode = code ?? 1;
});
