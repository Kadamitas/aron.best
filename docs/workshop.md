# Workshop controls

Dictionary Minecraft Server has Basic, Advanced, and Server Log tabs with one invitation and session. There is no separate Advanced login, repeated access banner, or user-facing pack release number. No tab exposes a shell or arbitrary host commands.

## Basic

Search the actual server mod files, choose Add mod to install JAR files, enable or disable them, and uninstall them. Add mod installs the uploaded files immediately; it does not submit a request for someone else to approve. Disabled mods remain visible. Uninstall moves the file into hidden recovery storage rather than permanently deleting it. New mod files are executable code and must come from people you trust.

Stop the server being edited before changing its files. An inactive saved server can be edited while the active server keeps running. Controls lock during conflicting maintenance. A failed startup also permits file repair. Server controls stay above the tabs and always control the active server, while its output lives in Server Log.

Basic has no CurseForge request, publishing, or imported-profile sections. File upload and local mod controls do not require a catalog key. Docker does not mount the host CurseForge App folder.

## Saved servers

Keep up to five named servers and select one to run at the shared Minecraft address. Each server retains its own world, mods, configuration, Minecraft/loader installation, backups, and installation snapshots. Only one Minecraft process runs at a time.

New server prompts for a name and confirmation. It stops the current server, provisions a blank server with the current Minecraft release and loader family using its latest compatible build, and selects it without starting it. Existing saved servers are not cleared. Install the desired pack files and adjust versions in the new slot. Preset pack names do not automatically download third-party packs.

Selecting a saved server only opens its mods, files, and version settings for editing. It does not stop or switch the active server. Set active is a separate button with confirmation: it stops the current server cleanly and activates the chosen slot without starting it. The server strip identifies the active server independently of the editing selection. Rename also requires confirmation. Delete is available only for inactive servers and asks for confirmation. It removes the slot from the saved list and retains all files under `/data/deleted-server-profiles/<id>` in the Minecraft volume. At least one saved server remains. Recovery data is never automatically purged and still occupies disk space.

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

With the isolated controller, Download pack ZIP exports the editing slot's enabled mods and configuration under `overrides/`, with a CurseForge-compatible manifest. Disabled mods, recovery files, and private world/server state are excluded. The slot being exported must be stopped so the archive is consistent; another active slot may keep running. Archives are limited to 128 MiB; larger packs require another export strategy. This download does not publish a CurseForge release and does not add client-only mods absent from the server.

Without the isolated controller, the legacy download contains the imported profile manifest rather than the server workspace. File writes are unavailable outside the isolated controller.

## Repeatable validation

Start the separate Docker preview described in `docs/docker.md`, leaving its Minecraft process stopped:

```sh
node scripts/docker-smoke.mjs
node scripts/docker-ui-smoke.mjs
```

The browser test uses installed Chrome on macOS, `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` when supplied, or Playwright Chromium. Screenshots go into `.runtime/ui-check`. Both tests are restricted to local HTTP previews, use the invitation without logging it, retain uniquely named harmless configuration fixtures, and uninstall their inert test JARs into recovery storage. They do not modify the native live server.

`node scripts/docker-smoke.mjs http://127.0.0.1:3300 --lifecycle` additionally starts, stops, and backs up the preview Minecraft world. Run it only when nobody is using that preview. Production migration is a separate operation with an offline backup and explicit network verification.

`node scripts/docker-profiles-smoke.mjs http://127.0.0.1:3300 --lifecycle` needs one free slot and a stopped preview server. It creates a uniquely named blank test server, verifies stale-context protection and renaming, and starts only that test server. While it runs, the test edits a temporary file in the inactive original slot and checks that active-slot writes remain blocked. It then switches back to the original server and removes the test slot into recovery storage. It leaves the original active and stopped. The export/restore regression in `deploy/docker/state.test.mjs` additionally verifies all five slots, active selection, backups, snapshots, and deleted-server recovery using disposable Docker projects.
