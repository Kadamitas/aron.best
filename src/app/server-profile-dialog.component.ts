import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { FormControl, ReactiveFormsModule, Validators } from '@angular/forms';
import { MAT_DIALOG_DATA, MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { errorMessage } from './workshop-api.service';

export interface ServerProfileDialogData {
  mode: 'create' | 'rename';
  name?: string;
  description: string;
  perform: (name: string) => Promise<void>;
}

@Component({
  selector: 'app-server-profile-dialog',
  imports: [ReactiveFormsModule, MatDialogModule, MatButtonModule, MatFormFieldModule, MatInputModule, MatProgressSpinnerModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <h2 mat-dialog-title>{{ data.mode === 'create' ? 'Create a saved server' : 'Rename server' }}</h2>
    <form (submit)="submit($event)">
      <mat-dialog-content>
        <p>{{ data.description }}</p>
        <mat-form-field appearance="outline" subscriptSizing="dynamic">
          <mat-label>Server name</mat-label>
          <input matInput [formControl]="name" maxlength="64" autocomplete="off" placeholder="FTB Infinity Evolved"/>
          @if (name.invalid && name.touched) { <mat-error>Enter a name with 1 to 64 characters.</mat-error> }
        </mat-form-field>
        @if (error()) { <p class="error" role="alert">{{ error() }}</p> }
      </mat-dialog-content>
      <mat-dialog-actions align="end">
        <button type="button" mat-button (click)="dialog.close()" [disabled]="busy()">Cancel</button>
        <button type="submit" mat-flat-button [disabled]="busy() || name.invalid || !name.value.trim()">
          @if (busy()) { <mat-spinner diameter="16"/> }
          {{ data.mode === 'create' ? 'Create and switch' : 'Rename server' }}
        </button>
      </mat-dialog-actions>
    </form>
  `,
  styles: [`
    mat-dialog-content p { font-size: 13px; line-height: 1.7; margin: 0 0 22px; color: #b5bdb8; }
    mat-form-field { width: 100%; }
    mat-dialog-content .error { color: #e7aaa0; margin: 18px 0 0; }
    mat-dialog-actions { padding: 16px 24px 24px; gap: 6px; }
    mat-spinner { display: inline-block; margin-right: 8px; vertical-align: middle; }
  `],
})
export class ServerProfileDialogComponent {
  readonly data = inject<ServerProfileDialogData>(MAT_DIALOG_DATA);
  readonly dialog = inject(MatDialogRef<ServerProfileDialogComponent, boolean>);
  readonly name = new FormControl(this.data.name ?? '', { nonNullable: true, validators: [Validators.required, Validators.maxLength(64), Validators.pattern(/\S/)] });
  readonly busy = signal(false);
  readonly error = signal('');

  async submit(event: Event): Promise<void> {
    event.preventDefault();
    this.name.markAsTouched();
    if (this.busy() || this.name.invalid) return;
    this.busy.set(true);
    this.error.set('');
    this.name.disable();
    this.dialog.disableClose = true;
    try {
      await this.data.perform(this.name.value.trim());
      this.dialog.close(true);
    } catch (error) {
      this.error.set(errorMessage(error));
    } finally {
      this.busy.set(false);
      this.name.enable();
      this.dialog.disableClose = false;
    }
  }
}
