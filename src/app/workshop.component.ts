import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { DatePipe, DecimalPipe } from '@angular/common';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormControl, ReactiveFormsModule, Validators } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatTabsModule } from '@angular/material/tabs';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatSnackBar } from '@angular/material/snack-bar';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatDialog } from '@angular/material/dialog';
import { catchError, debounceTime, distinctUntilChanged, firstValueFrom, of, switchMap, tap } from 'rxjs';
import { IconComponent } from './icon.component';
import { ConfirmDialogComponent, ConfirmDialogData } from './confirm-dialog.component';
import { Mod, ServerAction, WorkshopApi, WorkshopStatus, errorMessage } from './workshop-api.service';

@Component({
  selector: 'app-workshop',
  imports: [DatePipe, DecimalPipe, ReactiveFormsModule, MatButtonModule, MatTabsModule, MatFormFieldModule, MatInputModule, MatProgressSpinnerModule, MatProgressBarModule, MatTooltipModule, IconComponent],
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
  readonly searchResults = signal<Mod[]>([]);
  readonly searching = signal(false);
  readonly searched = signal(false);
  readonly searchError = signal('');
  readonly logs = signal<string[]>([]);
  readonly logsLoaded = signal(false);
  readonly logsError = signal('');
  readonly displayName = new FormControl('', { nonNullable: true, validators: [Validators.required, Validators.maxLength(100)] });
  readonly changelog = new FormControl('', { nonNullable: true, validators: [Validators.required, Validators.maxLength(5000)] });
  readonly mods = computed(() => this.status()?.pack.mods ?? []);
  readonly modIds = computed(() => new Set(this.mods().map(mod => mod.id)));
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
    this.search.valueChanges.pipe(
      debounceTime(350),
      distinctUntilChanged(),
      tap(() => { this.searchError.set(''); this.searching.set(true); }),
      switchMap(query => {
        if (!query.trim()) {
          this.searched.set(false);
          return of({ mods: [] as Mod[] });
        }
        this.searched.set(true);
        return this.api.search(query.trim()).pipe(catchError(error => {
          this.searchError.set(errorMessage(error));
          return of({ mods: [] as Mod[] });
        }));
      }),
      takeUntilDestroyed(this.destroyRef),
    ).subscribe(response => { this.searchResults.set(response.mods); this.searching.set(false); });
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

  async addMod(mod: Mod): Promise<void> {
    await this.perform(`add:${mod.id}`, () => this.api.addMod(mod.id), `${mod.name} added to the pack.`);
  }

  async removeMod(mod: Mod): Promise<void> {
    const confirmed = await this.confirm({
      title: `Remove ${mod.name}?`,
      description: 'This removes the mod from the draft pack. Your published releases and running server remain unchanged until the next release and update.',
      confirm: 'Remove mod',
    });
    if (confirmed) await this.perform(`remove:${mod.id}`, () => this.api.removeMod(mod.id), `${mod.name} removed from the draft.`);
  }

  async act(action: ServerAction): Promise<void> {
    const prompts: Partial<Record<ServerAction, ConfirmDialogData>> = {
      stop: { title: 'Stop the server?', description: 'Players will be disconnected. The server saves the world as it shuts down.', confirm: 'Stop server' },
      restart: { title: 'Restart the server?', description: 'Players will be disconnected while the server saves and restarts. Let your friends know before continuing.', confirm: 'Restart server' },
      update: { title: 'Update to the latest release?', description: 'The server will stop, back up the world, and install the latest compatible published modpack. Players will need the same modpack version to reconnect.', confirm: 'Back up and update' },
    };
    const prompt = prompts[action];
    if (prompt && !await this.confirm(prompt)) return;
    await this.perform(`server:${action}`, () => this.api.serverAction(action), `Server ${action} requested.`);
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

  setQuery(query: string): void { this.search.setValue(query); }

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
