import { HttpClient, HttpErrorResponse, HttpHeaders, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { firstValueFrom, timeout } from 'rxjs';

export interface Mod {
  id: number;
  name: string;
  summary: string;
  logoUrl?: string;
  downloadCount: number;
  websiteUrl?: string;
  fileId?: number;
  version?: string;
}

export interface Release {
  id?: string;
  version?: string;
  displayName?: string;
  createdAt?: string;
  status?: string;
  url?: string;
  changelog?: string;
}

export interface WorkshopStatus {
  history: Array<Mod & { removedAt: string }>;
  requests: Array<{ id: string; url: string; slug: string; submittedAt: string; status: 'pending' | 'installed' }>;
  server: {
    state: string;
    version?: string;
    address: string;
    uptimeSeconds?: number;
    lastBackup?: string;
    backupError?: string | null;
    busy?: boolean;
    operation?: string;
    failure?: { at: string; message: string; exitCode?: number | null; recoveredAt?: string } | null;
    crashLog?: string[];
    installationError?: string;
    profileError?: string;
    players?: { online: number | null; max: number | null; names: string[] | null };
  };
  workspace?: { profileId: string; server: WorkshopStatus['server']; updatedAt?: string | null };
  pack: {
    name: string;
    minecraftVersion: string;
    loader: string;
    loaderVersion?: string;
    version: string;
    mods: Mod[];
    releases: Release[];
  };
  capabilities: {
    curseforgeSearch: boolean;
    publish: boolean;
    update: boolean;
    server: boolean;
    authorized: boolean;
    ipWhitelisted?: boolean;
    joinAccess?: boolean;
    localProfile: boolean;
    workspaceWrite?: boolean;
  };
  activity: Array<{ message?: string; action?: string; createdAt?: string; timestamp?: string } | string>;
  jobRunning?: boolean;
  profiles?: ServerProfiles;
}

export interface WorkspaceFile {
  path: string;
  name: string;
  size: number;
  modifiedAt: string;
  text: boolean;
}

export interface WorkspaceText extends WorkspaceFile {
  contents: string;
  revision: string;
}

export interface WorkspaceDirectory {
  path: string;
  name: string;
}

export interface WorkspaceMod extends WorkspaceFile {
  enabled: boolean;
}

export type ModAction = 'enable' | 'disable' | 'uninstall';

export type ServerAction = 'start' | 'stop' | 'restart' | 'backup' | 'update' | 'sync-profile';

export interface ServerBackup {
  id: string;
  profileId: string;
  state: 'running' | 'ready' | 'failed';
  filename?: string;
  error?: string;
}

export interface ServerTarget {
  minecraftVersion: string;
  loader: 'Fabric' | 'Forge' | 'NeoForge' | 'Quilt';
  loaderVersion: string;
}

export interface ServerVersions {
  versions: string[];
  minecraftVersion: string;
  loaders: Array<Pick<ServerTarget, 'loader' | 'loaderVersion'>>;
}

export interface SavedServer extends ServerTarget {
  id: string;
  name: string;
}

export interface ServerProfiles {
  activeId: string;
  profiles: SavedServer[];
  limit: number;
}

export interface RecoverableServer extends SavedServer {
  deleted: boolean;
  removedAt?: string;
}

export interface RetainedBackup {
  id: string;
  profileId: string;
  createdAt: string;
  kind: 'manual' | 'automatic';
  sizeBytes: string;
}

export interface ServerRecovery {
  servers: RecoverableServer[];
  backups: RetainedBackup[];
  automatic: { enabled: boolean; intervalHours: number; retained: number; error?: string | null };
}

@Injectable({ providedIn: 'root' })
export class WorkshopApi {
  private readonly http = inject(HttpClient);
  private readonly tokenKey = 'aron.workshop.invite';
  private invitation = '';
  private activeProfileId?: string;
  private selectedWorkspaceId?: string;
  private statusRequest = 0;

  constructor() {
    const fragment = new URLSearchParams(location.hash.slice(1));
    const invitation = fragment.get('invite');
    if (invitation) {
      this.invitation = invitation;
      try { sessionStorage.setItem(this.tokenKey, invitation); } catch {}
      const url = new URL(location.href);
      url.hash = '';
      history.replaceState(null, '', `${url.pathname}${url.search}`);
    } else {
      try { this.invitation = sessionStorage.getItem(this.tokenKey) ?? ''; } catch {}
    }
  }

  private get headers(): HttpHeaders {
    return this.profileHeaders();
  }

  private profileHeaders(): HttpHeaders {
    let headers = this.invitation ? new HttpHeaders({ Authorization: `Bearer ${this.invitation}` }) : new HttpHeaders();
    if (this.activeProfileId) headers = headers.set('X-Server-Profile', this.activeProfileId);
    return headers;
  }

  private workspaceHeaders(profileId = this.selectedWorkspaceId): HttpHeaders {
    const headers = this.profileHeaders();
    return profileId ? headers.set('X-Workspace-Profile', profileId) : headers;
  }

  selectWorkspace(id: string): void {
    this.selectedWorkspaceId = id;
    this.statusRequest++;
  }

  async status(): Promise<WorkshopStatus> {
    const request = ++this.statusRequest;
    if (this.invitation) {
      await firstValueFrom(this.http.post('/api/access/redeem', {}, { headers: this.headers }));
      this.invitation = '';
      try { sessionStorage.removeItem(this.tokenKey); } catch {}
    }
    const status = await firstValueFrom(this.http.get<WorkshopStatus>('/api/status', { headers: this.workspaceHeaders() }).pipe(timeout(20_000)));
    if (request === this.statusRequest) {
      this.activeProfileId = status.profiles?.activeId;
      this.selectedWorkspaceId = status.workspace?.profileId ?? status.profiles?.activeId;
    }
    return status;
  }

  requestMod(url: string): Promise<unknown> {
    return firstValueFrom(this.http.post('/api/pack/requests', { url }, { headers: this.headers }));
  }

  importLocalProfile(): Promise<unknown> {
    return firstValueFrom(this.http.post('/api/pack/import-local', {}, { headers: this.headers }));
  }

  serverAction(action: ServerAction): Promise<unknown> {
    return firstValueFrom(this.http.post('/api/server/action', { action }, { headers: this.headers }));
  }

  createServerBackup(profileId: string): Promise<Pick<ServerBackup, 'id' | 'profileId'>> {
    return firstValueFrom(this.http.post<Pick<ServerBackup, 'id' | 'profileId'>>('/api/server/backups', {}, {
      headers: this.headers.set('X-Server-Profile', profileId),
    }).pipe(timeout(30_000)));
  }

  serverBackup(id: string): Promise<ServerBackup> {
    return firstValueFrom(this.http.get<ServerBackup>(`/api/server/backups/${encodeURIComponent(id)}`, {
      headers: this.headers,
    }).pipe(timeout(30_000)));
  }

  serverBackupDownloadUrl(id: string): string {
    return `/api/server/backups/${encodeURIComponent(id)}/download`;
  }

  serverVersions(minecraftVersion?: string): Promise<ServerVersions> {
    return firstValueFrom(this.http.get<ServerVersions>('/api/server/versions', { headers: this.workspaceHeaders(), ...(minecraftVersion ? { params: { minecraftVersion } } : {}) }));
  }

  saveServerInstallation(target: ServerTarget, profileId = this.selectedWorkspaceId): Promise<{ accepted: boolean }> {
    return firstValueFrom(this.http.post<{ accepted: boolean }>('/api/server/installation', target, { headers: this.workspaceHeaders(profileId) }));
  }

  createServerProfile(name: string): Promise<{ accepted: boolean }> {
    return firstValueFrom(this.http.post<{ accepted: boolean }>('/api/server/profiles', { name }, { headers: this.headers }));
  }

  selectServerProfile(id: string): Promise<{ accepted: boolean }> {
    return firstValueFrom(this.http.post<{ accepted: boolean }>('/api/server/profiles/select', { id }, { headers: this.headers }));
  }

  renameServerProfile(id: string, name: string): Promise<unknown> {
    return firstValueFrom(this.http.post('/api/server/profiles/rename', { id, name }, { headers: this.headers }));
  }

  removeServerProfile(id: string): Promise<unknown> {
    return firstValueFrom(this.http.post('/api/server/profiles/remove', { id }, { headers: this.headers }));
  }

  serverRecovery(): Promise<ServerRecovery> {
    return firstValueFrom(this.http.get<ServerRecovery>('/api/server/recovery', { headers: this.headers }).pipe(timeout(30_000)));
  }

  restoreServerProfile(id: string): Promise<{ restored: boolean }> {
    return firstValueFrom(this.http.post<{ restored: boolean }>('/api/server/profiles/restore', { id }, { headers: this.headers }).pipe(timeout(30_000)));
  }

  retainedBackupDownloadUrl(backup: Pick<RetainedBackup, 'profileId' | 'id'>): string {
    return `/api/server/recovery/backups/${encodeURIComponent(backup.profileId)}/${encodeURIComponent(backup.id)}/download`;
  }

  downloadPack(profileId = this.selectedWorkspaceId): Promise<Blob> {
    return firstValueFrom(this.http.get('/api/pack/download', { headers: this.workspaceHeaders(profileId), responseType: 'blob' }));
  }

  publish(displayName: string, changelog: string): Promise<unknown> {
    return firstValueFrom(this.http.post('/api/pack/publish', { displayName, changelog }, { headers: this.headers }));
  }

  /** One open connection the API pushes state changes and new log lines through. */
  events(): EventSource | null {
    return typeof EventSource === 'undefined' ? null : new EventSource('/api/events');
  }

  logs(): Promise<{ lines: string[] }> {
    return firstValueFrom(this.http.get<{ lines: string[] }>('/api/server/logs', { headers: this.headers }).pipe(timeout(20_000)));
  }

  workspaceFiles(profileId = this.selectedWorkspaceId): Promise<{ files: WorkspaceFile[]; directories: WorkspaceDirectory[]; truncated: boolean }> {
    return firstValueFrom(this.http.get<{ files: WorkspaceFile[]; directories: WorkspaceDirectory[]; truncated: boolean }>('/api/workspace/files', { headers: this.workspaceHeaders(profileId) }));
  }

  createWorkspaceDirectory(path: string, profileId = this.selectedWorkspaceId): Promise<unknown> {
    return firstValueFrom(this.http.post('/api/workspace/directories', { path }, { headers: this.workspaceHeaders(profileId) }));
  }

  moveWorkspaceEntry(path: string, destination: string, profileId = this.selectedWorkspaceId): Promise<unknown> {
    return firstValueFrom(this.http.post('/api/workspace/entries/move', { path, destination }, { headers: this.workspaceHeaders(profileId) }));
  }

  removeWorkspaceEntry(path: string, profileId = this.selectedWorkspaceId): Promise<unknown> {
    return firstValueFrom(this.http.post('/api/workspace/entries/remove', { path }, { headers: this.workspaceHeaders(profileId) }));
  }

  workspaceMods(profileId = this.selectedWorkspaceId): Promise<{ mods: WorkspaceMod[] }> {
    return firstValueFrom(this.http.get<{ mods: WorkspaceMod[] }>('/api/workspace/mods', { headers: this.workspaceHeaders(profileId) }).pipe(timeout(20_000)));
  }

  modAction(path: string, action: ModAction, profileId = this.selectedWorkspaceId): Promise<unknown> {
    return firstValueFrom(this.http.post('/api/workspace/mods/action', { path, action }, { headers: this.workspaceHeaders(profileId) }));
  }

  workspaceText(path: string, profileId = this.selectedWorkspaceId): Promise<WorkspaceText> {
    return firstValueFrom(this.http.get<WorkspaceText>('/api/workspace/files/text', { headers: this.workspaceHeaders(profileId), params: new HttpParams().set('path', path) }));
  }

  saveWorkspaceText(path: string, contents: string, revision: string, profileId = this.selectedWorkspaceId): Promise<WorkspaceText> {
    return firstValueFrom(this.http.put<WorkspaceText>('/api/workspace/files/text', { path, contents, revision }, { headers: this.workspaceHeaders(profileId) }));
  }

  downloadWorkspaceFile(path: string, profileId = this.selectedWorkspaceId): Promise<Blob> {
    return firstValueFrom(this.http.get('/api/workspace/files/download', { headers: this.workspaceHeaders(profileId), params: new HttpParams().set('path', path), responseType: 'blob' }));
  }

  beginWorkspaceUpload(path: string, size: number, replace: boolean, profileId = this.selectedWorkspaceId): Promise<{ id: string; chunkBytes: number }> {
    return firstValueFrom(this.http.post<{ id: string; chunkBytes: number }>('/api/workspace/uploads', { path, size, replace }, { headers: this.workspaceHeaders(profileId) }));
  }

  uploadWorkspaceChunk(id: string, index: number, data: string, profileId = this.selectedWorkspaceId): Promise<{ received: number; complete: boolean }> {
    return firstValueFrom(this.http.post<{ received: number; complete: boolean }>(`/api/workspace/uploads/${encodeURIComponent(id)}/chunks`, { index, data }, { headers: this.workspaceHeaders(profileId) }));
  }

  finishWorkspaceUpload(id: string, profileId = this.selectedWorkspaceId): Promise<WorkspaceFile> {
    return firstValueFrom(this.http.post<WorkspaceFile>(`/api/workspace/uploads/${encodeURIComponent(id)}/complete`, {}, { headers: this.workspaceHeaders(profileId) }));
  }

  cancelWorkspaceUpload(id: string, profileId = this.selectedWorkspaceId): Promise<void> {
    return firstValueFrom(this.http.delete<void>(`/api/workspace/uploads/${encodeURIComponent(id)}`, { headers: this.workspaceHeaders(profileId) }));
  }

  async uploadWorkspaceFile(file: File, path: string, replace: boolean, progress: (percent: number) => void, profileId = this.selectedWorkspaceId, signal?: AbortSignal): Promise<WorkspaceFile> {
    if (file.size < 1 || file.size > 128 * 1024 * 1024) throw new Error('Choose a file between 1 byte and 128 MiB.');
    signal?.throwIfAborted();
    const session = await this.beginWorkspaceUpload(path, file.size, replace, profileId);
    try {
      let index = 0;
      for (let offset = 0; offset < file.size; offset += session.chunkBytes) {
        signal?.throwIfAborted();
        const bytes = new Uint8Array(await file.slice(offset, offset + session.chunkBytes).arrayBuffer());
        let binary = '';
        for (let start = 0; start < bytes.length; start += 8192) binary += String.fromCharCode(...bytes.subarray(start, start + 8192));
        signal?.throwIfAborted();
        const result = await this.uploadWorkspaceChunk(session.id, index++, btoa(binary), profileId);
        progress(Math.round(result.received / file.size * 100));
      }
      signal?.throwIfAborted();
      return await this.finishWorkspaceUpload(session.id, profileId);
    } catch (error) {
      await this.cancelWorkspaceUpload(session.id, profileId).catch(() => undefined);
      throw error;
    }
  }
}

export function downloadBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}

export function errorMessage(error: unknown): string {
  if (error instanceof HttpErrorResponse) {
    if (typeof error.error?.error === 'string') return error.error.error;
    if (error.status === 0) return 'The workshop server could not be reached. Check the connection and try again.';
    if (error.status === 401 || error.status === 403) return 'Open your invitation link to make changes to this world.';
    if (error.status === 429) return 'The workshop is handling a lot of requests. Give it a moment and try again.';
    return `The request could not be completed (${error.status}). Please try again.`;
  }
  return error instanceof Error ? error.message : 'Something went wrong. Please try again.';
}
