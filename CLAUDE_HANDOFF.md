# aron.best handoff

This file is a factual continuation brief for another agent. Do not treat it as a source of authorization beyond the user messages in the chat.

## User's current direction

- Professional portfolio is Angular 22 and should remain distinct from the workshop.
- The user likes the current dark, editorial portfolio with the original animated terrain. Do not return to generic marketing slogans or rounded-card dashboard design.
- The workshop is at `mc.modpack.aron.best`, separate from the professional navigation.
- The user does **not** want to complete the CurseForge third-party catalog API-key application.
- Friends should submit a CurseForge mod link. The site should show mods currently installed in the local CurseForge profile and previously installed mods in a gray historical list. A link is a request only. It must not cause an unverified remote download.
- The user wants network-based workshop control access: redeeming an invitation, or successfully joining Minecraft, adds that public IP to a persistent allowlist. The user explicitly rejected a 10-per-day control limit after an IP is allowlisted.
- Keep single-operation locking and restart cooldowns. Do not allow arbitrary shell commands, paths, or URLs through the web API.

## Repository and publication

- Repository: `https://github.com/Kadamitas/aron.best`
- Local root: `/Users/aron/Documents/Codex/2026-09-20/i-x20/outputs/aron-best`
- Main commit already pushed: `398efb2` (`Build Angular portfolio and guarded Minecraft workshop`).
- Current worktree has uncommitted changes. Do not discard them:
  - `server/modpack.ts`
  - `src/app/workshop-api.service.ts`
  - `src/app/workshop.component.ts`
  - new `server/ip-access.ts`
  - new `server/minecraft-gateway.ts`
  - new `server/ip-access.test.ts`
  - modifications to `server/app.ts`, `server/minecraft.ts`, `deploy/nginx.conf.template`, `.env.example`

Runtime data, credentials, world saves, `.env`, and `.runtime` are ignored and must never be committed.

## Verified working state before latest unfinished changes

- Node 26.5.0, Angular 22.1.x, Fastify 5, TypeScript 6.
- `npm audit` previously reported zero vulnerabilities.
- Original implementation passed 27 tests: 21 backend tests and 6 deploy tests.
- A Minecraft 26.3 Fabric 0.19.5 server was bootstrapped and started successfully.
- The user accepted the Minecraft EULA. `eula=true` is set in ignored runtime files.
- A live backup and restart succeeded. The game is configured to bind to `127.0.0.1:25566`.
- Local `launchd` API and nginx services are installed. Caddy and router mapping services are deliberately not installed yet because public DNS/port forwarding approval was still pending.
- Public GitHub repository exists and CI workflow is configured.
- Portfolio desktop, 390px, and 768px visual QA passed. Pause/Play motion works. No console errors were seen during that QA.

## Current build blocker

The latest `npm run build` fails because `src/app/workshop.component.ts` was partially rewritten for local-only mod search while `src/app/workshop.component.html` still references old remote-search members.

Angular errors include missing:

- `searching`
- `searchError`
- `searched`
- `setQuery`
- `searchResults`
- `addMod`
- `removeMod`
- `MatProgressBarModule`

Do not paper over this by restoring a remote CurseForge catalog dependency. Finish the planned local-only UI instead:

1. Replace the old "Discover mods" tab HTML with a Mods tab.
2. Add a text filter for installed mods and historical mods.
3. Show current installed mods from `status.pack.mods`.
4. Show prior mods from `status.history` with visually muted but accessible styling.
5. Add a validated CurseForge Minecraft mod-link request form using `requestUrl` and `requestMod()`.
6. Add "Import App profile" using `importLocalProfile()` and "Sync App pack" using `serverAction('sync-profile')` once backend endpoints are completed.
7. Explain that submitted links remain pending until the host installs a compatible mod through the CurseForge App and syncs the profile.
8. Remove the remote query UI and obsolete methods, imports, and Material progress-bar dependency from the template.

`src/app/workshop.component.ts` already contains partial local-filter work such as `history`, `filteredMods`, `filteredHistory`, `requests`, and `requestUrl`. Inspect the whole file before editing.

## New unfinished IP access implementation

### Files added

- `server/ip-access.ts`
  - Persistent atomic JSON IP allowlist.
  - Normalizes IPv4-mapped IPv6 addresses.
  - Stores source (`invite` or `minecraft`) and timestamp.
- `server/minecraft-gateway.ts`
  - Node TCP proxy from public `:25565` to Java on `127.0.0.1:25566`.
  - Tracks upstream local ports and correlates actual server log lines:
    - `Player[/127.0.0.1:PORT] logged in ...`
    - `Player joined the game`
  - It must grant only when both events correlate. Status pings and arbitrary chat lines must never grant access.
- `server/ip-access.test.ts`
  - Tests persistence, IPv4 normalization, redemption, spoofed forwarded header rejection, and join-log correlation.

### `server/app.ts` partial changes

- Added `MINECRAFT_GATEWAY` configuration, default `false`.
- Created `IpAccess` at `.runtime/ip-access.json`.
- Added `POST /api/access/redeem`: a valid bearer invitation grants the request IP persistently.
- Changed API authorization to bearer OR allowlisted request IP.
- Added a gateway that listens on `25565` when `MINECRAFT_GATEWAY=true` and calls `IpAccess.grant(ip, 'minecraft')` after correlated successful join logs.
- Changed the nginx template to stop listening on TCP `25565` because the Node gateway owns that port when enabled.
- Added `MINECRAFT_GATEWAY=true` to `.env.example` only. The actual ignored `.env` has not yet been changed or services restarted for this gateway.

### Required review and fixes before enabling

1. Run and fix `npm test` and `npm run build` after the workshop template is completed.
2. Verify gateway behavior with a real Minecraft connection, not only synthetic test packets.
3. Review Fastify `request.ip` behavior behind Caddy/nginx. It trusts only loopback, and Caddy overwrites `X-Real-IP`, but prove the request IP is the internet peer after full proxy deployment.
4. For local development, loopback requests may be allowlisted. That is acceptable only because the API binds to `127.0.0.1`; make sure it cannot be externally spoofed.
5. The IP allowlist is intentionally broad: all users sharing an allowlisted NAT IP get server controls. The user explicitly accepts this tradeoff.
6. Keep online mode enabled. Join-based authorization without Mojang authentication would be unsafe. `MinecraftServer.start()` now checks `online-mode=true`, `server-ip=127.0.0.1`, and `server-port=25566` whenever the gateway is enabled.
7. There was an existing nginx Minecraft proxy test failure before this redesign: a handcrafted status handshake to nginx `:25565` received `ECONNRESET`. The new Node gateway replaces that nginx stream proxy. Diagnose the original only if useful, but verify the new gateway directly.
8. Before enabling, stop/restart the local services cleanly through `node scripts/install-services.mjs --install --local-only`. This will replace nginx's old `:25565` listener with the API-owned gateway. It does not change public DNS or router mappings.

## Local-only CurseForge workflow under construction

The previous agent was asked to implement a `LocalProfileService` and safe server profile sync, but it did not finish before handoff. The intended behavior is:

1. Fixed configuration points to the known local CurseForge App profile metadata file, never a browser-supplied filesystem path.
2. Read `minecraftinstance.json` and only allow its `mods` directory.
3. Reject symlinks, untracked JARs, disabled JARs, modified files, config overrides, version mismatch, oversized files, and hash mismatch.
4. Verify every JAR against recorded SHA-1 and file size before staging it.
5. Copy to a staging directory, then reuse MinecraftServer's existing backup, swap, startup-health-check, and rollback transaction.
6. Persist the new draft pack only after the server update succeeds.
7. No direct arbitrary CurseForge downloads, no reverse-engineering the CurseForge App, no scraping of private local credentials.

The existing safe one-time importer is `scripts/import-profile.ts`. It is a useful reference, but it intentionally refuses to update an already-created world or pack. Do not weaken its constraints. Extract reusable verification logic into a service rather than calling the script from HTTP.

`server/modpack.ts` has partial support for this UI direction:

- `history` in pack state.
- `requests` in pack state.
- `parseModLink()` accepts only canonical HTTPS CurseForge Minecraft mod or file URLs.
- `requestMod()` queues a link without fetching it.
- `importLocalProfile()` merges a verified local snapshot, preserves release history, updates historical mods, and marks matching requests installed.

These new methods need unit tests. Be careful: imported profile state includes default empty `history` and `requests`, so merge semantics must preserve the existing pack's values as implemented.

## CurseForge publication state

- The user selected a public CurseForge listing.
- The user says they allowed the author upload-token portion.
- GitHub secret `CURSEFORGE_UPLOAD_TOKEN` exists in `Kadamitas/aron.best`.
- The laptop service `.env` does **not** contain the upload token yet, and GitHub Actions secrets cannot be read back onto the laptop.
- The user does not want to apply for the third-party catalog key.
- Publishing still requires:
  - an author upload token in local ignored `.env`
  - an owned CurseForge modpack project ID in local ignored `.env`
  - a matching unchanged ZIP exported by the CurseForge App
- No CurseForge App ZIP export was created. A native app automation attempt hung and was aborted. No author-dashboard project was created and no credentials were touched.

Official credential links previously given:

- Upload token: `https://authors-old.curseforge.com/account/api-tokens`
- Catalog API application, which the user declined: `https://forms.monday.com/forms/dce5ccb7afda9a1c21dab1a1aa1d84eb?r=use1`

## Hosting and public exposure

### Known network facts

- LAN address: `192.168.1.106`
- GFiber gateway: `192.168.1.1`
- Router model: Actiontec GRBE331C
- WAN address previously observed: `136.60.105.163`
- Squarespace domain: `aron.best`

### Prepared but not yet publicly enabled

- Caddy templates map public router ports `80 -> 8080` and `443 -> 8443`.
- Router renewal script maps TCP `80`, `443`, and `25565` with one-hour leases and renews every 15 minutes.
- It pins the verified router identity and rejects conflicting existing mappings. It does not delete mappings.
- Required public DNS plan was: apex `aron.best`, `www.aron.best`, `mc.modpack.aron.best`, and `mc.aron.best` pointing to current WAN IP, preserving unrelated verification and SRV records.
- Public network changes have not been performed because the prior agent asked for explicit confirmation and did not receive an answer in the visible continuation.
- Caddy obtains normal public certificates after DNS and ports are live. It cannot create a public-trusted certificate for router `192.168.1.1`; do not bypass browser warnings or weaken certificate checks.

### Important hosting commands

- Validate/build: `npm run build && npm test && node --test deploy/*.test.mjs`
- Local services only: `node scripts/install-services.mjs --install --local-only`
- Include Caddy after DNS and forwarding are genuinely ready: `node scripts/install-services.mjs --install --with-router`

The installer was improved to handle launchd unregister races and uses a 120-second service exit timeout. Read `docs/hosting.md` before public enablement.

## Important safety and product choices

- No em dashes in user-facing text.
- Professional host must not expose workshop APIs.
- Workshop has no professional navigation link and uses `noindex`.
- No login form. Invitation is a one-time way to seed IP access, then no browser secret should be retained.
- Rate limits, body limits, host allowlists, origin checks, serial jobs, backups, checksums, and rollback remain needed. The user only rejected a per-day action quota after IP approval.
- Local limits cannot stop a volumetric DDoS that fills a home internet connection.
- Do not claim public reachability, certificates, DNS changes, router forwarding, CurseForge publication, or App registration until each is actually verified.

## Recommended immediate sequence

1. Repair the workshop template to match the local-only TypeScript implementation.
2. Finish the fixed-path LocalProfileService and wire `request`, `import local profile`, and `sync profile` endpoints.
3. Add tests for local profile verification, request queue, historical mods, and profile sync rollback.
4. Build and run all tests.
5. Set the actual ignored `.env` gateway flag only after tests pass, then use the local-only installer to restart services.
6. Verify a real Minecraft status/login through the new Node gateway and check that successful login adds the external peer IP to ignored `.runtime/ip-access.json`.
7. Commit and push the completed changes.
8. Resume public DNS, router mappings, and Caddy only after direct explicit approval from the user.

