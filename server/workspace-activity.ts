import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { open, rename, unlink } from 'node:fs/promises';
import path from 'node:path';

export class WorkspaceActivity {
  updatedAt: string | null = null;

  constructor(private readonly root: string) {}

  async initialize(): Promise<void> {
    const handle = await open(path.join(this.root, 'workspace-state.json'), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    });
    if (!handle) return;
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.nlink !== 1 || info.size > 4096) throw new Error('Workspace change metadata is not a valid regular file.');
      const saved = JSON.parse(await handle.readFile('utf8')) as { updatedAt?: unknown };
      if (typeof saved.updatedAt !== 'string' || !Number.isFinite(Date.parse(saved.updatedAt))) throw new Error('Workspace change metadata is invalid.');
      this.updatedAt = new Date(saved.updatedAt).toISOString();
    } finally { await handle.close(); }
  }

  async changed(): Promise<void> {
    const updatedAt = new Date().toISOString();
    const directory = await open(this.root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    const anchored = process.platform === 'linux' ? `/proc/self/fd/${directory.fd}` : this.root;
    const temporary = path.join(anchored, `.workspace-state-${randomUUID()}.json`);
    try {
      const output = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try { await output.writeFile(`${JSON.stringify({ updatedAt })}\n`); await output.sync(); }
      finally { await output.close(); }
      await rename(temporary, path.join(anchored, 'workspace-state.json'));
      await directory.sync();
      this.updatedAt = updatedAt;
    } finally { await unlink(temporary).catch(() => undefined); await directory.close(); }
  }
}
