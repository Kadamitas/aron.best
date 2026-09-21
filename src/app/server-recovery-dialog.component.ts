import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { MAT_DIALOG_DATA, MatDialog, MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatSelectModule } from '@angular/material/select';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { firstValueFrom } from 'rxjs';
import { ConfirmDialogComponent, ConfirmDialogData } from './confirm-dialog.component';
import { IconComponent } from './icon.component';
import { RecoverableServer, RetainedBackup, ServerRecovery, WorkshopApi, errorMessage, fileSize } from './workshop-api.service';

export interface ServerRecoveryDialogData {
  profileId?: string;
  limit: number;
  restore: (id: string) => Promise<void>;
}

@Component({
  selector: 'app-server-recovery-dialog',
  imports: [MatDialogModule, MatButtonModule, MatFormFieldModule, MatSelectModule, MatProgressSpinnerModule, IconComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './server-recovery-dialog.component.html',
  styleUrl: './server-recovery-dialog.component.scss',
})
export class ServerRecoveryDialogComponent {
  readonly data = inject<ServerRecoveryDialogData>(MAT_DIALOG_DATA);
  readonly dialog = inject(MatDialogRef<ServerRecoveryDialogComponent>);
  private readonly dialogs = inject(MatDialog);
  private readonly api = inject(WorkshopApi);
  private readonly destroyRef = inject(DestroyRef);
  private readonly dates = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago', month: 'short', day: 'numeric', year: 'numeric',
    hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
  });
  readonly recovery = signal<ServerRecovery | null>(null);
  readonly selectedId = signal(this.data.profileId ?? '');
  readonly loading = signal(true);
  readonly error = signal('');
  readonly restoring = signal('');
  readonly restored = signal('');
  readonly confirming = signal(false);
  readonly deletedServers = computed(() => this.recovery()?.servers.filter(server => server.deleted) ?? []);
  readonly selectedServer = computed(() => this.recovery()?.servers.find(server => server.id === this.selectedId()));
  readonly backups = computed(() => this.recovery()?.backups
    .filter(backup => backup.profileId === this.selectedId())
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt)) ?? []);
  readonly full = computed(() => (this.recovery()?.servers.filter(server => !server.deleted).length ?? 0) >= this.data.limit);
  readonly busy = computed(() => this.loading() || !!this.restoring() || this.confirming());

  constructor() { void this.load(); }

  async load(): Promise<void> {
    if (this.restoring()) return;
    this.loading.set(true);
    this.error.set('');
    try {
      const recovery = await this.api.serverRecovery();
      if (this.destroyRef.destroyed) return;
      this.recovery.set(recovery);
      if (!recovery.servers.some(server => server.id === this.selectedId())) this.selectedId.set(recovery.servers[0]?.id ?? '');
    } catch (error) {
      if (!this.destroyRef.destroyed) this.error.set(errorMessage(error));
    } finally {
      if (!this.destroyRef.destroyed) this.loading.set(false);
    }
  }

  async restore(server: RecoverableServer): Promise<void> {
    if (this.busy() || this.full() || this.error() || !server.deleted) return;
    this.confirming.set(true);
    this.dialog.disableClose = true;
    try {
      const confirmed = await firstValueFrom(this.dialogs.open<ConfirmDialogComponent, ConfirmDialogData, boolean>(ConfirmDialogComponent, {
        width: '460px', maxWidth: 'calc(100vw - 32px)',
        data: {
          title: `Restore ${server.name}?`,
          description: 'This returns the server to your saved servers with its world, mods, settings and backups intact. It uses one saved server slot. The active server keeps running, and the restored server stays stopped.',
          confirm: 'Restore server',
        },
      }).afterClosed());
      if (!confirmed || this.destroyRef.destroyed) return;
      this.restoring.set(server.id);
      this.error.set('');
      this.restored.set('');
      await this.data.restore(server.id);
      if (this.destroyRef.destroyed) return;
      this.restored.set(`${server.name} restored. The active server has not changed.`);
      this.selectedId.set(server.id);
      this.restoring.set('');
      await this.load();
    } catch (error) {
      if (!this.destroyRef.destroyed) this.error.set(errorMessage(error));
    } finally {
      if (!this.destroyRef.destroyed) {
        this.restoring.set('');
        this.confirming.set(false);
        this.dialog.disableClose = false;
      }
    }
  }

  backupUrl(backup: RetainedBackup): string { return this.api.retainedBackupDownloadUrl(backup); }

  backupSize(backup: RetainedBackup): string { return fileSize(Number(backup.sizeBytes)); }

  chicagoTime(value?: string): string {
    return value && Number.isFinite(Date.parse(value)) ? this.dates.format(new Date(value)) : 'Date unavailable';
  }
}
