import { randomBytes } from 'node:crypto';
import { chmod, readFile, writeFile } from 'node:fs/promises';
const file = new URL('../.env', import.meta.url);
const current = await readFile(file, 'utf8').catch(() => '');
const existing = current.match(/^FRIEND_ACCESS_TOKEN=(.+)$/m)?.[1];
if (existing && !process.argv.includes('--rotate')) {
  console.log('A private invitation already exists. Use --rotate to revoke it and create a replacement.');
  process.exit(0);
}
const token = randomBytes(32).toString('base64url');
const updated = current.replace(/^FRIEND_ACCESS_TOKEN=.*\n?/gm, '') + `\nFRIEND_ACCESS_TOKEN=${token}\n`;
await writeFile(file, updated, { mode: 0o600 });
await chmod(file, 0o600);
console.log('Saved private invitation in .env. Restart the Node service after changing it.');
if (process.argv.includes('--show')) console.log(`https://mc.modpack.aron.best/#invite=${token}`);
