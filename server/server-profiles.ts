import { randomUUID } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import { lstat, mkdir, open, readdir, realpath, rename, rmdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { readInstalled, type ServerTarget } from './loader-installation.js';

const idSchema = z.string().uuid();
const nameSchema = z.string().trim().min(1).max(64).regex(/^[^\x00-\x1f\x7f]+$/);
const targetSchema = z.object({ minecraftVersion: z.string().regex(/^[0-9][A-Za-z0-9.+-]{0,79}$/), loader: z.enum(['Fabric', 'Forge', 'NeoForge', 'Quilt']), loaderVersion: z.string().regex(/^[0-9][A-Za-z0-9.+-]{0,79}$/) });
const storedProfileSchema = z.object({ id: idSchema, name: nameSchema, location: z.enum(['legacy', 'managed']) }).strict();
const deletedProfileSchema = storedProfileSchema.extend({ ...targetSchema.shape, removedAt: z.iso.datetime() }).strict();
const moveSchema = z.enum(['runtime', 'minecraft', 'backups', 'installation-snapshots']);
const registrySchema = z.object({ version: z.literal(1), activeId: idSchema, bindingRequired: z.boolean().default(false), profiles: z.array(storedProfileSchema).min(1).max(5) }).strict().superRefine((registry, context) => {
  if (new Set(registry.profiles.map(profile => profile.id)).size !== registry.profiles.length || !registry.profiles.some(profile => profile.id === registry.activeId) || registry.profiles.filter(profile => profile.location === 'legacy').length > 1) context.addIssue({ code: 'custom', message: 'Invalid server profile registry.' });
});
const journalSchema = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('create'), profile: storedProfileSchema, phase: z.enum(['provisioning', 'ready']) }).strict(),
  z.object({ operation: z.literal('delete'), profile: storedProfileSchema, moves: z.array(moveSchema).min(1).max(3) }).strict(),
  z.object({ operation: z.literal('restore'), profile: storedProfileSchema, moves: z.array(moveSchema).min(1).max(3) }).strict(),
]);
type StoredProfile = z.infer<typeof storedProfileSchema>;
type Registry = z.infer<typeof registrySchema>;
type Journal = z.infer<typeof journalSchema>;
type DeletedProfile = z.infer<typeof deletedProfileSchema>;
type ProfileMove = z.infer<typeof moveSchema>;
export interface ServerProfile extends ServerTarget { id: string; name: string }
export interface DeletedServerProfile extends ServerProfile { removedAt: string }
export interface ServerProfilesDependencies { rename: typeof rename }

export class ServerProfilesError extends Error {
  constructor(message: string, readonly statusCode = 409) { super(message); }
}

function missing(error: unknown): boolean { return (error as NodeJS.ErrnoException).code === 'ENOENT'; }
function regular(info: Stats): void {
  if (!info.isFile() || info.nlink !== 1) throw new ServerProfilesError('Server profile files cannot be symbolic links or hard links.');
}
async function inspect(candidate: string): Promise<Stats | undefined> {
  return lstat(candidate).catch(error => { if (missing(error)) return undefined; throw error; });
}

export class ServerProfiles {
  private root: string;
  private registry?: Registry;
  private pending: Promise<void> = Promise.resolve();
  private changing = false;
  private readonly descriptions = new Map<string, ServerProfile>();
  private removedDescriptions: DeletedServerProfile[] = [];
  private readonly fallback: ServerTarget;
  private readonly dependencies: ServerProfilesDependencies;

  constructor(options: { directory: string; fallbackTarget: ServerTarget }, dependencies: Partial<ServerProfilesDependencies> = {}) {
    this.root = path.resolve(options.directory);
    if (this.root === path.parse(this.root).root) throw new ServerProfilesError('Use a dedicated server runtime directory.');
    this.fallback = targetSchema.parse(options.fallbackTarget);
    this.dependencies = { rename, ...dependencies };
  }

  async initialize(): Promise<void> {
    return this.exclusive(async () => {
      if (this.registry) return;
      await mkdir(this.root, { recursive: true, mode: 0o700 });
      await this.assertDirectory(this.root);
      this.root = await realpath(this.root);
      const stored = await this.readJson(this.registryPath());
      if (stored === undefined) {
        if (await inspect(this.journalPath())) throw new ServerProfilesError('A profile operation was interrupted and its registry is missing. Restore the registry before starting a server.', 503);
        const managed = await inspect(this.managedPath());
        if (managed) {
          await this.assertDirectory(this.managedPath());
          if ((await readdir(this.managedPath())).length) throw new ServerProfilesError('Saved server folders exist without a registry. Restore the registry before starting a server.', 503);
        }
        const profile: StoredProfile = { id: randomUUID(), name: 'Main server', location: 'legacy' };
        const registry: Registry = { version: 1, activeId: profile.id, bindingRequired: false, profiles: [profile] };
        const minecraft = path.join(this.root, 'minecraft');
        if (!await inspect(minecraft)) await mkdir(minecraft, { mode: 0o700 });
        await this.assertDirectory(minecraft);
        await this.writeJson(this.registryPath(), registry);
        this.registry = registry;
      } else {
        this.registry = this.parseRegistry(stored);
      }
      try {
        await this.recover();
        await this.validateRuntime(this.activeDirectory(), false);
        for (const profile of this.state().profiles) this.descriptions.set(profile.id, await this.describe(profile));
        this.removedDescriptions = await this.readRemovedProfiles();
      } catch (error) { this.registry = undefined; throw error; }
    });
  }

  activeId(): string { return this.state().activeId; }
  requiresProfileBinding(): boolean { return this.state().bindingRequired; }
  activeDirectory(): string { return this.directoryFor(this.activeId()); }

  directoryFor(id: string): string {
    const profile = this.profile(id);
    return profile.location === 'legacy' ? this.root : path.join(this.managedPath(), profile.id);
  }

  async list(refresh = true): Promise<{ activeId: string; profiles: ServerProfile[]; limit: 5 }> {
    const state = this.state();
    if (refresh && !this.changing) {
      try {
        const descriptions = await Promise.all(state.profiles.map(profile => this.describe(profile)));
        if (this.registry === state) for (const profile of descriptions) this.descriptions.set(profile.id, profile);
      } catch (error) { if (!this.changing && this.registry === state) throw error; }
    }
    const current = this.state();
    const profiles = current.profiles.map(profile => {
      const description = this.descriptions.get(profile.id);
      if (!description) throw new ServerProfilesError('Saved server metadata is not ready.', 503);
      return { ...description, name: profile.name };
    });
    return { activeId: current.activeId, profiles, limit: 5 };
  }

  async listRemoved(): Promise<DeletedServerProfile[]> {
    const state = this.state();
    if (!this.changing) {
      try {
        const profiles = await this.readRemovedProfiles();
        if (this.registry === state && !this.changing) this.removedDescriptions = profiles;
      } catch (error) { if (!this.changing && this.registry === state) throw error; }
    }
    return this.removedDescriptions.map(profile => ({ ...profile }));
  }

  async recoveryDirectoryFor(id: string): Promise<string> {
    if (!idSchema.safeParse(id).success) throw new ServerProfilesError('Choose a saved server.', 404);
    if (this.state().profiles.some(profile => profile.id === id)) {
      const directory = this.directoryFor(id);
      await this.validateRuntime(directory, false);
      return directory;
    }
    const profile = await this.readRemovedProfile(id);
    if (!profile) throw new ServerProfilesError('That deleted server does not exist.', 404);
    return this.removedDirectory(profile);
  }

  async restore(id: string): Promise<ServerProfile> {
    return this.exclusive(async () => {
      if (!idSchema.safeParse(id).success) throw new ServerProfilesError('Choose a deleted server.', 404);
      const state = this.state();
      await this.assertNoJournal();
      if (state.profiles.some(profile => profile.id === id)) throw new ServerProfilesError('That server is already restored.');
      if (state.profiles.length >= 5) throw new ServerProfilesError('All five server slots are in use. Delete an inactive server before restoring another.');
      const removed = await this.readRemovedProfile(id);
      if (!removed) throw new ServerProfilesError('That deleted server does not exist.', 404);
      const profile: StoredProfile = { id, name: removed.name, location: removed.location };
      if (profile.location === 'legacy' && state.profiles.some(candidate => candidate.location === 'legacy')) throw new ServerProfilesError('The original server location is already in use.');
      await this.assertTree(this.removedDirectory(removed));
      const moves: ProfileMove[] = profile.location === 'managed' ? ['runtime'] : [];
      if (profile.location === 'managed') await this.ensureDirectory(this.managedPath());
      else for (const name of ['minecraft', 'backups', 'installation-snapshots'] as const) if (await inspect(path.join(this.bundlePath(id), name))) moves.push(name);
      for (const move of moves) if (await inspect(this.moveSource(profile, move))) throw new ServerProfilesError('A recovery destination already exists. Both copies were preserved.', 503);
      await this.writeJson(this.journalPath(), { operation: 'restore', profile, moves });
      try {
        for (const move of moves) await this.moveDirectory(path.join(this.bundlePath(id), move), this.moveSource(profile, move));
        const description = await this.describe(profile);
        this.descriptions.set(id, description);
        await this.save({ ...state, bindingRequired: true, profiles: [...state.profiles, profile] });
        await this.cleanBundle(id);
        await this.clearJournal();
        this.removedDescriptions = this.removedDescriptions.filter(candidate => candidate.id !== id);
        return description;
      } catch (error) {
        await this.reloadAndRecover();
        if (this.state().profiles.some(candidate => candidate.id === id)) return this.describe(profile);
        throw error;
      }
    });
  }

  async create(name: string, provision: (runtimeDirectory: string) => Promise<void>): Promise<ServerProfile> {
    return this.exclusive(async () => {
      const state = this.state();
      const parsedName = this.name(name);
      await this.assertNoJournal();
      if (state.profiles.length >= 5) throw new ServerProfilesError('All five server slots are in use. Delete an inactive server before adding another.');
      await this.ensureDirectory(this.managedPath());
      const profile: StoredProfile = { id: randomUUID(), name: parsedName, location: 'managed' };
      const directory = path.join(this.managedPath(), profile.id);
      const journal: Journal = { operation: 'create', profile, phase: 'provisioning' };
      await this.writeJson(this.journalPath(), journal);
      try {
        await mkdir(directory, { mode: 0o700 });
        await this.syncDirectory(this.managedPath());
        await provision(directory);
        await this.validateRuntime(directory, true);
        const description = await this.describe(profile);
        await this.writeJson(this.journalPath(), { ...journal, phase: 'ready' });
        this.descriptions.set(profile.id, description);
        await this.save({ ...state, bindingRequired: true, profiles: [...state.profiles, profile] });
        await this.clearJournal();
        return description;
      } catch (error) {
        await this.reloadAndRecover();
        if (this.state().profiles.some(candidate => candidate.id === profile.id)) return this.describe(profile);
        throw error;
      }
    });
  }

  async select(id: string): Promise<void> {
    return this.exclusive(async () => {
      const profile = this.profile(id);
      await this.assertNoJournal();
      await this.validateRuntime(this.directoryFor(profile.id), true);
      if (id === this.activeId()) return;
      await this.save({ ...this.state(), activeId: id, bindingRequired: true });
    });
  }

  async rename(id: string, name: string): Promise<void> {
    return this.exclusive(async () => {
      this.profile(id);
      const parsedName = this.name(name);
      await this.assertNoJournal();
      await this.save({ ...this.state(), profiles: this.state().profiles.map(profile => profile.id === id ? { ...profile, name: parsedName } : profile) });
    });
  }

  async remove(id: string): Promise<void> {
    return this.exclusive(async () => {
      const profile = this.profile(id);
      const state = this.state();
      if (state.profiles.length === 1) throw new ServerProfilesError('Keep at least one saved server.');
      if (state.activeId === id) throw new ServerProfilesError('Switch to another server before deleting this one.');
      await this.assertNoJournal();
      const directory = this.directoryFor(id);
      await this.validateRuntime(directory, true, profile.location === 'legacy');
      const moves: Array<'runtime' | 'minecraft' | 'backups' | 'installation-snapshots'> = profile.location === 'managed' ? ['runtime'] : [];
      if (profile.location === 'legacy') for (const name of ['minecraft', 'backups', 'installation-snapshots'] as const) if (await inspect(path.join(this.root, name))) moves.push(name);
      const description = await this.describe(profile);
      const journal: Journal = { operation: 'delete', profile, moves };
      await this.writeJson(this.journalPath(), journal);
      try {
        await this.ensureDirectory(this.deletedPath());
        const bundle = this.bundlePath(id);
        await mkdir(bundle, { mode: 0o700 });
        await this.syncDirectory(this.deletedPath());
        await this.writeJson(path.join(bundle, 'profile.json'), { ...description, removedAt: new Date().toISOString(), location: profile.location });
        for (const move of moves) await this.moveDirectory(this.moveSource(profile, move), path.join(bundle, move));
        await this.save({ ...state, profiles: state.profiles.filter(candidate => candidate.id !== id) });
        await this.clearJournal();
        this.removedDescriptions = await this.readRemovedProfiles();
      } catch (error) {
        await this.reloadAndRecover();
        if (!this.state().profiles.some(candidate => candidate.id === id)) return;
        throw error;
      }
    });
  }

  private async recover(): Promise<void> {
    const stored = await this.readJson(this.journalPath());
    if (stored === undefined) return;
    const result = journalSchema.safeParse(stored);
    if (!result.success) throw new ServerProfilesError('The saved profile operation is invalid. Preserve it and restore from a verified backup.', 503);
    const journal = result.data;
    if (journal.operation === 'create') await this.recoverCreate(journal);
    else if (journal.operation === 'delete') await this.recoverDelete(journal);
    else await this.recoverRestore(journal);
    await this.clearJournal();
  }

  private async recoverCreate(journal: Extract<Journal, { operation: 'create' }>): Promise<void> {
    if (journal.profile.location !== 'managed') throw new ServerProfilesError('An interrupted profile creation has an invalid location.', 503);
    const state = this.state();
    const existing = state.profiles.find(profile => profile.id === journal.profile.id);
    const directory = path.join(this.managedPath(), journal.profile.id);
    if (existing) {
      if (journal.phase !== 'ready' || existing.location !== 'managed' || existing.name !== journal.profile.name) throw new ServerProfilesError('The interrupted creation does not match the server registry.', 503);
      await this.validateRuntime(directory, true);
      this.descriptions.set(journal.profile.id, await this.describe(journal.profile));
      return;
    }
    if (journal.phase === 'ready') {
      if (state.profiles.length >= 5) throw new ServerProfilesError('The interrupted creation exceeds the server slot limit.', 503);
      await this.validateRuntime(directory, true);
      this.descriptions.set(journal.profile.id, await this.describe(journal.profile));
      await this.save({ ...state, bindingRequired: true, profiles: [...state.profiles, journal.profile] });
      return;
    }
    if (!await inspect(directory)) return;
    await this.assertDirectory(this.managedPath());
    await this.assertDirectory(directory);
    await this.ensureDirectory(this.deletedPath());
    const bundle = this.bundlePath(journal.profile.id);
    if (!await inspect(bundle)) {
      await mkdir(bundle, { mode: 0o700 });
      await this.syncDirectory(this.deletedPath());
    }
    await this.assertDirectory(bundle);
    const target = path.join(bundle, 'runtime');
    if (await inspect(target)) throw new ServerProfilesError('The interrupted creation has conflicting recovery data.', 503);
    await this.moveDirectory(directory, target);
    await this.writeJson(path.join(bundle, 'profile.json'), { id: journal.profile.id, name: journal.profile.name, removedAt: new Date().toISOString(), incomplete: true });
  }

  private async recoverDelete(journal: Extract<Journal, { operation: 'delete' }>): Promise<void> {
    const allowed = journal.profile.location === 'managed' ? ['runtime'] : ['minecraft', 'backups', 'installation-snapshots'];
    if (new Set(journal.moves).size !== journal.moves.length || journal.moves.some(move => !allowed.includes(move)) || journal.profile.location === 'managed' && journal.moves.length !== 1) throw new ServerProfilesError('The interrupted deletion has invalid recovery paths.', 503);
    const current = this.state().profiles.find(profile => profile.id === journal.profile.id);
    if (current && (current.location !== journal.profile.location || current.name !== journal.profile.name || this.activeId() === current.id)) throw new ServerProfilesError('The interrupted deletion conflicts with the server registry.', 503);
    const bundle = this.bundlePath(journal.profile.id);
    if (journal.profile.location === 'managed') await this.assertDirectory(this.managedPath());
    if (await inspect(bundle)) { await this.assertDirectory(this.deletedPath()); await this.assertDirectory(bundle); }
    for (const move of [...journal.moves].reverse()) {
      const source = this.moveSource(journal.profile, move);
      const destination = path.join(bundle, move);
      const sourceInfo = await inspect(source);
      const destinationInfo = await inspect(destination);
      if (sourceInfo) await this.assertDirectory(source);
      if (destinationInfo) await this.assertDirectory(destination);
      if (current) {
        if (sourceInfo && !destinationInfo) continue;
        if (!sourceInfo && destinationInfo) { await this.moveDirectory(destination, source); continue; }
      } else if (!sourceInfo && destinationInfo) continue;
      throw new ServerProfilesError('Server deletion recovery is ambiguous. Both locations were preserved for manual recovery.', 503);
    }
    if (current && await inspect(bundle)) {
      const entries = await readdir(bundle);
      if (entries.some(name => name !== 'profile.json')) throw new ServerProfilesError('Unexpected recovery files were preserved. Resolve the interrupted deletion before continuing.', 503);
      if (entries.includes('profile.json')) {
        regular((await lstat(path.join(bundle, 'profile.json'))));
        await unlink(path.join(bundle, 'profile.json'));
      }
      await rmdir(bundle);
      await this.syncDirectory(this.deletedPath());
    }
  }

  private async recoverRestore(journal: Extract<Journal, { operation: 'restore' }>): Promise<void> {
    const allowed = journal.profile.location === 'managed' ? ['runtime'] : ['minecraft', 'backups', 'installation-snapshots'];
    if (new Set(journal.moves).size !== journal.moves.length || journal.moves.some(move => !allowed.includes(move)) || !journal.moves.includes(journal.profile.location === 'managed' ? 'runtime' : 'minecraft')) throw new ServerProfilesError('The interrupted restoration has invalid recovery paths.', 503);
    const state = this.state();
    const current = state.profiles.find(profile => profile.id === journal.profile.id);
    if (current && (current.location !== journal.profile.location || current.name !== journal.profile.name) || !current && journal.profile.location === 'legacy' && state.profiles.some(profile => profile.location === 'legacy')) throw new ServerProfilesError('The interrupted restoration conflicts with the server registry.', 503);
    const bundle = this.bundlePath(journal.profile.id);
    if (journal.profile.location === 'managed') await this.assertDirectory(this.managedPath());
    if (await inspect(bundle)) {
      await this.assertDirectory(this.deletedPath());
      await this.assertDirectory(bundle);
      const metadata = await this.readRemovedMetadata(journal.profile.id);
      if (metadata && (metadata.name !== journal.profile.name || metadata.location !== journal.profile.location)) throw new ServerProfilesError('The interrupted restoration does not match its archived metadata.', 503);
      if (!metadata && !current) throw new ServerProfilesError('The interrupted restoration is missing its archived metadata.', 503);
    } else if (!current) throw new ServerProfilesError('The interrupted restoration is missing its archive.', 503);
    for (const move of [...journal.moves].reverse()) {
      const source = path.join(bundle, move);
      const destination = this.moveSource(journal.profile, move);
      const sourceInfo = await inspect(source);
      const destinationInfo = await inspect(destination);
      if (sourceInfo) await this.assertDirectory(source);
      if (destinationInfo) await this.assertDirectory(destination);
      if (current) {
        if (!sourceInfo && destinationInfo) continue;
      } else {
        if (sourceInfo && !destinationInfo) continue;
        if (!sourceInfo && destinationInfo) { await this.moveDirectory(destination, source); continue; }
      }
      throw new ServerProfilesError('Server restoration recovery is ambiguous. Both locations were preserved for manual recovery.', 503);
    }
    if (current) {
      await this.validateRuntime(this.directoryFor(current.id), true, current.location === 'legacy');
      this.descriptions.set(current.id, await this.describe(current));
      if (await inspect(bundle)) await this.cleanBundle(current.id);
    }
  }

  private async readRemovedProfiles(): Promise<DeletedServerProfile[]> {
    if (!await inspect(this.deletedPath())) return [];
    await this.assertDirectory(this.deletedPath());
    const profiles: DeletedServerProfile[] = [];
    for (const id of await readdir(this.deletedPath())) {
      if (!idSchema.safeParse(id).success || this.state().profiles.some(profile => profile.id === id)) continue;
      const profile = await this.readRemovedProfile(id);
      if (profile) {
        const { location, ...description } = profile;
        profiles.push(description);
      }
    }
    return profiles.sort((left, right) => right.removedAt.localeCompare(left.removedAt) || left.name.localeCompare(right.name));
  }

  private async readRemovedMetadata(id: string): Promise<DeletedProfile | undefined> {
    const stored = await this.readJson(path.join(this.bundlePath(id), 'profile.json'));
    if (stored === undefined || stored && typeof stored === 'object' && 'incomplete' in stored && stored.incomplete === true) return undefined;
    const result = deletedProfileSchema.safeParse(stored);
    if (!result.success || result.data.id !== id) throw new ServerProfilesError('A deleted server has invalid recovery metadata. Its files were preserved.', 503);
    return result.data;
  }

  private async readRemovedProfile(id: string): Promise<DeletedProfile | undefined> {
    if (!await inspect(this.deletedPath())) return undefined;
    await this.assertDirectory(this.deletedPath());
    const bundle = this.bundlePath(id);
    if (!await inspect(bundle)) return undefined;
    await this.assertDirectory(bundle);
    const profile = await this.readRemovedMetadata(id);
    if (!profile) return undefined;
    const allowed = profile.location === 'managed' ? ['profile.json', 'runtime'] : ['profile.json', 'minecraft', 'backups', 'installation-snapshots'];
    if ((await readdir(bundle)).some(name => !allowed.includes(name))) throw new ServerProfilesError('A deleted server has unexpected recovery files. Its files were preserved.', 503);
    const directory = this.removedDirectory(profile);
    await this.assertDirectory(directory);
    await this.assertDirectory(path.join(directory, 'minecraft'));
    return profile;
  }

  private removedDirectory(profile: DeletedProfile): string {
    const bundle = this.bundlePath(profile.id);
    return profile.location === 'managed' ? path.join(bundle, 'runtime') : bundle;
  }

  private async cleanBundle(id: string): Promise<void> {
    await this.assertDirectory(this.deletedPath());
    const bundle = this.bundlePath(id);
    await this.assertDirectory(bundle);
    const entries = await readdir(bundle);
    if (entries.some(name => name !== 'profile.json')) throw new ServerProfilesError('Unexpected recovery files were preserved. Resolve the interrupted restoration before continuing.', 503);
    if (entries.includes('profile.json')) {
      regular(await lstat(path.join(bundle, 'profile.json')));
      await unlink(path.join(bundle, 'profile.json'));
    }
    await rmdir(bundle);
    await this.syncDirectory(this.deletedPath());
  }

  private async clearJournal(): Promise<void> {
    await unlink(this.journalPath());
    await this.syncDirectory(this.root);
  }

  private async reloadAndRecover(): Promise<void> {
    try {
      this.registry = this.parseRegistry(await this.readJson(this.registryPath()));
      await this.recover();
      this.removedDescriptions = await this.readRemovedProfiles();
    } catch (error) {
      this.registry = undefined;
      throw new ServerProfilesError(`The profile operation needs recovery before continuing: ${(error as Error).message}`, 503);
    }
  }

  private moveSource(profile: StoredProfile, move: string): string {
    return profile.location === 'managed' ? path.join(this.managedPath(), profile.id) : path.join(this.root, move);
  }

  private async describe(profile: StoredProfile): Promise<ServerProfile> {
    const root = profile.location === 'legacy' ? this.root : path.join(this.managedPath(), profile.id);
    await this.validateRuntime(root, false);
    const installed = await readInstalled(path.join(root, 'minecraft'));
    if (installed) return { id: profile.id, name: profile.name, minecraftVersion: installed.minecraftVersion, loader: installed.loader, loaderVersion: installed.loaderVersion };
    const legacy = await this.readJson(path.join(root, 'minecraft', 'installation.json'));
    const target = targetSchema.safeParse(legacy && typeof legacy === 'object' ? { ...this.fallback, ...legacy } : this.fallback);
    if (!target.success) throw new ServerProfilesError('A saved server has invalid installation metadata.', 503);
    return { id: profile.id, name: profile.name, ...target.data };
  }

  private async validateRuntime(directory: string, inspectContents: boolean, legacy = false): Promise<void> {
    if (directory !== this.root) await this.assertDirectory(this.managedPath());
    await this.assertDirectory(directory);
    await this.assertDirectory(path.join(directory, 'minecraft'));
    if (!inspectContents) return;
    if (directory === this.root || legacy) {
      for (const name of ['minecraft', 'backups', 'installation-snapshots']) {
        const candidate = path.join(directory, name);
        if (await inspect(candidate)) await this.assertTree(candidate);
      }
    } else await this.assertTree(directory);
  }

  private async assertTree(directory: string): Promise<void> {
    let count = 0;
    const walk = async (candidate: string, depth: number): Promise<void> => {
      if (depth > 64) throw new ServerProfilesError('The saved server has too many nested folders to inspect safely.');
      const handle = await open(candidate, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      try {
        const anchored = process.platform === 'linux' ? `/proc/self/fd/${handle.fd}` : candidate;
        for (const name of await readdir(anchored)) {
          if (++count > 100_000) throw new ServerProfilesError('The saved server has too many entries to inspect safely.');
          const child = path.join(anchored, name);
          const info = await lstat(child);
          if (info.isDirectory()) await walk(child, depth + 1);
          else regular(info);
        }
      } finally { await handle.close(); }
    };
    await walk(directory, 0);
  }

  private async assertDirectory(directory: string): Promise<void> {
    const info = await inspect(directory);
    if (!info?.isDirectory() || info.isSymbolicLink()) throw new ServerProfilesError('A saved server folder is missing or is not a regular directory.', 503);
  }

  private async ensureDirectory(directory: string): Promise<void> {
    await mkdir(directory, { mode: 0o700 }).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; });
    await this.assertDirectory(directory);
    await this.syncDirectory(path.dirname(directory));
  }

  private async readJson(file: string): Promise<unknown | undefined> {
    const info = await inspect(file);
    if (!info) return undefined;
    regular(info);
    if (info.size > 64 * 1024) throw new ServerProfilesError('Server profile metadata exceeds the size limit.', 503);
    const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const current = await handle.stat();
      regular(current);
      if (current.dev !== info.dev || current.ino !== info.ino || current.size !== info.size) throw new ServerProfilesError('Server profile metadata changed while it was opened.', 503);
      const bytes = Buffer.alloc(64 * 1024 + 1);
      let length = 0;
      while (length < bytes.length) {
        const result = await handle.read(bytes, length, bytes.length - length, length);
        if (!result.bytesRead) break;
        length += result.bytesRead;
      }
      if (length !== info.size || (await handle.stat()).ctimeMs !== current.ctimeMs) throw new ServerProfilesError('Server profile metadata changed while it was read.', 503);
      return JSON.parse(bytes.subarray(0, length).toString('utf8'));
    } catch (error) {
      if (error instanceof SyntaxError) throw new ServerProfilesError('Server profile metadata is invalid. Preserve it and restore a verified backup.', 503);
      throw error;
    } finally { await handle.close(); }
  }

  private async writeJson(file: string, value: unknown): Promise<void> {
    const existing = await inspect(file);
    if (existing) regular(existing);
    const temporary = `${file}.${randomUUID()}.tmp`;
    const handle = await open(temporary, 'wx', 0o600);
    try {
      try {
        await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`);
        await handle.sync();
      } finally { await handle.close(); }
      await this.dependencies.rename(temporary, file);
      await this.syncDirectory(path.dirname(file));
    } finally { await unlink(temporary).catch(error => { if (!missing(error)) throw error; }); }
  }

  private async moveDirectory(source: string, destination: string): Promise<void> {
    await this.assertDirectory(path.dirname(source));
    await this.assertDirectory(path.dirname(destination));
    await this.assertDirectory(source);
    if (await inspect(destination)) throw new ServerProfilesError('A recovery destination already exists. Both copies were preserved.', 503);
    await this.dependencies.rename(source, destination);
    await this.syncDirectory(path.dirname(source));
    if (path.dirname(source) !== path.dirname(destination)) await this.syncDirectory(path.dirname(destination));
  }

  private async syncDirectory(directory: string): Promise<void> {
    const handle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { await handle.sync(); } finally { await handle.close(); }
  }

  private async save(registry: Registry): Promise<void> {
    const validated = this.parseRegistry(registry);
    await this.writeJson(this.registryPath(), validated);
    this.registry = validated;
  }

  private parseRegistry(value: unknown): Registry {
    const parsed = registrySchema.safeParse(value);
    if (!parsed.success) throw new ServerProfilesError('The saved server registry is invalid. Preserve it and restore a verified backup.', 503);
    if (parsed.data.profiles.length > 1 && !parsed.data.bindingRequired) return { ...parsed.data, bindingRequired: true };
    return parsed.data;
  }

  private profile(id: string): StoredProfile {
    if (!idSchema.safeParse(id).success) throw new ServerProfilesError('Choose a saved server.', 404);
    const profile = this.state().profiles.find(profile => profile.id === id);
    if (!profile) throw new ServerProfilesError('That saved server does not exist.', 404);
    return profile;
  }

  private name(value: string): string {
    const parsed = nameSchema.safeParse(value);
    if (!parsed.success) throw new ServerProfilesError('Use a server name between 1 and 64 characters.', 400);
    return parsed.data;
  }

  private state(): Registry {
    if (!this.registry) throw new ServerProfilesError('The server profile registry is not initialized.', 503);
    return this.registry;
  }

  private async assertNoJournal(): Promise<void> {
    if (await inspect(this.journalPath())) throw new ServerProfilesError('An interrupted server profile operation must be recovered before continuing.', 503);
  }

  private registryPath(): string { return path.join(this.root, 'server-profiles.json'); }
  private journalPath(): string { return path.join(this.root, 'server-profiles-operation.json'); }
  private managedPath(): string { return path.join(this.root, 'server-profiles'); }
  private deletedPath(): string { return path.join(this.root, 'deleted-server-profiles'); }
  private bundlePath(id: string): string { return path.join(this.deletedPath(), id); }

  private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.pending;
    let release!: () => void;
    this.pending = new Promise<void>(resolve => { release = resolve; });
    await previous;
    this.changing = true;
    try { return await operation(); } finally { this.changing = false; release(); }
  }
}
