import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { MAT_DIALOG_DATA, MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatButtonModule } from '@angular/material/button';

export interface ConfirmDialogData { title: string; description: string; confirm: string; }

@Component({
  selector: 'app-confirm-dialog',
  imports: [MatDialogModule, MatButtonModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <h2 mat-dialog-title>{{ data.title }}</h2>
    <mat-dialog-content><p>{{ data.description }}</p></mat-dialog-content>
    <mat-dialog-actions align="end">
      <button mat-button (click)="dialog.close(false)">Cancel</button>
      <button mat-flat-button (click)="dialog.close(true)">{{ data.confirm }}</button>
    </mat-dialog-actions>
  `,
  styles: [`mat-dialog-content p{line-height:1.7;margin-bottom:12px}mat-dialog-actions{padding:16px 24px 24px}`],
})
export class ConfirmDialogComponent {
  readonly data = inject<ConfirmDialogData>(MAT_DIALOG_DATA);
  readonly dialog = inject(MatDialogRef<ConfirmDialogComponent, boolean>);
}
