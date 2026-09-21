import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { MAT_DIALOG_DATA, MatDialog, MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatButtonModule } from '@angular/material/button';
import { firstValueFrom } from 'rxjs';
import { ConfirmDialogComponent, ConfirmDialogData } from './confirm-dialog.component';
import { IconComponent } from './icon.component';
import { WorkspaceText, WorkshopApi, errorMessage } from './workshop-api.service';

interface WorkspaceEditorDialogData { file: WorkspaceText; profileId?: string; writable: () => boolean; saved: () => Promise<void>; }

@Component({
  selector: 'app-workspace-editor-dialog',
  imports: [DatePipe, MatDialogModule, MatButtonModule, IconComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './workspace-editor-dialog.component.html',
  styleUrl: './workspace-editor-dialog.component.scss',
})
export class WorkspaceEditorDialogComponent {
  readonly data = inject<WorkspaceEditorDialogData>(MAT_DIALOG_DATA);
  readonly dialog = inject(MatDialogRef<WorkspaceEditorDialogComponent>);
  private readonly dialogs = inject(MatDialog);
  private readonly api = inject(WorkshopApi);
  readonly file = signal(this.data.file);
  readonly contents = signal(this.data.file.contents);
  readonly busy = signal(false);
  readonly error = signal('');
  readonly saved = signal(false);
  readonly dirty = computed(() => this.file().revision === 'new' || this.contents() !== this.file().contents);
  readonly writable = computed(() => this.data.writable());
  private confirming = false;
  private confirmation?: MatDialogRef<ConfirmDialogComponent, boolean>;
  private active = true;

  constructor() {
    inject(DestroyRef).onDestroy(() => { this.active = false; this.confirmation?.close(false); });
    this.dialog.backdropClick().pipe(takeUntilDestroyed()).subscribe(() => void this.close());
    this.dialog.keydownEvents().pipe(takeUntilDestroyed()).subscribe(event => {
      if (event.key === 'Escape') { event.preventDefault(); void this.close(); }
    });
  }

  edit(event: Event): void { this.contents.set((event.target as HTMLTextAreaElement).value); this.saved.set(false); }

  keydown(event: KeyboardEvent): void {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') { event.preventDefault(); void this.save(); }
  }

  async save(): Promise<void> {
    if (!this.writable() || !this.dirty() || this.busy()) return;
    this.busy.set(true);
    this.error.set('');
    try {
      const file = await this.api.saveWorkspaceText(this.file().path, this.contents(), this.file().revision, this.data.profileId);
      if (!this.active) return;
      this.file.set(file);
      this.contents.set(file.contents);
      this.saved.set(true);
      await this.data.saved();
    } catch (error) { this.error.set(errorMessage(error)); }
    finally { this.busy.set(false); }
  }

  async reload(): Promise<void> {
    if (this.busy() || this.file().revision === 'new' || !await this.discardChanges()) return;
    this.busy.set(true);
    this.error.set('');
    try { const file = await this.api.workspaceText(this.file().path, this.data.profileId); if (!this.active) return; this.file.set(file); this.contents.set(file.contents); this.saved.set(false); }
    catch (error) { this.error.set(errorMessage(error)); }
    finally { this.busy.set(false); }
  }

  async close(): Promise<void> { if (!this.busy() && await this.discardChanges()) this.dialog.close(); }

  private async discardChanges(): Promise<boolean> {
    if (!this.dirty()) return true;
    if (this.confirming) return false;
    this.confirming = true;
    try {
      this.confirmation = this.dialogs.open<ConfirmDialogComponent, ConfirmDialogData, boolean>(ConfirmDialogComponent, { data: { title: 'Discard unsaved changes?', description: 'Your changes have not been saved. Keep editing or discard them.', confirm: 'Discard changes' }, width: '430px', maxWidth: 'calc(100vw - 32px)' });
      return await firstValueFrom(this.confirmation.afterClosed()) === true && this.active;
    } finally { this.confirming = false; }
  }
}
