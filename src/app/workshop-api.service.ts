import { HttpClient, HttpErrorResponse, HttpHeaders } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';

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
  server: {
    state: string;
    version?: string;
    address: string;
    uptimeSeconds?: number;
    lastBackup?: string;
    busy?: boolean;
  };
  pack: {
    name: string;
    minecraftVersion: string;
    loader: string;
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
  };
  activity: Array<{ message?: string; action?: string; createdAt?: string; timestamp?: string } | string>;
  jobRunning?: boolean;
}

export type ServerAction = 'start' | 'stop' | 'restart' | 'backup' | 'update';

@Injectable({ providedIn: 'root' })
export class WorkshopApi {
  private readonly http = inject(HttpClient);
  private readonly tokenKey = 'aron.workshop.invite';
  private invitation = '';

  constructor() {
    const fragment = new URLSearchParams(location.hash.slice(1));
    const invitation = fragment.get('invite');
    if (invitation) {
      this.invitation = invitation;
      try { sessionStorage.setItem(this.tokenKey, invitation); } catch { /* Memory-only access remains available. */ }
      const url = new URL(location.href);
      url.hash = '';
      history.replaceState(null, '', `${url.pathname}${url.search}`);
    } else {
      try { this.invitation = sessionStorage.getItem(this.tokenKey) ?? ''; } catch { /* Storage can be unavailable in private browsers. */ }
    }
  }

  private get headers(): HttpHeaders {
    return this.invitation ? new HttpHeaders({ Authorization: `Bearer ${this.invitation}` }) : new HttpHeaders();
  }

  status(): Promise<WorkshopStatus> {
    return firstValueFrom(this.http.get<WorkshopStatus>('/api/status', { headers: this.headers }));
  }

  search(query: string) {
    return this.http.get<{ mods: Mod[] }>('/api/mods/search', { params: { q: query }, headers: this.headers });
  }

  addMod(modId: number): Promise<unknown> {
    return firstValueFrom(this.http.post('/api/pack/mods', { modId }, { headers: this.headers }));
  }

  removeMod(modId: number): Promise<unknown> {
    return firstValueFrom(this.http.delete(`/api/pack/mods/${modId}`, { headers: this.headers }));
  }

  serverAction(action: ServerAction): Promise<unknown> {
    return firstValueFrom(this.http.post('/api/server/action', { action }, { headers: this.headers }));
  }

  exportManifest(): Promise<unknown> {
    return firstValueFrom(this.http.post('/api/pack/export', {}, { headers: this.headers }));
  }

  publish(displayName: string, changelog: string): Promise<unknown> {
    return firstValueFrom(this.http.post('/api/pack/publish', { displayName, changelog }, { headers: this.headers }));
  }

  logs(): Promise<{ lines: string[] }> {
    return firstValueFrom(this.http.get<{ lines: string[] }>('/api/server/logs', { headers: this.headers }));
  }
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
