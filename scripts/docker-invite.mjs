import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const origin = new URL(process.argv[2] || 'http://127.0.0.1:3300');
if (!['http:', 'https:'].includes(origin.protocol) || origin.username || origin.password) throw new Error('Provide a plain HTTP or HTTPS workshop origin.');
const token = (await readFile(fileURLToPath(new URL('../.runtime/docker/secrets/friend_access_token', import.meta.url)), 'utf8')).trim();
if (token.length < 32) throw new Error('Run docker-prepare.mjs first.');
origin.pathname = '/';
origin.search = '';
origin.hash = new URLSearchParams({ invite: token }).toString();
console.log(origin.href);
