import { ChangeDetectionStrategy, Component, DestroyRef, computed, effect, inject, input, output, signal, untracked } from '@angular/core';
import { FormControl, ReactiveFormsModule } from '@angular/forms';
import { toSignal } from '@angular/core/rxjs-interop';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatMenuModule } from '@angular/material/menu';
import { MatDialog, MatDialogRef } from '@angular/material/dialog';
import { MatSnackBar } from '@angular/material/snack-bar';
import { firstValueFrom } from 'rxjs';
import { ConfirmDialogComponent, ConfirmDialogData } from './confirm-dialog.component';
import { IconComponent } from './icon.component';
import { WorkspaceEntryDialogComponent, WorkspaceEntryDialogData } from './workspace-entry-dialog.component';
import { WorkspaceEditorDialogComponent } from './workspace-editor-dialog.component';
import { WorkspaceFile, WorkspaceText, WorkshopApi, WorkshopStatus, downloadBlob, errorMessage, fileSize } from './workshop-api.service';

interface FileEntry { path: string; name: string; directory: boolean; file?: WorkspaceFile; }
interface FolderNode extends FileEntry { depth: number; hasChildren: boolean; expanded: boolean; }

@Component({
  selector: 'app-advanced-workshop',
  imports: [ReactiveFormsModule, MatButtonModule, MatFormFieldModule, MatInputModule, MatProgressBarModule, MatProgressSpinnerModule, MatMenuModule, IconComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './advanced-workshop.component.html',
  styleUrl: './advanced-workshop.component.scss',
})
export class AdvancedWorkshopComponent {
  readonly status = input.required<WorkshopStatus>();
  readonly changed = output<void>();
  private readonly api = inject(WorkshopApi);
  private readonly dialog = inject(MatDialog);
  private readonly snack = inject(MatSnackBar);
  private readonly destroyRef = inject(DestroyRef);
  private editor?: WorkspaceEditorDialogComponent;
  private profileId?: string;
  private profileBound = false;
  private readonly active = signal(true);
  private readonly closeDialogs = new Set<() => void>();
  private readonly openDialogCount = signal(0);
  private readonly uploads = new AbortController();

  readonly roots = ['config', 'defaultconfigs', 'mods', 'kubejs', 'scripts', 'datapacks', 'resourcepacks', 'shaderpacks', 'world/serverconfig'];
  readonly files = signal<WorkspaceFile[]>([]);
  readonly directories = signal<Array<{ path: string; name: string }>>([]);
  readonly directory = signal('config');
  readonly expanded = signal(new Set(['config']));
  readonly loading = signal(false);
  readonly busy = signal('');
  readonly error = signal('');
  readonly truncated = signal(false);
  readonly dragging = signal(false);
  readonly search = new FormControl('', { nonNullable: true });
  readonly uploadProgress = signal(0);
  readonly uploadLabel = signal('');
  readonly fileSize = fileSize;
  private readonly query = toSignal(this.search.valueChanges, { initialValue: '' });

  readonly workspaceServer = computed(() => this.status().workspace?.server ?? this.status().server);
  readonly writable = computed(() => this.active() && this.status().capabilities.authorized && this.status().capabilities.workspaceWrite === true && ['stopped', 'not-installed', 'failed'].includes(this.workspaceServer().state) && !this.workspaceServer().busy && (!!this.status().workspace || !this.status().jobRunning));
  readonly navigationLocked = computed(() => !!this.busy() || this.openDialogCount() > 0);
  readonly folderPaths = computed(() => {
    const paths = new Set(this.roots);
    for (const path of [...this.directories().map(folder => folder.path), ...this.files().map(file => this.parent(file.path))]) {
      const root = this.roots.find(root => path === root || path.startsWith(`${root}/`));
      if (!root) continue;
      let current = root;
      for (const part of path.slice(root.length).split('/').filter(Boolean)) { current += `/${part}`; paths.add(current); }
    }
    return [...paths].sort((left, right) => left.localeCompare(right));
  });
  readonly folderTree = computed<FolderNode[]>(() => {
    const result: FolderNode[] = [];
    const paths = this.folderPaths();
    const visit = (path: string, depth: number) => {
      const children = paths.filter(candidate => this.parent(candidate) === path);
      const expanded = this.expanded().has(path);
      result.push({ path, name: this.roots.includes(path) ? path : this.name(path), directory: true, depth, hasChildren: children.length > 0, expanded });
      if (expanded) children.forEach(child => visit(child, depth + 1));
    };
    this.roots.forEach(root => visit(root, 0));
    return result;
  });
  readonly breadcrumbs = computed(() => {
    const root = this.roots.find(root => this.directory() === root || this.directory().startsWith(`${root}/`)) ?? 'config';
    const crumbs = [{ name: root, path: root }];
    let path = root;
    for (const name of this.directory().slice(root.length).split('/').filter(Boolean)) { path += `/${name}`; crumbs.push({ name, path }); }
    return crumbs;
  });
  readonly entries = computed<FileEntry[]>(() => {
    const query = this.query().trim().toLocaleLowerCase();
    const entries: FileEntry[] = [];
    for (const path of this.folderPaths()) if (query ? path.toLocaleLowerCase().includes(query) : this.parent(path) === this.directory()) entries.push({ path, name: query ? path : this.name(path), directory: true });
    for (const file of this.files()) if (query ? file.path.toLocaleLowerCase().includes(query) : this.parent(file.path) === this.directory()) entries.push({ path: file.path, name: query ? file.path : file.name, directory: false, file });
    return entries.sort((left, right) => Number(right.directory) - Number(left.directory) || left.name.localeCompare(right.name));
  });

  constructor() {
    effect(() => {
      const status = this.status();
      untracked(() => {
        const profileId = status.workspace?.profileId ?? status.profiles?.activeId;
        if (!this.profileBound) { this.profileId = profileId; this.profileBound = true; }
        if (this.profileId !== profileId) { this.invalidate(); return; }
        if (status.capabilities.authorized) void this.refresh();
      });
    });
    const beforeUnload = (event: BeforeUnloadEvent) => { if (this.editor?.dirty() || this.busy() === 'upload') { event.preventDefault(); event.returnValue = ''; } };
    window.addEventListener('beforeunload', beforeUnload);
    this.destroyRef.onDestroy(() => { this.invalidate(); window.removeEventListener('beforeunload', beforeUnload); });
  }

  async refresh(): Promise<void> {
    if (this.loading() || !this.active()) return;
    this.loading.set(true);
    try {
      const result = await this.api.workspaceFiles(this.profileId);
      if (!this.active()) return;
      this.files.set(result.files);
      this.directories.set(result.directories ?? []);
      this.truncated.set(result.truncated);
      if (!this.folderPaths().includes(this.directory())) this.navigate(this.roots.find(root => this.directory().startsWith(`${root}/`)) ?? 'config');
    } catch (error) { if (this.active()) this.error.set(errorMessage(error)); }
    finally { this.loading.set(false); }
  }

  navigate(path: string): void {
    this.directory.set(path);
    this.search.setValue('');
    const expanded = new Set(this.expanded());
    for (const folder of this.folderPaths()) if (path === folder || path.startsWith(`${folder}/`)) expanded.add(folder);
    this.expanded.set(expanded);
  }

  toggleFolder(path: string, event?: Event): void {
    event?.stopPropagation();
    const expanded = new Set(this.expanded());
    if (expanded.has(path)) expanded.delete(path); else expanded.add(path);
    this.expanded.set(expanded);
  }

  folderKey(event: KeyboardEvent, folder: FolderNode): void {
    const rows = Array.from((event.currentTarget as HTMLElement).parentElement!.querySelectorAll<HTMLElement>('[role="treeitem"]'));
    const index = rows.indexOf(event.currentTarget as HTMLElement);
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      rows[Math.max(0, Math.min(rows.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)))]?.focus();
    } else if (event.key === 'ArrowRight') {
      event.preventDefault();
      if (folder.hasChildren && !folder.expanded) this.toggleFolder(folder.path); else if (folder.hasChildren) rows[index + 1]?.focus();
    } else if (event.key === 'ArrowLeft') {
      event.preventDefault();
      if (folder.expanded && folder.hasChildren) this.toggleFolder(folder.path);
      else rows.find(row => row.dataset['path'] === this.parent(folder.path))?.focus();
    } else if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); this.navigate(folder.path); }
    else this.menuKey(event);
  }

  menuKey(event: KeyboardEvent): void {
    if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return;
    event.preventDefault();
    event.stopPropagation();
    const target = event.currentTarget as HTMLElement;
    const bounds = target.getBoundingClientRect();
    target.dispatchEvent(new MouseEvent('contextmenu', { cancelable: true, clientX: bounds.left + 24, clientY: bounds.top + Math.min(bounds.height, 40), button: 0 }));
  }

  fixed(entry: FileEntry): boolean { return entry.directory && this.roots.includes(entry.path); }

  async open(entry: FileEntry): Promise<void> {
    if (entry.directory) this.navigate(entry.path);
    else if (entry.file?.text) await this.openText(entry.path);
    else if (entry.file) await this.download(entry.file);
  }

  async openText(path: string): Promise<void> {
    if (this.busy() || !this.active()) return;
    this.busy.set('open');
    this.error.set('');
    try { const file = await this.api.workspaceText(path, this.profileId); if (this.active()) this.editText(file); }
    catch (error) { if (this.active()) this.error.set(errorMessage(error)); }
    finally { this.busy.set(''); }
  }

  private editText(file: WorkspaceText): void {
    if (!this.active()) return;
    const reference = this.trackDialog(this.dialog.open(WorkspaceEditorDialogComponent, { data: { file, profileId: this.profileId, writable: () => this.writable(), saved: async () => { if (!this.active()) return; await this.refresh(); this.changed.emit(); } }, width: '1000px', maxWidth: 'calc(100vw - 24px)', maxHeight: 'calc(100dvh - 24px)', disableClose: true }));
    this.editor = reference.componentInstance;
    reference.afterClosed().subscribe(() => { this.editor = undefined; });
  }

  async create(kind: 'file' | 'folder'): Promise<void> {
    if (!this.writable() || this.busy()) return;
    const path = await this.entryDialog({ mode: kind === 'folder' ? 'create-folder' : 'create-file', path: this.directory(), folders: this.folderPaths(), perform: async path => {
      this.assertWritable();
      if (this.files().some(file => file.path === path) || this.folderPaths().includes(path)) throw new Error('That name is already used in this folder. Choose another name.');
      if (kind === 'folder') await this.api.createWorkspaceDirectory(path, this.profileId);
    } });
    if (!path || !this.active()) return;
    if (kind === 'file') this.editText({ path, name: this.name(path), contents: '', revision: 'new', modifiedAt: new Date().toISOString(), size: 0, text: true });
    else { await this.refresh(); this.navigate(path); this.changed.emit(); this.snack.open('Folder created.', 'Got it', { duration: 3000 }); }
  }

  async changeEntry(entry: FileEntry, mode: 'rename' | 'move' | 'delete'): Promise<void> {
    if (!this.writable() || this.busy() || this.fixed(entry)) return;
    const destination = await this.entryDialog({ mode, path: entry.path, directory: entry.directory, folders: this.folderPaths(), perform: async destination => {
      this.assertWritable();
      if (mode === 'delete') await this.api.removeWorkspaceEntry(entry.path, this.profileId);
      else await this.api.moveWorkspaceEntry(entry.path, destination, this.profileId);
    } });
    if (!destination || !this.active()) return;
    if (entry.directory && (this.directory() === entry.path || this.directory().startsWith(`${entry.path}/`))) this.navigate(mode === 'delete' ? this.parent(entry.path) : destination + this.directory().slice(entry.path.length));
    await this.refresh();
    this.changed.emit();
    this.snack.open(`${entry.directory ? 'Folder' : 'File'} ${mode === 'delete' ? 'deleted' : mode === 'move' ? 'moved' : 'renamed'}.`, 'Got it', { duration: 3000 });
  }

  private async entryDialog(data: WorkspaceEntryDialogData): Promise<string | undefined> {
    return firstValueFrom(this.trackDialog(this.dialog.open<WorkspaceEntryDialogComponent, WorkspaceEntryDialogData, string>(WorkspaceEntryDialogComponent, { data, width: '480px', maxWidth: 'calc(100vw - 24px)', maxHeight: 'calc(100dvh - 24px)' })).afterClosed());
  }

  private assertWritable(): void { if (!this.writable()) throw new Error('Stop the server before changing files.'); }
  private parent(path: string): string { return path.slice(0, path.lastIndexOf('/')); }
  private name(path: string): string { return path.split('/').at(-1)!; }

  async download(file: WorkspaceFile): Promise<void> {
    if (this.busy() || !this.active()) return;
    this.busy.set('download');
    this.error.set('');
    try { const blob = await this.api.downloadWorkspaceFile(file.path, this.profileId); if (this.active()) downloadBlob(blob, file.name); }
    catch (error) { if (this.active()) this.error.set(errorMessage(error)); }
    finally { this.busy.set(''); }
  }

  chooseFiles(event: Event): void { const input = event.target as HTMLInputElement; const files = Array.from(input.files ?? []); input.value = ''; void this.upload(files); }

  dragOver(event: DragEvent): void {
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = this.writable() && !this.busy() ? 'copy' : 'none';
    this.dragging.set(this.writable() && !this.busy());
  }

  drop(event: DragEvent): void { event.preventDefault(); this.dragging.set(false); void this.upload(Array.from(event.dataTransfer?.files ?? [])); }

  private async upload(files: File[]): Promise<void> {
    if (!files.length || !this.writable() || this.busy()) return;
    const folder = this.directory();
    const existing = files.filter(file => this.files().some(existing => existing.path === `${folder}/${file.name}`));
    if (existing.length && !await this.confirm({ title: `Replace ${existing.length === 1 ? 'this file' : 'these files'}?`, description: `${existing.map(file => file.name).join(', ')} already ${existing.length === 1 ? 'exists' : 'exist'} in ${folder}. The uploaded ${existing.length === 1 ? 'file will replace it' : 'files will replace them'}.`, confirm: 'Replace files' })) return;
    if (!this.writable()) return;
    this.busy.set('upload');
    this.error.set('');
    let completed = 0;
    try {
      for (const file of files) {
        this.uploads.signal.throwIfAborted();
        this.uploadLabel.set(`${completed + 1} / ${files.length} · ${file.name}`);
        this.uploadProgress.set(0);
        await this.api.uploadWorkspaceFile(file, `${folder}/${file.name}`, existing.includes(file), value => { if (this.active()) this.uploadProgress.set(value); }, this.profileId, this.uploads.signal);
        completed++;
      }
      if (this.active()) this.snack.open(`${completed} ${completed === 1 ? 'file' : 'files'} uploaded to ${folder}.`, 'Got it', { duration: 3500 });
    } catch (error) { if (this.active()) this.error.set(`${completed ? `${completed} uploaded. ` : ''}${errorMessage(error)}`); }
    finally { this.busy.set(''); this.uploadLabel.set(''); if (this.active()) { await this.refresh(); if (completed) this.changed.emit(); } }
  }

  private async confirm(data: ConfirmDialogData): Promise<boolean> {
    return await firstValueFrom(this.trackDialog(this.dialog.open<ConfirmDialogComponent, ConfirmDialogData, boolean>(ConfirmDialogComponent, { data, width: '440px', maxWidth: 'calc(100vw - 32px)' })).afterClosed()) === true && this.active();
  }

  private trackDialog<T, R>(reference: MatDialogRef<T, R>): MatDialogRef<T, R> {
    const close = () => reference.close();
    this.closeDialogs.add(close);
    this.openDialogCount.set(this.closeDialogs.size);
    reference.afterClosed().subscribe(() => { this.closeDialogs.delete(close); this.openDialogCount.set(this.closeDialogs.size); });
    return reference;
  }

  private invalidate(): void {
    this.active.set(false);
    this.uploads.abort();
    for (const close of this.closeDialogs) close();
    this.closeDialogs.clear();
  }
}
