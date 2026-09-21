# Workshop controls

Dictionary Minecraft Server has Basic, Advanced, and Server Log tabs with one invitation and session. There is no separate Advanced login, repeated access banner, or user-facing pack release number. No tab exposes a shell or arbitrary host commands.

The active server shows its player count. Hover, focus, or tap that count to see player names, one per line. Player information comes from the private Minecraft status listener and is cached briefly. If the server hides names or returns only a sample, the interface says which names are unavailable instead of inventing a complete list.

Maintenance displays the actual operation instead of repeated generic busy labels. Switching shows the destination's name, such as `Switching to Main server`. Other labels identify starting, shutting down, restarting, installation, backups and file changes. The controller supplies these labels, so another friend's browser or a page reload sees the same operation.

Last updated belongs to the server currently selected for editing. Successful mod and file changes update a persisted timestamp; page refreshes and backups do not. Dates use `America/Chicago`, including the correct CST or CDT offset throughout the year.

## Basic

Search the actual server mod files, choose Add mod to install JAR files, enable or disable them, and uninstall them. Add mod installs the uploaded files immediately; it does not submit a request for someone else to approve. Disabled mods remain visible. Uninstall moves the file into hidden recovery storage rather than permanently deleting it. New mod files are executable code and must come from people you trust.

New mod JARs can be added while the selected server runs. Uploads finish atomically without replacing an existing file; the server loads the added mods on its next restart. Replacing, disabling, uninstalling, or editing existing files still requires stopping that server. An inactive saved server can be edited while the active server keeps running. Controls lock during conflicting maintenance. A failed startup also permits file repair. Server controls stay above the tabs and always control the active server, while its output lives in Server Log.

Basic has no CurseForge request, publishing, or imported-profile sections. File upload and local mod controls do not require a catalog key. Docker does not mount the host CurseForge App folder.

## Backups

Back up opens a confirmation with the option to download the completed `.tar.gz` backup to the user's computer. A copy is retained on the server either way. The operation targets the active server, independently of which saved server is open for editing.

For a consistent world snapshot, a running server stops safely, saves its backup, and starts again. The interface shows progress and an explicit failure if preparation fails. Downloads refer to the completed backup job, not a later active server or a changing world directory. Downloads use the same invitation access as the rest of the workspace. Treat a full backup as private server data, not a modpack for players.

Automatic backups run every six hours per saved server. A running server is backed up only after a fresh player-count check reports zero players; occupied servers and unknown counts defer until a later check. Before changing files or versions on a stopped server, a safety snapshot is saved unless a successful snapshot already exists from the previous 15 minutes. Edits in that window share the same checkpoint. Live additions of new mod files do not stop players to take a checkpoint. A failed required checkpoint blocks the edit and shows a backup warning.

Keep the latest six successful snapshots per server, counting manual and automatic backups together. A new snapshot is committed before old snapshots are retired. Unsafe or unrecognized recovery data is preserved for inspection rather than deleted. Recovery, next to the saved-server selector, lists retained backups and lets friends download them even after a browser restart or server deletion. Backup timestamps use Chicago time. The history and shared objects are outside Advanced and outside the JVM's allowed paths.

Snapshots use manifests referencing immutable SHA-256 objects in `/data/backup-objects`. Identical file contents across server slots and backup dates use one stored object, regardless of filename. Captures verify existing objects before reuse. Downloads reconstruct a normal `.tar.gz` archive and discard their temporary archive file after opening the download, so stored backups do not accumulate duplicate compressed copies. Garbage collection verifies references from active and deleted servers before removing unreferenced objects. Unknown or damaged metadata stops cleanup and preserves existing objects.

This storage deduplicates backups, not Minecraft's live writable worlds or installation snapshots. Everything is still on the same laptop's Docker volume, so it does not protect against losing that disk. Download an important backup or export the Docker state to another device for independent protection.

## Saved servers

Keep up to five named servers and select one to run at the shared Minecraft address. Each server retains its own world, mods, configuration, Minecraft/loader installation, backups, and installation snapshots. Only one Minecraft process runs at a time.

New server prompts for a name and confirmation. It stops the current server, provisions a blank server with the current Minecraft release and loader family using its latest compatible build, and selects it without starting it. Existing saved servers are not cleared. Install the desired pack files and adjust versions in the new slot. Preset pack names do not automatically download third-party packs.

Selecting a saved server only opens its mods, files, and version settings for editing. It does not stop or switch the active server. Set active is a separate button with confirmation: it stops the current server cleanly and activates the chosen slot without starting it. The server strip identifies the active server independently of the editing selection. Rename also requires confirmation. Delete is available only for inactive servers and asks for confirmation. It hides the slot from the saved list and retains all files under `/data/deleted-server-profiles/<id>` in the Minecraft volume. Recovery can restore it, with confirmation, when a slot is available. Restoration keeps its original ID and data paths, does not switch the active server and does not start the restored server. At least one saved server remains. Deleted servers are never automatically purged and still occupy disk space.

New slot data lives under `/data/server-profiles/<id>` and the active selection is stored in `/data/server-profiles.json`. The original server keeps its existing `/data/minecraft` directory until explicitly deleted. Container state exports preserve the whole volume, including every slot, registry, and recovery bundle.

Requests carry the expected active server ID in `X-Server-Profile` and the editing target in `X-Workspace-Profile`. Editors and uploads capture their editing target rather than reading a later selection. The controller validates both identities and rejects stale active-server requests or deleted workspace targets. Selecting another slot is blocked while a file operation or editor is open. No file mutation silently falls back to another slot.

## Minecraft and loader versions

The Minecraft and loader labels become controls on hover or keyboard focus. Select a Minecraft release to load compatible Fabric, Forge, NeoForge, or Quilt builds from their official metadata. The matching loader build is selected automatically. Releases before 26 are limited to 1.6.4, 1.7.10, 1.12.2, 1.16.5, 1.18.2, 1.19.2, 1.20.1, and 1.21.1. Newer stable releases appear when Mojang publishes them. A loader appears only when its metadata lists support for the selected release.

Save requires the server being edited to be stopped and opens a confirmation showing both installations and a compatibility warning. Confirming stages official server files in a separate directory, preserves world and modpack data, retains the entire previous installation, and then replaces that slot's installation directory. The edited server stays stopped. Existing mods are not automatically converted or replaced, and world downgrades may not work. Review compatibility before starting the new version. Server Log remains tied to the active server; installation failures appear on the page.

Java 8, 17, 21, and 25 are bundled in the Minecraft image and selected using Mojang's release metadata. The saved installation survives container replacement and overrides the initial bootstrap version settings. Installation snapshots live in each server's runtime folder under `installation-snapshots`, initially `/data/installation-snapshots` for the original server. After five snapshots per server, further installations are blocked until the owner safely archives one. Snapshots are never automatically deleted, and installation requires enough space for preserved files plus a 2 GiB reserve.

Startup refuses to bootstrap a missing or empty active server when snapshots or staging indicate an interrupted installation. Restore the intended installation before restarting the container; it will not silently create a new world.

## Advanced

The sidebar expands nested folders. Uploads and drag-and-drop use the currently open folder without a destination-path field. Right-click a file for Edit, Download, Rename, Move, or Delete. Right-click a folder for its actions, or blank space to create a file or folder. Visible menu buttons provide the same controls for touch and keyboard users.

Editing, naming, moving, and deletion use dialogs. Moving uses a folder picker. Text saves check the original revision and refuse to overwrite another person's intervening changes. The editor warns before discarding unsaved changes and supports Ctrl+S or Command+S. Deletion moves entries into hidden recovery storage. Required top-level workspace folders cannot be renamed, moved, or deleted.

Editable roots are `config`, `defaultconfigs`, `mods`, `kubejs`, `scripts`, `datapacks`, `resourcepacks`, `shaderpacks`, and `world/serverconfig`. World saves, server launch files, credentials, and controller settings are not exposed. Symbolic links, hard links, path traversal, and hidden control files are rejected.

Limits are 128 MiB per uploaded file, 256 KiB per text file, 4 GiB for the editable workspace including recovery files, and 1,200 listed files. Uploads use bounded chunks and expire after 15 minutes. These are safety limits, not automatic cleanup of existing mods or worlds.

## Downloadable pack

With the isolated controller, Download pack ZIP exports the editing slot's enabled mods and configuration under `overrides/`, with a CurseForge-compatible manifest. Disabled mods, recovery files, and private world/server state are excluded. It works while the server runs. If a mod or configuration file changes during export, the download fails with a retry message instead of returning a mixed snapshot. Archives are limited to 128 MiB; larger packs require another export strategy. This download does not publish a CurseForge release and does not add client-only mods absent from the server. Newly uploaded mods are included even before the next restart.

Without the isolated controller, the legacy download contains the imported profile manifest rather than the server workspace. File writes are unavailable outside the isolated controller.

## Repeatable validation

The fixture-based browser checks use temporary ports and do not contact a live server:

```sh
npm run build
node scripts/saved-servers-ui-smoke.mjs dist/aron-best/browser
node scripts/live-workshop-ui-smoke.mjs dist/aron-best/browser
node scripts/recovery-ui-smoke.mjs dist/aron-best/browser
node scripts/operation-status-ui-smoke.mjs dist/aron-best/browser
node scripts/version-selector-ui-smoke.mjs dist/aron-best/browser
```

Run `npm test` on Linux to include the anchored-filesystem backup archive checks. Those Linux-specific cases are skipped on macOS. The tests use temporary fixture worlds, never production volumes.

Start the separate Docker preview described in `docs/docker.md`, leaving its Minecraft process stopped:

```sh
node scripts/docker-smoke.mjs
node scripts/docker-ui-smoke.mjs
```

The browser test uses installed Chrome on macOS, `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` when supplied, or Playwright Chromium. Screenshots go into `.runtime/ui-check`. Both tests are restricted to local HTTP previews, use the invitation without logging it, retain uniquely named harmless configuration fixtures, and uninstall their inert test JARs into recovery storage. They do not modify the native live server.

`node scripts/docker-smoke.mjs http://127.0.0.1:3300 --lifecycle` additionally starts, stops, and backs up the preview Minecraft world. Run it only when nobody is using that preview. Production migration is a separate operation with an offline backup and explicit network verification.

`node scripts/docker-profiles-smoke.mjs http://127.0.0.1:3300 --lifecycle` needs one free slot and a stopped preview server. It creates a uniquely named blank test server, verifies stale-context protection and renaming, and starts only that test server. While it runs, the test edits a temporary file in the inactive original slot and checks that active-slot writes remain blocked. It then switches back to the original server and removes the test slot into recovery storage. It leaves the original active and stopped. The export/restore regression in `deploy/docker/state.test.mjs` additionally verifies all five slots, active selection, backups, snapshots, and deleted-server recovery using disposable Docker projects.
