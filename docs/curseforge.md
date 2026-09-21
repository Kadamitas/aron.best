# CurseForge integration

The workshop keeps a local draft containing exact project and file IDs. Search results come from the official API. Without a configured key, the interface reports missing configuration and does not substitute sample mods.

The compatibility target follows the owner's imported profile: Minecraft 26.3 with Fabric 0.19.5. Versions are pinned. A newer pack release does not silently migrate the Minecraft world format or the loader.

## Configuration

Set these values in the local, ignored `.env` file. Never place either token in Angular environment files, browser storage, GitHub, screenshots, or URLs.

| Setting | Purpose |
| --- | --- |
| `CURSEFORGE_API_KEY` | Approved CurseForge API key for browsing and file metadata |
| `CURSEFORGE_UPLOAD_TOKEN` | Separate author token for publishing |
| `CURSEFORGE_PROJECT_ID` | Existing Minecraft modpack project owned by the token holder |
| `CURSEFORGE_EXPORT_PATH` | Absolute path to the unchanged ZIP exported from the CurseForge App |

Create the project in the CurseForge author dashboard. This integration does not create a project or fabricate ownership. The site requires project artwork and a useful description. Publication is subject to moderation.

## Supported workflow

1. Search for a mod and add it to the draft. The service selects an approved stable file tagged for the pinned Minecraft version and loader. It resolves required dependencies and rejects declared conflicts.
2. Removing a required dependency is blocked. Removing the last parent also removes automatically included dependencies that are no longer needed. Explicitly added mods stay selected.
3. Export a local manifest to inspect exact file IDs. This is a development draft, not an App-generated publication artifact.
4. Reproduce the selection in the CurseForge App and export the profile using the draft's name, version, Minecraft version, loader version, and selected files. Set `CURSEFORGE_EXPORT_PATH` to that ZIP.
5. Publish. The server checks the export against the draft, sends the original ZIP bytes with the upload token, and records the returned file ID as pending review. It never claims approval immediately after upload.

Every attempted upload records the archive hash before sending. If the connection fails after submission, the release remains uncertain. Inspect the author dashboard and reconcile the local record before retrying; automatically retrying could create duplicate public releases.

The service cannot cryptographically prove that an operator-configured ZIP came from the CurseForge App. The operator must supply an unchanged App export. Metadata checks detect mismatched or stale exports.

## Importing an existing local profile

Import a shared profile through the CurseForge App's documented Import Profile Code flow. Then run `node --import tsx scripts/import-profile.ts /absolute/path/to/minecraftinstance.json` for that specific installed profile. The importer reads only the selected instance metadata and mod files. It verifies every copied JAR against the recorded byte length and SHA-1 hash, preserves the original profile, and stores normalized pack state plus source provenance under the ignored runtime directory. The local `.env` keeps its other keys and receives the exact game and loader versions.

This is an initial import. It refuses existing pack state, nonempty server mods, untracked JARs, modified files, and configuration overrides that would require a broader server migration. It never imports launcher credentials. Private profile paths, the share code, runtime source metadata, and binary mod files must stay out of Git. Profile codes are temporary sharing mechanisms, not publishable project IDs.

## Server updates

Draft application resolves exact selected files. Published application resolves the newest approved stable release on the configured project, verifies its downloaded archive against API metadata, reads only the manifest, then resolves each exact mod file. Both paths provide bounded metadata to the server controller, which must enforce download limits, checksums, backups, startup health checks, and rollback.

The published updater handles mod JARs. It refuses releases containing nonempty overrides or optional mod selections, since silently dropping configuration, scripts, resources, or optional choices would produce a different pack. Those require a reviewed local server-pack import. Server packs have a separate file association on CurseForge and are not executed as arbitrary shell scripts by the web application.

Dependency metadata identifies required projects and conflicts, but does not express every Java-level version constraint or distinguish every client-only mod. A matching tag does not guarantee a working server. The runtime health check remains necessary, and a modpack should be tested before friends update their clients.

Downloads require a valid API URL on an HTTPS `forgecdn.net` host and a SHA-1 checksum supplied by CurseForge. Missing URLs and disabled third-party distribution are respected. No CDN URL is guessed and no token is sent to a download host. SHA-1 verifies the provider's file metadata; it is not proof that a mod is safe code.

## Access model

Friends can use an invitation link without creating an account. Treat that link as a credential. Mutation routes require the shared, revocable invitation token and expected origin. Request and job limits are enforced, and credentials are redacted from logs. A public hostname that is absent from the professional navigation still needs these controls.

The backend exposes fixed operations only. Do not add arbitrary shell commands, console text, filesystem paths, uploaded executables, or remote download URLs to HTTP payloads. All invitation holders share the configured workshop permissions, including publishing when enabled. Share it only with trusted friends. CurseForge credentials remain server-side; the invitation does not expose those credentials or grant general PC control.

## Official references

The [CurseForge REST API](https://docs.curseforge.com/rest-api/) defines search, file metadata, dependency relationships, loader enums, checksums, download URLs, and server-pack associations. The [Upload API](https://support.curseforge.com/support/solutions/articles/9000197321) uses a separate author token and multipart file submission to an existing project.

The current [Minecraft moderation rules](https://support.curseforge.com/support/solutions/articles/9000197279) require App-created modpacks and do not allow manually modified generated manifests. The [export guide](https://support.curseforge.com/support/solutions/articles/9000197908) explains the required ZIP structure. The [Fabric launcher page](https://fabricmc.net/use/?page=server) documents the pinned server launcher download and launch command.

Research checked on September 21, 2026. Live search, publishing, and project validation require the account credentials above and must be verified after configuration.
