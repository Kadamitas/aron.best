import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { MAT_DIALOG_DATA, MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatButtonModule } from '@angular/material/button';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { firstValueFrom, timer } from 'rxjs';
import { IconComponent } from './icon.component';
import { ServerBackup, WorkshopApi, errorMessage } from './workshop-api.service';

export interface ServerBackupDialogData {
  name: string;
  profileId: string;
  create: () => Promise<Pick<ServerBackup, 'id' | 'profileId'>>;
}

@Component({
  selector: 'app-server-backup-dialog',
  imports: [MatDialogModule, MatButtonModule, MatCheckboxModule, MatProgressSpinnerModule, IconComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <h2 mat-dialog-title>Back up {{ data.name }}</h2>
    <mat-dialog-content>
      <p>A copy of this server's world, mods and settings stays on the server.</p>
      <p class="detail">If it is running, it will stop safely to save the world and restart after the backup. Players will briefly disconnect.</p>
      @if (!complete()) {
        <mat-checkbox [checked]="download()" (change)="download.set($event.checked)" [disabled]="busy() || !!job()">Also download to my computer</mat-checkbox>
      }
      @if (busy()) { <div class="progress" role="status" aria-live="polite"><mat-spinner diameter="20"/><span>Saving your backup. This can take a few minutes...</span></div> }
      @if (error()) { <p class="error" role="alert">{{ error() }}</p> }
      @if (complete()) { <div class="success" role="status"><app-icon name="check"/><span>{{ download() ? 'Backup saved. If your download does not start, use Download backup below.' : 'Backup saved on the server.' }}</span></div> }
    </mat-dialog-content>
    <mat-dialog-actions align="end">
      <button mat-button (click)="dialog.close(complete())" [disabled]="busy()">{{ complete() || job() ? 'Done' : 'Cancel' }}</button>
      @if (complete()) { <a mat-stroked-button [href]="downloadUrl()" [attr.download]="job()?.filename || 'minecraft-server-backup.tar.gz'">Download backup</a> }
      @if (!complete() && !failed()) {
        <button mat-flat-button (click)="save()" [disabled]="busy()">{{ actionLabel() }}</button>
      }
    </mat-dialog-actions>
  `,
  styles: [`
    mat-dialog-content { font-size: 13px; color: #b5bdb8; line-height: 1.7; }
    p { margin: 0 0 16px; }
    .detail { color: #929f95; font-size: 12px; }
    mat-checkbox { margin-left: -10px; --mat-checkbox-label-text-size: 13px; }
    .progress, .success { display: flex; align-items: center; gap: 12px; margin-top: 20px; }
    mat-spinner, app-icon { flex: 0 0 20px; }
    .success { color: #c8f87a; }
    .error { color: #e7aaa0; margin: 20px 0 0; }
    mat-dialog-actions { padding: 16px 24px 24px; gap: 6px; }
  `],
})
export class ServerBackupDialogComponent {
  readonly data = inject<ServerBackupDialogData>(MAT_DIALOG_DATA);
  readonly dialog = inject(MatDialogRef<ServerBackupDialogComponent, boolean>);
  private readonly api = inject(WorkshopApi);
  private readonly destroyRef = inject(DestroyRef);
  readonly download = signal(true);
  readonly busy = signal(false);
  readonly complete = signal(false);
  readonly error = signal('');
  readonly job = signal<ServerBackup | null>(null);
  readonly failed = computed(() => this.job()?.state === 'failed');
  readonly downloadUrl = computed(() => this.job() ? this.api.serverBackupDownloadUrl(this.job()!.id) : '');
  readonly actionLabel = computed(() => this.job() ? 'Check backup' : this.download() ? 'Back up and download' : 'Back up');

  async save(): Promise<void> {
    if (this.busy() || this.complete() || this.failed()) return;
    this.busy.set(true);
    this.error.set('');
    this.dialog.disableClose = true;
    try {
      if (!this.job()) {
        const accepted = await this.data.create();
        if (accepted.profileId !== this.data.profileId) throw new Error('The active server changed. Close this dialog and check the selected server.');
        this.job.set({ ...accepted, state: 'running' });
      }
      const deadline = Date.now() + 20 * 60_000;
      while (this.job()?.state === 'running') {
        if (this.destroyRef.destroyed) return;
        if (Date.now() >= deadline) throw new Error('The backup is taking longer than expected. Choose Check backup to check its progress again.');
        const job = await this.api.serverBackup(this.job()!.id);
        if (job.id !== this.job()!.id || job.profileId !== this.data.profileId) throw new Error('The backup could not be matched to this server. Close this dialog and try again.');
        this.job.set(job);
        if (job.state === 'running') await firstValueFrom(timer(2_000).pipe(takeUntilDestroyed(this.destroyRef)));
      }
      const job = this.job()!;
      if (job.state === 'failed') throw new Error(job.error || 'The backup failed. Check the server log before trying again.');
      if (this.destroyRef.destroyed) return;
      if (this.download()) {
        const link = document.createElement('a');
        link.href = this.downloadUrl();
        link.download = job.filename || 'minecraft-server-backup.tar.gz';
        document.body.append(link);
        link.click();
        link.remove();
      }
      this.complete.set(true);
    } catch (error) {
      if (!this.destroyRef.destroyed) this.error.set(errorMessage(error));
    } finally {
      this.busy.set(false);
      this.dialog.disableClose = false;
    }
  }
}
