import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormControl, ReactiveFormsModule } from '@angular/forms';
import { toSignal } from '@angular/core/rxjs-interop';
import { MAT_DIALOG_DATA, MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { IconComponent } from './icon.component';
import { errorMessage } from './workshop-api.service';

export interface WorkspaceEntryDialogData {
  mode: 'create-folder' | 'create-file' | 'rename' | 'move' | 'delete';
  path: string;
  directory?: boolean;
  folders: string[];
  perform: (destination: string) => Promise<void>;
}

@Component({
  selector: 'app-workspace-entry-dialog',
  imports: [ReactiveFormsModule, MatDialogModule, MatButtonModule, MatFormFieldModule, MatInputModule, IconComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './workspace-entry-dialog.component.html',
  styleUrl: './workspace-entry-dialog.component.scss',
})
export class WorkspaceEntryDialogComponent {
  readonly data = inject<WorkspaceEntryDialogData>(MAT_DIALOG_DATA);
  readonly dialog = inject(MatDialogRef<WorkspaceEntryDialogComponent, string>);
  readonly name = this.data.path.split('/').at(-1)!;
  readonly parent = this.data.path.slice(0, this.data.path.lastIndexOf('/'));
  readonly nameInput = new FormControl(this.data.mode === 'rename' ? this.name : '', { nonNullable: true });
  readonly folder = signal(this.parent);
  readonly busy = signal(false);
  readonly error = signal('');
  private readonly value = toSignal(this.nameInput.valueChanges, { initialValue: this.nameInput.value });
  readonly folders = this.data.folders.filter(path => !this.data.directory || path !== this.data.path && !path.startsWith(`${this.data.path}/`));
  readonly title = this.data.mode === 'create-folder' ? 'Create folder' : this.data.mode === 'create-file' ? 'Create file' : `${this.data.mode[0].toUpperCase()}${this.data.mode.slice(1)} ${this.data.directory ? 'folder' : 'file'}`;
  readonly action = this.data.mode.startsWith('create-') ? 'Create' : this.data.mode === 'move' ? 'Move here' : this.data.mode === 'rename' ? 'Rename' : 'Delete';
  readonly destination = computed(() => {
    if (this.data.mode === 'delete') return this.data.path;
    if (this.data.mode === 'move') return `${this.folder()}/${this.name}`;
    return `${this.data.mode === 'rename' ? this.parent : this.data.path}/${this.value().trim()}`;
  });
  readonly valid = computed(() => {
    if (this.data.mode === 'delete') return true;
    if (this.data.mode === 'move') return this.folders.includes(this.folder()) && this.folder() !== this.parent;
    const name = this.value().trim();
    return name.length > 0 && name.length <= 200 && !name.startsWith('.') && !/[\\/\u0000-\u001f\u007f]/.test(name) && this.destination().length <= 320 && (this.data.mode !== 'rename' || name !== this.name);
  });

  depth(path: string): number { return path.split('/').length - (path.startsWith('world/serverconfig') ? 2 : 1); }

  async submit(): Promise<void> {
    if (!this.valid() || this.busy()) return;
    this.busy.set(true);
    this.error.set('');
    this.dialog.disableClose = true;
    try { await this.data.perform(this.destination()); this.dialog.close(this.destination()); }
    catch (error) { this.error.set(errorMessage(error)); }
    finally { this.busy.set(false); this.dialog.disableClose = false; }
  }
}
