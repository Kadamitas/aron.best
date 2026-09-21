import { createWriteStream } from 'node:fs';
import { chmod, mkdir, mkdtemp, readdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { pipeline } from 'node:stream/promises';

if (process.getuid?.() !== 10001 || process.env.RUNTIME_DIRECTORY !== '/data') {
  throw new Error('Restore must run as the container service user with its data volume.');
}
if ((await readdir('/data')).length !== 0) {
  throw new Error('Restore requires an empty volume. Existing data has not been changed.');
}
async function tar(arguments_, inspect) {
  const process = spawn('tar', arguments_, { stdio: ['ignore', 'pipe', 'inherit'], env: { PATH: '/usr/bin:/bin', LC_ALL: 'C.UTF-8' } });
  const completed = new Promise((resolve, reject) => {
    process.once('error', reject);
    process.once('close', code => code === 0 ? resolve() : reject(new Error(`Archive processing failed with status ${code}.`)));
  });
  try {
    for await (const line of createInterface({ input: process.stdout, crlfDelay: Infinity })) inspect?.(line);
    await completed;
  } catch (error) {
    process.kill('SIGTERM');
    await completed.catch(() => {});
    throw error;
  }
}

function inspectName(name) {
  const parts = name.split('/').filter(part => part !== '' && part !== '.');
  if (name.startsWith('/') || /[\\\x00-\x1f\x7f]/.test(name) || parts.includes('..') || parts[0]?.startsWith('.restore-')) {
    throw new Error('The backup contains an unsafe file path.');
  }
}

async function restrictPermissions(directory, root = directory) {
  await chmod(directory, 0o700);
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) await restrictPermissions(filename, root);
    else if (entry.isFile()) await chmod(filename, /^backup-objects\/([a-f0-9]{2})\/\1[a-f0-9]{62}$/.test(path.relative(root, filename)) ? 0o400 : 0o600);
    else throw new Error('The extracted backup contains a non-regular file.');
  }
}

if (process.argv[2] !== '--check') {
  const staging = await mkdtemp('/data/.restore-');
  try {
    const archive = path.join(staging, 'backup.tar');
    const contents = path.join(staging, 'contents');
    await mkdir(contents, { mode: 0o700 });
    await pipeline(process.stdin, createWriteStream(archive, { flags: 'wx', mode: 0o600 }));
    await tar(['-tf', archive, '--quoting-style=escape'], inspectName);
    await tar(['-tvf', archive, '--quoting-style=escape'], line => {
      if (!['-', 'd'].includes(line[0])) throw new Error('The backup contains a link or special file.');
    });
    await tar(['-xpf', archive, '--no-same-owner', '--keep-old-files', '--no-xattrs', '--no-acls', '--no-selinux', '-C', contents]);
    await restrictPermissions(contents);
    for (const name of await readdir(contents)) await rename(path.join(contents, name), path.join('/data', name));
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}
