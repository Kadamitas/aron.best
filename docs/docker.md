# Docker deployment

The website and Minecraft run in separate containers. The website stores its pack metadata and invitation grants in `app-state`. The Minecraft controller owns `minecraft-data`, including the actual server, mods, world and backups. The Advanced tab reaches those files through the authenticated controller API. It does not receive a host filesystem mount, shell endpoint or Docker socket.

All services run as user `10001`, with a read-only root filesystem, dropped Linux capabilities, no privilege escalation, and limits on memory, CPU, processes and retained logs. The controller port stays on a private Compose network. Caddy is the only trusted HTTP proxy and gets its own certificate volumes. Only the website receives the invitation and CurseForge credentials.

Uploaded mods are executable Java code. The JVM additionally runs under mandatory Landlock and seccomp restrictions. It can read the selected server, write only its approved data paths, and cannot open controller secrets, the runtime trust store, other saved servers, or the controller's process files. Runtime JARs, libraries, launcher metadata and argument files are read-only to the JVM and checked against SHA-256 manifests before each start. Manifests live in the separate `runtime-trust` volume and are published only after a fresh official installation, never by Start. The chosen Java executable is checked against an image-built checksum list.

The Minecraft container has only internal Docker networks with isolated gateway mode. A separate `network-edge` container, with no volumes or secrets, forwards the public game connection and brokers outbound HTTPS. The sandbox allows TCP connections only to private proxy ports 3129 and 443. Both permit only four explicit Mojang authentication and discovery hosts. The TLS relay preserves end-to-end certificate verification and routes only an allowlisted ClientHello server name, because Mojang authlib bypasses ordinary Java proxy settings. Container-local host mappings send those four names to the private edge address. Installer downloads use a separate proxy port inaccessible to mods. UDP, other socket families, subprocess creation, cross-sandbox signals, process-memory access and permission-changing syscalls are denied. The edge rejects private and special DNS answers and pins each connection to its validated address. Ordinary mod web requests, voice-chat UDP, external databases and subprocess-based mods will not work under this policy.

A malicious mod can still damage the active world or other explicitly writable data, consume the container's resource budget, or misuse Minecraft's own permitted connections. Mods run in Minecraft's JVM, so checksums do not prevent a mod from changing the game in memory. Containers and kernel sandboxes are not a guarantee against kernel or Docker vulnerabilities. Docker Desktop adds a Linux VM boundary on macOS. Keep independent backups and the host updated. Never add a Docker socket, home directory, repository mount, host networking, privileged mode, broad filesystem grants or a sandbox fallback.

## Local preview

Use Docker Engine 28 or newer, Compose 2.24.4 or newer, and a Linux kernel with Landlock ABI 6 enabled, normally kernel 6.12 or newer. Docker Desktop must provide those capabilities inside its Linux VM. The controller refuses to initialize if the sandbox probe fails. Host setup scripts use Node.js 26. Docker Desktop should have enough memory for the configured Java heap plus the controller and website, at least 8 GB for the default 4 GB heap.

From the repository root:

```sh
node scripts/docker-prepare.mjs
COMPOSE_PROJECT_NAME=aron-best-preview WEB_SUBNET=172.30.10.0/24 CADDY_ADDRESS=172.30.10.2 APP_ADDRESS=172.30.10.3 GAME_SUBNET=172.30.13.0/24 NETWORK_EDGE_ADDRESS=172.30.13.2 docker compose --env-file .runtime/docker/compose.env up --build -d app minecraft
node scripts/docker-invite.mjs http://127.0.0.1:3300
```

Open the invitation URL printed by the last command. It grants both Basic and Advanced access through the same gate. Keep that URL private. The preview website uses `127.0.0.1:3300`; Minecraft uses `127.0.0.1:25575`. These ports do not replace the existing live services. The preview project name and subnet keep its data and private network separate from production. Stop the preview before production starts because both use the same loopback preview ports unless configured otherwise.

Preparation copies the current invitation token and optional CurseForge credentials from the repository `.env`, without displaying them. An optional path argument selects another source environment file. When no invitation exists, it generates one. It preserves every existing output file, so running it again does not rotate tokens or overwrite configuration.

Generated settings live in `.runtime/docker/compose.env`. Secrets live in `.runtime/docker/secrets`, whose directory is mode `0700`. Secret files are mode `0444` so Docker's service user can read a file-backed Compose secret on Linux. The private parent directory prevents other local users from traversing to those files. Compose mounts each secret read-only only into services that declare it. Secret values never enter the image or Compose environment.

`BOOTSTRAP_MINECRAFT=true` installs the configured server into a fresh Minecraft volume. `EULA_ACCEPTED=true` records the owner's acceptance already given for this server. `MINECRAFT_AUTOSTART=false` leaves the game stopped until Start is pressed. Set it to `true` when automatic startup is wanted. Installation and health checks may take a few minutes on the first run.

The image versions are configurable with `NODE_IMAGE`, `JAVA_IMAGE`, `JAVA8_IMAGE`, `JAVA17_IMAGE`, `JAVA21_IMAGE`, and `CADDY_IMAGE`. Their defaults pin official multi-platform image digests and support both Apple Silicon and x86-64. Update the tag and digest together when upgrading a runtime. Java runtimes use the Jammy builds for compatibility with the Debian runtime's C library. `JAVA_IMAGE` supplies Java 25; older runtimes support the curated legacy Minecraft releases.

## Configuration that moves with the server

| Setting | Purpose |
| --- | --- |
| `PORTFOLIO_HOST`, `PORTFOLIO_ALIAS` | Professional site hostnames |
| `WORKSHOP_HOST` | Friends' workshop hostname |
| `MINECRAFT_ADDRESS` | Address shown to players |
| `WORKSHOP_NAME` | Server name in API responses and generated modpack archives |
| `ACME_EMAIL` | Certificate expiry and account contact |
| `MINECRAFT_VERSION`, `FABRIC_LOADER_VERSION` | Initial server and pack versions |
| `MINECRAFT_MEMORY_MB` | Maximum Java heap in MB |
| `MINECRAFT_MEMORY_LIMIT` | Entire controller container limit, including Java and Node |
| `MINECRAFT_CPUS` | Controller CPU allowance |
| `MINECRAFT_AUTOSTART` | Start the game after the controller starts |
| `APP_PUBLISHED_PORT` | Loopback website port, default `3300` |
| `MINECRAFT_PUBLISHED_PORT` | Loopback preview game port, default `25575` |
| `MINECRAFT_PUBLIC_PORT` | Public game port, default `25565` |
| `HTTP_BIND_ADDRESS`, `MINECRAFT_BIND_ADDRESS` | Host addresses for public listeners, default `0.0.0.0` |
| `WEB_SUBNET`, `CADDY_ADDRESS`, `APP_ADDRESS` | Private web network and distinct fixed addresses for Caddy and the app |
| `GAME_SUBNET`, `NETWORK_EDGE_ADDRESS` | Isolated game network and fixed private proxy address, changed together |
| `COMPOSE_PROJECT_NAME` | Namespace for containers, networks and persistent volumes |

There is no hardcoded laptop IP in the containers. On a new host, restore the data and secrets, set the domains and resource limits, then point DNS and any router forwarding at the new machine. If using a public game port other than `25565`, include it in `MINECRAFT_ADDRESS` or configure a Minecraft DNS SRV record. An IP address alone does not migrate the world, secrets or certificates.

Keep `MINECRAFT_MEMORY_LIMIT` higher than the Java heap. Its default `6g` leaves space beyond the `4096` MB heap for Java native memory, the controller and file operations. Changing `COMPOSE_PROJECT_NAME` selects different volumes; it does not move existing data.

The initial loader is Fabric. The workshop's Minecraft and loader labels let invited users select a compatible installation while the game is stopped. Save opens a confirmation, stages official files, retains the previous installation, and leaves the new server stopped. Existing worlds and mods are preserved, not converted. See `docs/workshop.md` for compatibility and snapshot limits. Editing bootstrap environment variables does not overwrite a saved installation or migrate world data.

## Invitation and IP access

The invitation unlocks Basic and Advanced together and installs a signed HttpOnly session cookie. There is no additional Advanced login.

IP grants are disabled in this deployment because the isolated game relay and Docker Desktop can present different players as the same internal address. Existing grants remain in stored data but are ignored. Existing invite links continue working because their secret is preserved. Reintroducing join-based grants requires a separately authenticated source-address handoff, not arbitrary forwarded headers or the relay's address.

The app trusts only `CADDY_ADDRESS` for forwarded HTTP headers. If `WEB_SUBNET` conflicts with an existing network, change all three settings together and keep Caddy and the app at different addresses inside that subnet. Fixed addresses prevent startup order from assigning Caddy's trusted address to the app. Do not replace the trusted address with `true`, an arbitrary hop count or a broad network range.

## Move the existing server into Docker

Preview validation uses separate volumes. For production migration, first stop the original Minecraft process and native services, then take an offline copy of the runtime directory. The existing service script can stop this checkout's macOS LaunchAgents:

```sh
node scripts/install-services.mjs --stop
```

This also stops router lease renewal if it is registered. Verify that the game has shut down and that its final save completed. The existing `.runtime` may be used as the offline source once no native process is writing it. Preserve a separate backup before the cutover.

Build production images, then import into new, empty production volumes:

```sh
docker compose --env-file .runtime/docker/compose.env build app minecraft network-edge caddy
node scripts/docker-state.mjs import-local --offline-snapshot /absolute/path/to/offline-runtime-copy
docker compose --env-file .runtime/docker/compose.env up -d network-edge
docker compose --env-file .runtime/docker/compose.env run --rm --no-deps minecraft node dist/server/reinstall-runtime.js --controller-stopped
```

Import sends `pack.json` and `ip-access.json` to the website volume, and `minecraft/` and `backups/` to the controller volume. It rejects symbolic links, hard links and special files, and refuses nonempty destination volumes. It streams the files over standard input; the source directory is never mounted into a container. The original runtime is preserved, and importing starts no website or Minecraft process. A failed partial import is left in place for inspection; use a fresh project namespace to retry after identifying the cause.

The final command reinstalls official runtime files and creates their trust manifests before the imported server can start. Keep the app and controller stopped until it succeeds. See the runtime trust details below if reinstallation fails.

The CurseForge desktop application's host folder is intentionally not mounted into Docker. Use the workshop's mod installation and file tools for this server. The optional publishing archive path can point to a file inside the website data volume when one has been transferred explicitly.

Before public cutover, set the intended domains and `MINECRAFT_AUTOSTART` in `.runtime/docker/compose.env`. The public overlay enables Caddy and exposes only HTTP, HTTPS and the Minecraft gateway:

```sh
docker compose --env-file .runtime/docker/compose.env -f compose.yaml -f compose.public.yaml up -d
```

DNS for the site hostnames and `mc.aron.best` must reach this machine. Router forwarding, if needed, should target TCP `80`, `443` and `25565`. Do not forward `3000`, `3001`, `3300` or `25566`. Caddy issues and renews certificates when the public domains and challenge ports are reachable. Its high internal ports let it run without root or added capabilities.

The old macOS LaunchAgent plist files remain after `--stop` and can load again at the next login. Follow `docs/hosting.md` to uninstall those native agents once Docker has passed the live checks. Keep the offline data until the migrated world and invitation access have been verified. If reverting before playing on the new world, stop the Docker stack and restore the native services against their untouched runtime. After players use the new world, export its current data before any rollback to avoid losing progress.

## Back up or move to another host

Runtime trust is deliberately not reconstructed from imported or restored modpack files. After an import or restoration, stop the app and controller, bring up `network-edge`, then rebuild official runtime files while retaining mods, configurations and worlds:

```sh
docker compose --env-file .runtime/docker/compose.env stop app minecraft
docker compose --env-file .runtime/docker/compose.env up -d network-edge
docker compose --env-file .runtime/docker/compose.env run --rm --no-deps minecraft node dist/server/reinstall-runtime.js --controller-stopped
docker compose --env-file .runtime/docker/compose.env up -d minecraft app
```

This stages official downloads in an empty directory, resolves runtime dependencies without user mods, verifies the vanilla server against Mojang metadata, retains the previous installation, and publishes a new trust manifest. It never approves existing unknown binaries. An unavailable old loader, unsupported loader cache or failed checksum leaves startup blocked, not downgraded to unsandboxed execution. Preserve enough free disk space and a separate backup before migration. Changing an existing deployment's network definitions also requires stopping and recreating its Compose networks without deleting volumes.

Stop the Docker app and game before exporting so the world and pack metadata form one consistent snapshot:

```sh
docker compose --env-file .runtime/docker/compose.env stop app minecraft
node scripts/docker-state.mjs export /absolute/path/to/new-backup-directory
docker compose --env-file .runtime/docker/compose.env start minecraft app
```

Export writes `app.tar`, `minecraft.tar` and a SHA-256 manifest in a new private directory. It refuses to overwrite an existing backup directory. Save the `.runtime/docker` configuration and secret directory separately in a secure backup; volume archives intentionally do not contain the invitation or controller secrets. Caddy can obtain new certificates on the new machine, subject to certificate authority rate limits.

On the new host, copy the repository and private Docker configuration, build the images, then restore into empty volumes:

```sh
docker compose --env-file .runtime/docker/compose.env build app minecraft network-edge caddy
node scripts/docker-state.mjs restore /absolute/path/to/backup-directory
docker compose --env-file .runtime/docker/compose.env up -d network-edge
docker compose --env-file .runtime/docker/compose.env run --rm --no-deps minecraft node dist/server/reinstall-runtime.js --controller-stopped
docker compose --env-file .runtime/docker/compose.env -f compose.yaml -f compose.public.yaml up -d
```

Restore checks both archive hashes, stages the archive inside the destination volume, and rejects links, special files, absolute paths and traversal before extracting. It applies private file permissions before publishing restored entries. Leave space for the archive and extracted data during restoration. The manifest detects corruption, not an untrusted backup author, so use only backups you control. Both import and restore refuse running app or Minecraft containers and refuse nonempty volumes. Use `--env-file PATH` on the state script when configuration is elsewhere. Never use `docker compose down --volumes` on a deployment whose data you want to keep.

Do not run the final startup command unless official runtime reinstallation succeeds. Restored archives do not supply trusted runtime manifests.

## Verification

```sh
node --test deploy/docker/packaging.test.mjs
DOCKER_INTEGRATION=true node --test deploy/docker/state.test.mjs
docker compose --env-file .runtime/docker/compose.env config --quiet
docker compose --env-file .runtime/docker/compose.env -f compose.yaml -f compose.public.yaml config --quiet
docker compose --env-file .runtime/docker/compose.env ps
docker compose --env-file .runtime/docker/compose.env logs --tail 100 app minecraft
```

The packaging tests verify privilege restrictions, separate volumes and secrets, isolated gateway networks, the published port boundary, narrow proxy trust, and preservation of credentials during setup. `server/runtime-integrity.test.ts`, `server/runtime-sandbox.test.ts` and `server/network-edge.test.ts` cover trust failures, startup dispatch and outbound policy. `deploy/sandbox/smoke.Dockerfile` runs native adversarial checks against the actual kernel policy. Running tests and validating Compose do not prove a live game or authenticated player login works; those also require deployment checks.

Deployment behavior follows the official [Compose service reference](https://docs.docker.com/reference/compose-file/services/), [Compose secrets reference](https://docs.docker.com/reference/compose-file/secrets/), [Docker Desktop networking guide](https://docs.docker.com/desktop/features/networking/), and [Caddy port configuration](https://caddyserver.com/docs/caddyfile/options#https-port).

Sandbox boundaries follow [Landlock ABI 6](https://kernel.org/doc/html/v6.12/userspace-api/landlock.html), [seccomp filtering](https://docs.kernel.org/userspace-api/seccomp_filter.html), and Docker's [isolated gateway mode](https://docs.docker.com/engine/network/port-publishing/#gateway-modes).
