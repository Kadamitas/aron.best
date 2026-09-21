import { ChangeDetectionStrategy, Component, DestroyRef, TemplateRef, computed, inject, signal, viewChild } from '@angular/core';
import { DatePipe } from '@angular/common';
import { toSignal } from '@angular/core/rxjs-interop';
import { FormControl, ReactiveFormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatSnackBar } from '@angular/material/snack-bar';
import { MatTabsModule } from '@angular/material/tabs';
import { MatTooltipModule } from '@angular/material/tooltip';
import { MatDialog, MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatMenuModule } from '@angular/material/menu';
import { firstValueFrom } from 'rxjs';
import { AdvancedWorkshopComponent } from './advanced-workshop.component';
import { IconComponent } from './icon.component';
import { ConfirmDialogComponent, ConfirmDialogData } from './confirm-dialog.component';
import { ServerProfileDialogComponent, ServerProfileDialogData } from './server-profile-dialog.component';
import { ServerBackupDialogComponent, ServerBackupDialogData } from './server-backup-dialog.component';
import { ModAction, SavedServer, ServerAction, ServerTarget, WorkspaceMod, WorkshopApi, WorkshopStatus, downloadBlob, errorMessage, fileSize } from './workshop-api.service';

type LoaderChoice = Pick<ServerTarget, 'loader' | 'loaderVersion'>;
type ProfileOperation = { name: string; accepted: boolean } & ({ kind: 'create'; previousIds: Set<string> } | { kind: 'select'; targetId: string });

@Component({
  selector: 'app-workshop',
  imports: [AdvancedWorkshopComponent, DatePipe, ReactiveFormsModule, MatButtonModule, MatDialogModule, MatFormFieldModule, MatInputModule, MatMenuModule, MatProgressSpinnerModule, MatTabsModule, MatTooltipModule, IconComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './workshop.component.html',
  styleUrl: './workshop.component.scss',
})
export class WorkshopComponent {
  private readonly api = inject(WorkshopApi);
  private readonly destroyRef = inject(DestroyRef);
  private readonly snack = inject(MatSnackBar);
  private readonly dialog = inject(MatDialog);
  private addModDialog?: MatDialogRef<unknown>;
  private optionsRequest = 0;
  private statusRequest = 0;
  private modsRequest = 0;
  private logsRequest = 0;
  private profileGeneration = 0;
  private statusInFlight = 0;
  private lastStatusRefresh = 0;
  private createdFromProfiles?: Set<string>;
  private readonly advanced = viewChild(AdvancedWorkshopComponent);
  private readonly addModOpen = signal(false);

  readonly status = signal<WorkshopStatus | null>(null);
  readonly loading = signal(true);
  readonly connectionError = signal('');
  readonly busy = signal('');
  readonly profileOperation = signal<ProfileOperation | null>(null);
  readonly profileOperationError = signal('');
  readonly tab = signal(0);
  readonly serverMods = signal<WorkspaceMod[]>([]);
  readonly modsError = signal('');
  readonly uploadProgress = signal(0);
  readonly selectedMods = signal<File[]>([]);
  readonly addModError = signal('');
  readonly installationDraft = signal<ServerTarget | null>(null);
  readonly minecraftVersions = signal<string[]>([]);
  readonly loaderChoices = signal<LoaderChoice[]>([]);
  readonly optionsVersion = signal('');
  readonly optionsLoading = signal(false);
  readonly optionsError = signal('');
  readonly fileSize = fileSize;
  readonly search = new FormControl('', { nonNullable: true });
  private readonly localQuery = toSignal(this.search.valueChanges, { initialValue: '' });
  readonly logs = signal<string[]>([]);
  readonly logsLoading = signal(false);
  readonly logsError = signal('');
  readonly showCrashLog = signal(false);
  readonly filteredServerMods = computed(() => {
    const query = this.localQuery().trim().toLocaleLowerCase();
    return this.serverMods().filter(mod => !query || mod.name.toLocaleLowerCase().includes(query));
  });
  readonly enabledCount = computed(() => this.serverMods().filter(mod => mod.enabled).length);
  readonly authorized = computed(() => this.status()?.capabilities.authorized === true);
  readonly serverReady = computed(() => this.status()?.capabilities.server === true && this.authorized());
  readonly serverRunning = computed(() => ['running', 'online'].includes(this.status()?.server.state ?? ''));
  readonly serverTransitioning = computed(() => this.status()?.jobRunning === true || this.status()?.server.busy === true || ['starting', 'stopping', 'updating', 'restarting'].includes(this.status()?.server.state ?? ''));
  readonly activeProfile = computed(() => this.status()?.profiles?.profiles.find(profile => profile.id === this.status()?.profiles?.activeId));
  readonly workspaceId = computed(() => this.status()?.workspace?.profileId ?? this.status()?.profiles?.activeId);
  readonly workspaceProfile = computed(() => this.status()?.profiles?.profiles.find(profile => profile.id === this.workspaceId()));
  readonly workspaceServer = computed(() => this.status()?.workspace?.server ?? this.status()?.server);
  readonly workspaceTransitioning = computed(() => this.workspaceServer()?.busy === true || (!this.status()?.workspace && this.status()?.jobRunning === true) || ['starting', 'stopping', 'updating', 'restarting'].includes(this.workspaceServer()?.state ?? ''));
  readonly workspaceKeys = computed(() => [this.workspaceId() ?? 'default']);
  readonly workspaceLocked = computed(() => this.addModOpen() || this.advanced()?.navigationLocked() === true);
  readonly workspaceReady = computed(() => this.authorized() && !!this.status()?.profiles && !this.busy() && !this.profileOperation() && !this.workspaceLocked() && !this.connectionError());
  readonly profilesReady = computed(() => this.workspaceReady() && this.status()?.capabilities.workspaceWrite === true && !this.serverTransitioning() && !this.workspaceTransitioning());
  readonly canCreateProfile = computed(() => this.profilesReady() && (this.status()?.profiles?.profiles.length ?? 0) < (this.status()?.profiles?.limit ?? 5));
  readonly profileProgress = computed(() => {
    const operation = this.profileOperation();
    if (this.connectionError() || this.profileOperationError() || (!operation && this.status()?.server.profileError)) return '';
    if (operation) return operation.kind === 'create' ? `Creating ${operation.name}...` : `Setting ${operation.name} active...`;
    if (this.busy() === 'workspace:select') return 'Opening saved server...';
    return this.serverTransitioning() ? 'Server operation in progress...' : '';
  });
  readonly writable = computed(() => this.authorized() && this.status()?.capabilities.workspaceWrite === true && ['stopped', 'not-installed', 'failed'].includes(this.workspaceServer()?.state ?? '') && !this.workspaceTransitioning());
  readonly canAddMods = computed(() => this.authorized() && this.status()?.capabilities.workspaceWrite === true && !this.workspaceTransitioning() && ['running', 'online', 'stopped', 'not-installed', 'failed'].includes(this.workspaceServer()?.state ?? ''));
  readonly currentInstallation = computed<ServerTarget>(() => ({
    minecraftVersion: this.status()?.pack.minecraftVersion ?? '',
    loader: (this.status()?.pack.loader ?? 'Fabric') as ServerTarget['loader'],
    loaderVersion: this.status()?.pack.loaderVersion ?? '',
  }));
  readonly installation = computed(() => this.installationDraft() ?? this.currentInstallation());
  readonly installationDirty = computed(() => !this.sameInstallation(this.installation(), this.currentInstallation()));
  readonly installationValid = computed(() => this.optionsVersion() === this.installation().minecraftVersion && this.loaderChoices().some(choice => choice.loader === this.installation().loader && choice.loaderVersion === this.installation().loaderVersion));
  readonly writeHint = computed(() => !this.status()?.capabilities.workspaceWrite
    ? 'File changes are available when the isolated server is configured.'
    : this.workspaceTransitioning() ? 'Wait for this saved server to finish its current operation.' : 'You can add and download mods while this server runs. Stop it to replace, disable or uninstall mods, or edit its other files.');
  readonly downloadReady = computed(() => this.authorized() && !this.workspaceTransitioning());
  readonly downloadHint = computed(() => this.status()?.capabilities.workspaceWrite
    ? 'Selected server mods and configuration'
    : 'Download the modpack to play');
  readonly lastBackup = computed(() => {
    const value = this.status()?.server.lastBackup;
    if (!value) return null;
    const stamp = value.match(/^(\d{4}-\d{2}-\d{2}T\d{2})-(\d{2})-(\d{2}\.\d{3}Z)/);
    const normalized = stamp ? `${stamp[1]}:${stamp[2]}:${stamp[3]}` : value;
    return Number.isNaN(Date.parse(normalized)) ? null : normalized;
  });
  readonly playerCount = computed(() => {
    const players = this.status()?.server.players;
    if (!this.serverRunning()) return '0 players';
    if (players?.online == null) return 'Players unavailable';
    return players.max == null ? `${players.online} ${players.online === 1 ? 'player' : 'players'}` : `${players.online} / ${players.max} players`;
  });
  readonly playerNames = computed(() => {
    const players = this.status()?.server.players;
    if (!this.serverRunning() || players?.online === 0) return 'No players online';
    if (players?.online == null || !players.names?.length) return 'Player names unavailable';
    const names = players.names.slice(0, players.online);
    const missing = players.online - names.length;
    return [...names, ...(missing > 0 ? [`+ ${missing} more (names unavailable)`] : [])].join('\n');
  });
  readonly lastUpdated = computed(() => {
    const updatedAt = this.status()?.workspace?.updatedAt;
    if (!updatedAt || Number.isNaN(Date.parse(updatedAt))) return 'No changes recorded';
    return new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Chicago', month: 'short', day: 'numeric', year: 'numeric',
      hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
    }).format(new Date(updatedAt));
  });
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
      const interval = this.profileOperation() || this.serverTransitioning() ? 3_000 : 15_000;
      if (document.visibilityState === 'visible' && !this.busy() && !this.statusInFlight && this.profileOperation()?.accepted !== false && Date.now() - this.lastStatusRefresh >= interval) void this.refresh(false);
    }, 3_000);
    this.destroyRef.onDestroy(() => clearInterval(timer));
  }

  async refresh(showLoading = true): Promise<void> {
    const request = ++this.statusRequest;
    this.statusInFlight++;
    this.lastStatusRefresh = Date.now();
    if (showLoading) this.loading.set(true);
    try {
      let status = await this.api.status();
      if (request !== this.statusRequest) return;
      if (this.createdFromProfiles && status.profiles && !this.createdFromProfiles.has(status.profiles.activeId)) {
        this.createdFromProfiles = undefined;
        this.api.selectWorkspace(status.profiles.activeId);
        status = await this.api.status();
        if (request !== this.statusRequest) return;
      }
      if (status.server.profileError) this.createdFromProfiles = undefined;
      if ((status.workspace?.profileId ?? status.profiles?.activeId) !== this.workspaceId()) this.resetProfileView();
      if (status.profiles?.activeId !== this.status()?.profiles?.activeId) this.resetLogs();
      this.status.set(status);
      this.updateProfileOperation(status);
      if (this.installationDraft() && this.sameInstallation(this.installationDraft()!, this.currentInstallation())) this.installationDraft.set(null);
      this.connectionError.set('');
      if (status.capabilities.authorized) await Promise.all([this.loadLogs(true), this.loadServerMods()]);
    } catch (error) {
      if (request === this.statusRequest) {
        this.connectionError.set(errorMessage(error));
        this.profileOperation.set(null);
      }
    } finally {
      this.statusInFlight--;
      if (request === this.statusRequest) this.loading.set(false);
    }
  }

  async loadServerMods(): Promise<void> {
    const request = ++this.modsRequest;
    const generation = this.profileGeneration;
    try {
      const result = await this.api.workspaceMods(this.workspaceId());
      if (request !== this.modsRequest || generation !== this.profileGeneration) return;
      this.serverMods.set(result.mods);
      this.modsError.set('');
    } catch (error) { if (request === this.modsRequest && generation === this.profileGeneration) this.modsError.set(errorMessage(error)); }
  }

  async selectProfile(profile: SavedServer): Promise<void> {
    const current = this.workspaceId();
    if (!this.workspaceReady() || current === profile.id) return;
    if (this.installationDirty() && !await this.confirm({ title: 'Discard unsaved version changes?', description: 'Your Minecraft and loader choices have not been saved. Discard them to edit another saved server.', confirm: 'Discard and open' })) return;
    if (!this.workspaceReady() || current !== this.workspaceId()) return;
    this.busy.set('workspace:select');
    this.api.selectWorkspace(profile.id);
    try { await this.refresh(false); }
    finally { this.busy.set(''); }
  }

  async setActiveProfile(): Promise<void> {
    const current = this.activeProfile();
    const profile = this.workspaceProfile();
    if (!profile || !this.profilesReady() || current?.id === profile.id) return;
    const confirmed = await this.confirm({
      title: `Set ${profile.name} active?`,
      description: `${current?.name ?? 'The active server'} will stop safely and keep its world, mods and settings. ${profile.name} will become active with Minecraft ${profile.minecraftVersion} and ${profile.loader}, and will stay stopped until you start it.${this.installationDirty() ? ' Unsaved version choices will not be applied.' : ''}`,
      confirm: this.serverRunning() ? 'Stop and set active' : 'Set active',
    });
    if (!confirmed || !this.profilesReady() || current?.id !== this.activeProfile()?.id || profile.id !== this.workspaceId()) return;
    const operation: ProfileOperation = { kind: 'select', name: profile.name, targetId: profile.id, accepted: false };
    this.startProfileOperation(operation);
    this.busy.set('profile:select');
    try {
      await this.api.selectServerProfile(profile.id);
      this.statusRequest++;
      this.profileOperation.set({ ...operation, accepted: true });
      await this.refresh(false);
    } catch (error) {
      this.failProfileOperation(errorMessage(error));
    } finally { this.busy.set(''); }
  }

  async createProfile(): Promise<void> {
    if (!this.canCreateProfile()) return;
    const current = this.activeProfile();
    const installed = current ?? this.currentInstallation();
    const existing = new Set(this.status()?.profiles?.profiles.map(profile => profile.id));
    const accepted = await this.profileDialog({
      mode: 'create',
      description: `This will stop ${current?.name ?? 'the current server'} safely and keep all its files. The new server starts with Minecraft ${installed.minecraftVersion} and the latest compatible ${installed.loader} build, with a blank world, no mods and fresh settings. It becomes active after installation and stays stopped. You can then change its version and add a modpack.${this.installationDirty() ? ' Unsaved version changes will be discarded.' : ''}`,
      perform: async name => {
        if (!this.canCreateProfile() || current?.id !== this.activeProfile()?.id) throw new Error('The active server changed or is busy. Close this dialog and try again.');
        const operation: ProfileOperation = { kind: 'create', name, previousIds: existing, accepted: false };
        this.startProfileOperation(operation);
        try {
          await this.api.createServerProfile(name);
          this.statusRequest++;
          this.createdFromProfiles = existing;
          this.profileOperation.set({ ...operation, accepted: true });
        } catch (error) {
          this.failProfileOperation(errorMessage(error));
          throw error;
        }
      },
    });
    if (!accepted) return;
    await this.refresh(false);
  }

  async renameProfile(current = this.workspaceProfile()): Promise<void> {
    if (!current || !this.profilesReady()) return;
    const accepted = await this.profileDialog({
      mode: 'rename', name: current.name,
      description: 'Only the saved server name changes. Its world, mods and settings stay the same.',
      perform: async name => {
        if (!this.profilesReady() || !this.status()?.profiles?.profiles.some(profile => profile.id === current.id)) throw new Error('The saved server changed or is busy. Close this dialog and try again.');
        await this.api.renameServerProfile(current.id, name);
      },
    });
    if (accepted) await this.refresh(false);
  }

  async removeProfile(profile: SavedServer): Promise<void> {
    if (!this.profilesReady() || profile.id === this.activeProfile()?.id) return;
    if (!await this.confirm({ title: `Delete ${profile.name}?`, description: 'This removes the saved server, including its world, mods and settings, from the list and frees a server slot. Its files will be kept in recovery storage. The active server is not affected.', confirm: 'Delete saved server' })) return;
    if (!this.profilesReady() || profile.id === this.activeProfile()?.id) return;
    await this.perform('profile:remove', () => this.api.removeServerProfile(profile.id), 'Saved server deleted. Its files were kept in recovery storage.');
  }

  async loadInstallationOptions(version = this.installation().minecraftVersion, chooseLoader = false): Promise<void> {
    if (!version || !this.authorized()) return;
    if (!chooseLoader && this.optionsVersion() === version && this.loaderChoices().length) return;
    const request = ++this.optionsRequest;
    this.optionsLoading.set(true);
    this.optionsError.set('');
    try {
      const options = await this.api.serverVersions(version);
      if (request !== this.optionsRequest) return;
      this.minecraftVersions.set(options.versions);
      this.loaderChoices.set(options.loaders);
      this.optionsVersion.set(version);
      if (chooseLoader) {
        const selected = options.loaders.find(choice => choice.loader === this.installation().loader) ?? options.loaders[0];
        if (!selected) throw new Error(`No supported loaders are available for Minecraft ${version}.`);
        this.installationDraft.set({ minecraftVersion: version, ...selected });
      }
    } catch (error) {
      if (request === this.optionsRequest) this.optionsError.set(errorMessage(error));
    } finally {
      if (request === this.optionsRequest) this.optionsLoading.set(false);
    }
  }

  async chooseMinecraft(version: string): Promise<void> {
    if (version === this.installation().minecraftVersion || this.optionsLoading()) return;
    this.installationDraft.set({ ...this.installation(), minecraftVersion: version });
    await this.loadInstallationOptions(version, true);
  }

  chooseLoader(choice: LoaderChoice): void {
    const next = { ...this.installation(), ...choice };
    this.installationDraft.set(this.sameInstallation(next, this.currentInstallation()) ? null : next);
  }

  resetInstallation(): void {
    this.optionsRequest++;
    this.optionsLoading.set(false);
    this.installationDraft.set(null);
    this.optionsError.set('');
  }

  async saveInstallation(): Promise<void> {
    if (!this.installationDirty() || !this.installationValid() || !this.writable() || this.busy() || this.optionsLoading()) return;
    const current = this.currentInstallation();
    const next = this.installation();
    const profileId = this.workspaceId();
    const confirmed = await this.confirm({
      title: 'Change Minecraft and loader?',
      description: `Current: Minecraft ${current.minecraftVersion}, ${current.loader} ${current.loaderVersion}. Change to Minecraft ${next.minecraftVersion}, ${next.loader} ${next.loaderVersion}. The world and mods will be backed up and kept, but may be incompatible with the new version. The server will stay stopped.`,
      confirm: 'Back up and change',
    });
    if (!confirmed || !this.writable() || profileId !== this.workspaceId()) return;
    await this.perform('installation', () => this.api.saveServerInstallation(next, profileId), 'Version change started. This saved server will stay stopped.');
  }

  async changeMod(mod: WorkspaceMod, action: ModAction): Promise<void> {
    if (!this.writable()) return;
    const profileId = this.workspaceId();
    if (action === 'uninstall' && !await this.confirm({ title: 'Uninstall this mod?', description: `${mod.name} will be moved out of the mods folder into recovery storage.`, confirm: 'Uninstall' })) return;
    if (profileId !== this.workspaceId()) return;
    await this.perform(`mod:${mod.path}`, () => this.api.modAction(mod.path, action, profileId), action === 'uninstall' ? 'Mod moved to recovery storage.' : `Mod ${action === 'enable' ? 'enabled' : 'disabled'}.`);
  }

  openAddMod(template: TemplateRef<unknown>): void {
    if (!this.canAddMods() || this.busy()) return;
    this.selectedMods.set([]);
    this.addModError.set('');
    this.uploadProgress.set(0);
    this.addModDialog = this.dialog.open(template, { width: '480px', maxWidth: 'calc(100vw - 32px)' });
    this.addModOpen.set(true);
    this.addModDialog.afterClosed().subscribe(() => this.addModOpen.set(false));
  }

  chooseMods(event: Event): void {
    const input = event.target as HTMLInputElement;
    const files = Array.from(input.files ?? []);
    input.value = '';
    if (!files.length) return;
    if (files.some(file => !file.name.toLowerCase().endsWith('.jar'))) {
      this.addModError.set('Choose Minecraft mod files ending in .jar.');
      return;
    }
    if (files.some(file => file.size < 1 || file.size > 128 * 1024 * 1024)) {
      this.addModError.set('Each mod file must be between 1 byte and 128 MiB.');
      return;
    }
    this.selectedMods.set(files);
    this.addModError.set('');
  }

  async addMods(): Promise<void> {
    const files = this.selectedMods();
    if (!files.length || !this.canAddMods() || this.busy()) return;
    let installed = 0;
    const profileId = this.workspaceId();
    if (this.addModDialog) this.addModDialog.disableClose = true;
    const added = await this.perform('install', async () => {
      for (const file of files) {
        if (profileId !== this.workspaceId()) throw new Error('The selected workspace changed. Reopen Add mod on the selected server.');
        this.uploadProgress.set(0);
        await this.api.uploadWorkspaceFile(file, `mods/${file.name}`, false, value => this.uploadProgress.set(value), profileId);
        installed++;
      }
    }, `${files.length === 1 ? 'Mod' : 'Mods'} added. They will load the next time this server starts or restarts.`);
    if (this.addModDialog) this.addModDialog.disableClose = false;
    if (added) this.addModDialog?.close();
    else this.selectedMods.set(files.slice(installed));
    if (installed) await this.loadServerMods();
  }

  async act(action: ServerAction): Promise<void> {
    const profileId = this.activeProfile()?.id;
    const prompts: Partial<Record<ServerAction, ConfirmDialogData>> = {
      stop: { title: 'Stop the server?', description: 'Players will be disconnected after the world saves.', confirm: 'Stop server' },
      restart: { title: 'Restart the server?', description: 'Players will be disconnected while the world saves and restarts.', confirm: 'Restart server' },
    };
    const prompt = prompts[action];
    if (prompt && !await this.confirm(prompt)) return;
    if (profileId !== this.activeProfile()?.id) return;
    await this.perform(`server:${action}`, () => this.api.serverAction(action), `Server ${action} requested.`);
  }

  async backUp(): Promise<void> {
    const profile = this.activeProfile();
    if (!profile || !this.serverReady() || this.busy() || this.serverTransitioning() || this.connectionError()) return;
    await firstValueFrom(this.dialog.open<ServerBackupDialogComponent, ServerBackupDialogData, boolean>(ServerBackupDialogComponent, {
      width: '500px', maxWidth: 'calc(100vw - 32px)',
      data: {
        name: profile.name,
        profileId: profile.id,
        create: () => {
          if (profile.id !== this.activeProfile()?.id || !this.serverReady() || this.busy() || this.serverTransitioning() || this.connectionError()) throw new Error('The active server changed or is busy. Close this dialog and try again.');
          return this.api.createServerBackup(profile.id);
        },
      },
    }).afterClosed());
    if (!this.destroyRef.destroyed) await this.refresh(false);
  }

  async downloadPack(): Promise<void> {
    if (!this.downloadReady()) return;
    await this.perform('download', async () => {
      const archive = await this.api.downloadPack(this.workspaceId());
      downloadBlob(archive, 'dictionary-minecraft-server.zip');
    }, 'Modpack ZIP downloaded.');
  }

  async loadLogs(silent = false): Promise<void> {
    if (!this.authorized()) return;
    this.logsLoading.set(true);
    this.logsError.set('');
    const request = ++this.logsRequest;
    const generation = this.profileGeneration;
    try {
      const result = await this.api.logs();
      if (request !== this.logsRequest || generation !== this.profileGeneration) return;
      this.logs.set(result.lines);
    } catch (error) {
      if (!silent && request === this.logsRequest && generation === this.profileGeneration) this.logsError.set(errorMessage(error));
    } finally { if (request === this.logsRequest && generation === this.profileGeneration) this.logsLoading.set(false); }
  }

  async copyAddress(): Promise<void> {
    try {
      await navigator.clipboard.writeText(this.status()?.server.address || 'mc.aron.best');
      this.snack.open('Server address copied.', 'Got it', { duration: 3_000 });
    } catch { this.snack.open('Copy the server address shown above.', 'Got it', { duration: 5_000 }); }
  }

  private async perform(key: string, operation: () => Promise<unknown>, success: string): Promise<boolean> {
    if (this.busy()) return false;
    this.busy.set(key);
    try {
      await operation();
      this.snack.open(success, 'Got it', { duration: 4_500 });
      await this.refresh(false);
      return true;
    } catch (error) {
      this.snack.open(errorMessage(error), 'Dismiss', { duration: 9_000 });
      return false;
    } finally { this.busy.set(''); }
  }

  private sameInstallation(left: ServerTarget, right: ServerTarget): boolean {
    return left.minecraftVersion === right.minecraftVersion && left.loader === right.loader && left.loaderVersion === right.loaderVersion;
  }

  private startProfileOperation(operation: ProfileOperation): void {
    this.statusRequest++;
    this.profileOperationError.set('');
    this.profileOperation.set(operation);
  }

  private updateProfileOperation(status: WorkshopStatus): void {
    const operation = this.profileOperation();
    if (!operation?.accepted) return;
    if (status.server.profileError) {
      this.failProfileOperation(status.server.profileError);
      return;
    }
    if (status.server.busy || status.jobRunning) return;
    const activeId = status.profiles?.activeId;
    const completed = activeId && (operation.kind === 'create' ? !operation.previousIds.has(activeId) : activeId === operation.targetId);
    if (!completed) {
      this.failProfileOperation('The saved server change did not complete. Check the server log and try again.');
      return;
    }
    this.profileOperation.set(null);
    this.snack.open(operation.kind === 'create' ? `${operation.name} is ready. Start it when you are ready to play.` : `${operation.name} is active and stopped.`, 'Got it', { duration: 4_500 });
  }

  private failProfileOperation(message: string): void {
    this.profileOperation.set(null);
    this.createdFromProfiles = undefined;
    this.profileOperationError.set(message);
  }

  private resetProfileView(): void {
    this.profileGeneration++;
    this.modsRequest++;
    this.resetInstallation();
    this.minecraftVersions.set([]);
    this.loaderChoices.set([]);
    this.optionsVersion.set('');
    this.serverMods.set([]);
    this.modsError.set('');
    this.search.setValue('');
    this.addModDialog?.close();
    this.selectedMods.set([]);
  }

  private resetLogs(): void {
    this.logsRequest++;
    this.logs.set([]);
    this.logsError.set('');
    this.logsLoading.set(false);
    this.showCrashLog.set(false);
  }

  private profileDialog(data: ServerProfileDialogData): Promise<boolean | undefined> {
    return firstValueFrom(this.dialog.open<ServerProfileDialogComponent, ServerProfileDialogData, boolean>(ServerProfileDialogComponent, {
      data, width: '500px', maxWidth: 'calc(100vw - 32px)',
    }).afterClosed());
  }

  private confirm(data: ConfirmDialogData): Promise<boolean | undefined> {
    return firstValueFrom(this.dialog.open<ConfirmDialogComponent, ConfirmDialogData, boolean>(ConfirmDialogComponent, {
      data, width: '460px', maxWidth: 'calc(100vw - 32px)',
    }).afterClosed());
  }
}
