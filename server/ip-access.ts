import { isIP } from 'node:net';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';

export function normalizeIp(value: string): string {
  const address = value.startsWith('::ffff:') ? value.slice(7) : value;
  if (!isIP(address)) throw new Error('Invalid IP address.');
  return isIP(address) === 6 ? new URL(`http://[${address}]/`).hostname.slice(1, -1) : address;
}

const entrySchema = z.object({ ip: z.string(), source: z.enum(['invite', 'minecraft']), grantedAt: z.string().datetime() });
export class IpAccess {
  private entries = new Map<string, z.infer<typeof entrySchema>>();
  private queue: Promise<void> = Promise.resolve();
  constructor(private readonly file: string) {}

  async initialize(): Promise<void> {
    try {
      const entries = z.array(entrySchema).max(10000).parse(JSON.parse(await readFile(this.file, 'utf8')));
      this.entries = new Map(entries.map(entry => [normalizeIp(entry.ip), entry]));
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }

  allows(ip: string): boolean { return this.entries.has(normalizeIp(ip)); }

  grant(ip: string, source: 'invite' | 'minecraft'): Promise<void> {
    const normalized = normalizeIp(ip);
    const operation = this.queue.then(async () => {
      if (this.entries.has(normalized)) return;
      if (this.entries.size >= 10000) throw new Error('IP access list is full.');
      const next = new Map(this.entries);
      next.set(normalized, { ip: normalized, source, grantedAt: new Date().toISOString() });
      await mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
      const temporary = `${this.file}.${randomUUID()}.tmp`;
      await writeFile(temporary, JSON.stringify([...next.values()]), { mode: 0o600, flag: 'wx' });
      await rename(temporary, this.file);
      this.entries = next;
    });
    this.queue = operation.catch(() => undefined);
    return operation;
  }
}
