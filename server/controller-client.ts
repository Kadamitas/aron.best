import { Readable } from 'node:stream';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { MinecraftServer, MaintenanceAction, ModDownload } from './minecraft.js';
import type { ModpackFiles, ModpackFile, ModpackText } from './modpack-files.js';
import type { ServerProfiles } from './server-profiles.js';
import type { BackupJob } from './backup-archive.js';

type ServerStatus = ReturnType<MinecraftServer['status']>;
export interface ControllerSnapshot {
  server: ServerStatus & { installationError?: string; profileError?: string };
  workspace: { profileId: string; server: ServerStatus & { installationError?: string }; updatedAt: string | null };
  profiles: Awaited<ReturnType<ServerProfiles['list']>>;
  profileBindingRequired: boolean;
  isolated: boolean;
  activity: Array<{ id: string; message: string; timestamp: string }>;
  joins: Array<{ id: string; ip: string }>;
}

export class ControllerClient {
  private snapshot?: ControllerSnapshot;
  private readonly profileContext = new AsyncLocalStorage<{ id?: string; workspaceId?: string; snapshot?: ControllerSnapshot }>();
  constructor(private readonly origin: string, private readonly token: string) {
    const url = new URL(origin);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('CONTROLLER_URL must be a plain internal HTTP origin.');
    if (token.length < 32) throw new Error('A controller token of at least 32 characters is required.');
  }

  async initialize() { await this.refresh(); }
  forProfile<T>(id: string | undefined, operation: () => T, workspaceId?: string): T { return this.profileContext.run({ id, workspaceId }, operation); }
  async refresh(): Promise<ControllerSnapshot> {
    const snapshot = await this.json<ControllerSnapshot>('/status');
    const context = this.profileContext.getStore();
    if (context) context.snapshot = snapshot;
    else this.snapshot = snapshot;
    return snapshot;
  }
  async assertProfile(): Promise<void> {
    const snapshot = await this.refresh();
    const id = this.profileContext.getStore()?.id;
    if (id !== undefined && id !== snapshot.profiles.activeId || id === undefined && snapshot.profileBindingRequired) throw Object.assign(new Error('The selected server changed. Refresh the workspace before continuing.'), { statusCode: 409 });
  }
  status(): ControllerSnapshot['server'] {
    const snapshot = this.profileContext.getStore()?.snapshot ?? this.snapshot;
    if (!snapshot) throw new Error('Controller has not connected.');
    return snapshot.server;
  }
  workspaceStatus(): ControllerSnapshot['workspace']['server'] {
    const snapshot = this.profileContext.getStore()?.snapshot ?? this.snapshot;
    if (!snapshot) throw new Error('Controller has not connected.');
    return snapshot.workspace.server;
  }
  get isolated(): boolean { return this.snapshot?.isolated === true; }
  async logs(): Promise<string[]> { return (await this.json<{ lines: string[] }>('/logs')).lines; }
  async latestCrashReport(): Promise<Awaited<ReturnType<MinecraftServer['latestCrashReport']>>> { return this.json('/crash'); }
  async shutdown(): Promise<void> {}
  async versions(minecraftVersion?: string): Promise<unknown> { return this.json(`/versions${minecraftVersion ? `?${new URLSearchParams({ minecraftVersion })}` : ''}`); }
  async install(target: unknown): Promise<{ accepted: boolean }> { const result = await this.json<{ accepted: boolean }>('/installation', 'POST', target); await this.refresh(); return result; }
  async profile(action: 'create' | 'select' | 'rename' | 'remove', body: unknown): Promise<unknown> { return this.json(action === 'create' ? '/profiles' : `/profiles/${action}`, 'POST', body); }
  async createBackup(): Promise<Pick<BackupJob, 'id' | 'profileId'>> { return this.json('/backups', 'POST', {}); }
  async backup(id: string): Promise<BackupJob> { return this.json(`/backups/${id}`); }
  async downloadBackup(id: string) {
    const response = await this.request(`/backups/${id}/download`, 'GET', undefined, 30 * 60_000);
    if (!response.body) throw new Error('Controller returned an empty backup download.');
    const size = Number(response.headers.get('content-length'));
    if (!Number.isSafeInteger(size) || size < 1) {
      await response.body.cancel();
      throw new Error('Controller returned an invalid backup download.');
    }
    return { stream: Readable.fromWeb(response.body as never), size };
  }
  async action(action: MaintenanceAction, resolveDownloads?: () => Promise<ModDownload[]>): Promise<void> {
    const downloads = action === 'update' || action === 'sync-profile' ? await resolveDownloads?.() : undefined;
    if (downloads?.some(file => file.localPath)) throw Object.assign(new Error('Local profile sync is unavailable across container boundaries. Upload the files in the workspace.'), { statusCode: 409 });
    await this.json('/action', 'POST', { action, ...(downloads ? { downloads } : {}) }, 15 * 60_000);
    await this.refresh();
  }

  readonly workspace = {
    list: (): ReturnType<ModpackFiles['list']> => this.json('/workspace/files'),
    listMods: (): ReturnType<ModpackFiles['listMods']> => this.json('/workspace/mods'),
    createDirectory: (path: string): ReturnType<ModpackFiles['createDirectory']> => this.json('/workspace/directories', 'POST', { path }),
    move: (path: string, destination: string): ReturnType<ModpackFiles['move']> => this.json('/workspace/entries/move', 'POST', { path, destination }),
    remove: (path: string): ReturnType<ModpackFiles['remove']> => this.json('/workspace/entries/remove', 'POST', { path }),
    modAction: (path: string, action: 'enable' | 'disable' | 'uninstall'): ReturnType<ModpackFiles['modAction']> => this.json('/workspace/mods/action', 'POST', { path, action }),
    text: (path: string): Promise<ModpackText> => this.json(`/workspace/text?${new URLSearchParams({ path })}`),
    writeText: (path: string, contents: string, revision: string): Promise<ModpackText> => this.json('/workspace/text', 'PUT', { path, contents, revision }),
    download: async (path: string) => {
      const response = await this.request(`/workspace/download?${new URLSearchParams({ path })}`);
      if (!response.body) throw new Error('Controller returned an empty download.');
      return { stream: Readable.fromWeb(response.body as never), name: path.split('/').at(-1)!, size: Number(response.headers.get('content-length')) };
    },
    beginUpload: (path: string, size: number, replace: boolean, address: string): Promise<{ id: string; chunkBytes: number }> => this.json('/workspace/uploads', 'POST', { path, size, replace, address }),
    appendUpload: (id: string, index: number, data: string, address: string): Promise<{ received: number; complete: boolean }> => this.json(`/workspace/uploads/${id}/chunks`, 'POST', { index, data, address }),
    finishUpload: (id: string, address: string): Promise<ModpackFile> => this.json(`/workspace/uploads/${id}/complete`, 'POST', { address }),
    cancelUpload: async (id: string, address: string): Promise<void> => { await this.json(`/workspace/uploads/${id}`, 'DELETE', { address }); },
    exportArchive: async (manifest: unknown) => {
      const response = await this.request('/workspace/archive', 'POST', { manifest }, 120_000);
      if (!response.body) throw new Error('Controller returned an empty archive.');
      return { stream: Readable.fromWeb(response.body as never), size: Number(response.headers.get('content-length')) };
    },
  };

  private async request(route: string, method = 'GET', body?: unknown, timeout = 30_000): Promise<Response> {
    const context = this.profileContext.getStore();
    const response = await fetch(new URL(route, this.origin), {
      method, redirect: 'error', signal: AbortSignal.timeout(timeout),
      headers: { Authorization: `Bearer ${this.token}`, ...(context?.id ? { 'X-Server-Profile': context.id } : {}), ...(context?.workspaceId ? { 'X-Workspace-Profile': context.workspaceId } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) {
      const payload = await response.json().catch(() => ({})) as { error?: string };
      throw Object.assign(new Error(payload.error ?? 'The Minecraft controller is unavailable.'), { statusCode: response.status >= 400 && response.status < 500 ? response.status : 502 });
    }
    return response;
  }

  private async json<T>(route: string, method = 'GET', body?: unknown, timeout?: number): Promise<T> {
    return (await this.request(route, method, body, timeout)).json() as Promise<T>;
  }
}
