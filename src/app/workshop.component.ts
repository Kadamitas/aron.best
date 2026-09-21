import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { DatePipe, DecimalPipe } from '@angular/common';
import { toSignal } from '@angular/core/rxjs-interop';
import { AbstractControl, FormControl, ReactiveFormsModule, ValidationErrors, Validators } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatTabsModule } from '@angular/material/tabs';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatSnackBar } from '@angular/material/snack-bar';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatDialog } from '@angular/material/dialog';
import { firstValueFrom } from 'rxjs';
import { IconComponent } from './icon.component';
import { ConfirmDialogComponent, ConfirmDialogData } from './confirm-dialog.component';
import { Mod, ServerAction, WorkshopApi, WorkshopStatus, errorMessage } from './workshop-api.service';

function curseForgeLink(control: AbstractControl<string>): ValidationErrors | null {
  const value = control.value.trim();
  if (!value) return null;
  try {
    const url = new URL(value);
    const valid = url.protocol === 'https:'
      && ['curseforge.com', 'www.curseforge.com'].includes(url.hostname)
      && !url.username && !url.password
      && /^\/minecraft\/mc-mods\/[a-z0-9_-]+(?:\/.*)?$/i.test(url.pathname);
    return valid ? null : { curseForgeLink: true };
  } catch { return { curseForgeLink: true }; }
}

@Component({
  selector: 'app-workshop',
  imports: [DatePipe, DecimalPipe, ReactiveFormsModule, MatButtonModule, MatTabsModule, MatFormFieldModule, MatInputModule, MatProgressSpinnerModule, MatTooltipModule, IconComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './workshop.component.html',
  styleUrl: './workshop.component.scss',
})
export class WorkshopComponent {
  private readonly api = inject(WorkshopApi);
  private readonly destroyRef = inject(DestroyRef);
  private readonly snack = inject(MatSnackBar);
  private readonly dialog = inject(MatDialog);
  readonly status = signal<WorkshopStatus | null>(null);
  readonly loading = signal(true);
  readonly connectionError = signal('');
  readonly busy = signal('');
  readonly tab = signal(0);
  readonly search = new FormControl('', { nonNullable: true });
  private readonly localQuery = toSignal(this.search.valueChanges, { initialValue: '' });
  readonly requestUrl = new FormControl('', { nonNullable: true, validators: [Validators.required, Validators.maxLength(2048), curseForgeLink] });
  readonly logs = signal<string[]>([]);
  readonly logsLoaded = signal(false);
  readonly logsError = signal('');
  readonly showCrashLog = signal(false);
  readonly displayName = new FormControl('', { nonNullable: true, validators: [Validators.required, Validators.maxLength(100)] });
  readonly changelog = new FormControl('', { nonNullable: true, validators: [Validators.required, Validators.maxLength(5000)] });
  readonly mods = computed(() => this.status()?.pack.mods ?? []);
  readonly modIds = computed(() => new Set(this.mods().map(mod => mod.id)));
  readonly history = computed(() => (this.status()?.history ?? []).filter(mod => !this.modIds().has(mod.id)));
  readonly filteredMods = computed(() => this.mods().filter(mod => this.matchesLocalQuery(mod)));
  readonly filteredHistory = computed(() => this.history().filter(mod => this.matchesLocalQuery(mod)));
  readonly requests = computed(() => this.status()?.requests ?? []);
  readonly pendingRequests = computed(() => this.requests().filter(request => request.status === 'pending'));
  readonly authorized = computed(() => this.status()?.capabilities.authorized === true);
  readonly serverReady = computed(() => this.status()?.capabilities.server === true && this.authorized());
  readonly serverRunning = computed(() => ['running', 'online'].includes(this.status()?.server.state ?? ''));
  readonly serverTransitioning = computed(() => this.status()?.jobRunning === true || this.status()?.server.busy === true || ['starting', 'stopping', 'updating', 'restarting'].includes(this.status()?.server.state ?? ''));
  readonly activity = computed(() => (this.status()?.activity ?? []).slice(0, 8).map(item => typeof item === 'string' ? { message: item, timestamp: undefined } : { message: item.message ?? item.action ?? '', timestamp: item.timestamp ?? item.createdAt }));
  readonly lastBackup = computed(() => {
    const value = this.status()?.server.lastBackup;
    if (!value) return null;
    const stamp = value.match(/^(\d{4}-\d{2}-\d{2}T\d{2})-(\d{2})-(\d{2}\.\d{3}Z)/);
    const normalized = stamp ? `${stamp[1]}:${stamp[2]}:${stamp[3]}` : value;
    return Number.isNaN(Date.parse(normalized)) ? null : normalized;
  });
  readonly releases = computed(() => this.status()?.pack.releases ?? []);
  readonly uptime = computed(() => {
    const seconds = this.status()?.server.uptimeSeconds;
    if (seconds == null || !this.serverRunning()) return 'Not running';
    if (seconds < 60) return 'Just started';
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes} min`;
    const hours = Math.floor(minutes / 60);
    return hours < 24 ? `${hours}h ${minutes % 60}m` : `${Math.floor(hours / 24)}d ${hours % 24}h`;
  });

  constructor() {
    void this.refresh();
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible' && !this.busy()) void this.refresh(false);
    }, 15000);
    this.destroyRef.onDestroy(() => clearInterval(timer));
  }

  async refresh(showLoading = true): Promise<void> {
    if (showLoading) this.loading.set(true);
    try {
      const status = await this.api.status();
      this.status.set(status);
      this.connectionError.set('');
    } catch (error) {
      this.connectionError.set(errorMessage(error));
    } finally { this.loading.set(false); }
  }

  async submitRequest(): Promise<void> {
    this.requestUrl.markAsTouched();
    if (this.requestUrl.invalid) return;
    const submitted = await this.perform('request', () => this.api.requestMod(this.requestUrl.value.trim()), 'Mod request saved. It is pending installation in the CurseForge App.');
    if (submitted) this.requestUrl.reset();
  }

  async importProfile(): Promise<void> {
    const confirmed = await this.confirm({
      title: 'Import the CurseForge App profile?',
      description: 'The draft will match the configured profile on this laptop. Mods no longer in that profile will move to Previously installed. The running server is not changed by importing.',
      confirm: 'Import profile',
    });
    if (confirmed) await this.perform('import-profile', () => this.api.importLocalProfile(), 'App profile imported. Sync App pack when you are ready to update the server.');
  }

  async act(action: ServerAction): Promise<void> {
    const prompts: Partial<Record<ServerAction, ConfirmDialogData>> = {
      stop: { title: 'Stop the server?', description: 'Players will be disconnected. The server saves the world as it shuts down.', confirm: 'Stop server' },
      restart: { title: 'Restart the server?', description: 'Players will be disconnected while the server saves and restarts. Let your friends know before continuing.', confirm: 'Restart server' },
      update: { title: 'Update to the latest release?', description: 'The server will stop, back up the world, and install the latest compatible published modpack. Players will need the same modpack version to reconnect.', confirm: 'Back up and update' },
      'sync-profile': { title: 'Sync the App pack to the server?', description: 'Players will be disconnected. The server will stop, back up the world, apply verified compatible files from the configured CurseForge App profile, and restart. Everyone needs the same pack to reconnect.', confirm: 'Back up and sync' },
    };
    const prompt = prompts[action];
    if (prompt && !await this.confirm(prompt)) return;
    await this.perform(`server:${action}`, () => this.api.serverAction(action), action === 'sync-profile' ? 'App pack sync requested. Follow its progress in Recent activity.' : `Server ${action} requested.`);
    if (this.logsLoaded()) await this.loadLogs();
  }

  async exportPack(): Promise<void> {
    await this.perform('export', async () => {
      const manifest = await this.api.exportManifest();
      const blob = new Blob([JSON.stringify(manifest, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = 'manifest.json';
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }, 'CurseForge manifest downloaded.');
  }

  async publish(): Promise<void> {
    this.displayName.markAsTouched();
    this.changelog.markAsTouched();
    if (this.displayName.invalid || this.changelog.invalid) return;
    const confirmed = await this.confirm({
      title: 'Publish this version?',
      description: `Submit ${this.mods().length} selected mods as "${this.displayName.value.trim()}" to CurseForge. New files may require CurseForge review before becoming available.`,
      confirm: 'Publish release',
    });
    if (!confirmed) return;
    const published = await this.perform('publish', () => this.api.publish(this.displayName.value.trim(), this.changelog.value.trim()), 'Release submitted to CurseForge.');
    if (published) { this.displayName.reset(); this.changelog.reset(); }
  }

  async loadLogs(): Promise<void> {
    this.logsError.set('');
    try {
      const result = await this.api.logs();
      this.logs.set(result.lines);
      this.logsLoaded.set(true);
    } catch (error) { this.logsError.set(errorMessage(error)); }
  }

  async copyAddress(): Promise<void> {
    try {
      await navigator.clipboard.writeText(this.status()?.server.address || 'mc.aron.best');
      this.snack.open('Server address copied.', 'Got it', { duration: 3000 });
    } catch { this.snack.open('Copy the server address shown above.', 'Got it', { duration: 5000 }); }
  }

  private matchesLocalQuery(mod: Mod): boolean {
    const query = this.localQuery().trim().toLocaleLowerCase();
    return !query || `${mod.name} ${mod.summary} ${mod.version ?? ''}`.toLocaleLowerCase().includes(query);
  }

  private async perform(key: string, operation: () => Promise<unknown>, success: string): Promise<boolean> {
    if (this.busy()) return false;
    this.busy.set(key);
    try {
      await operation();
      this.snack.open(success, 'Got it', { duration: 4500 });
      await this.refresh(false);
      return true;
    } catch (error) {
      this.snack.open(errorMessage(error), 'Dismiss', { duration: 9000 });
      return false;
    } finally { this.busy.set(''); }
  }

  private confirm(data: ConfirmDialogData): Promise<boolean | undefined> {
    return firstValueFrom(this.dialog.open<ConfirmDialogComponent, ConfirmDialogData, boolean>(ConfirmDialogComponent, { data, width: '460px', maxWidth: 'calc(100vw - 32px)' }).afterClosed());
  }
}
