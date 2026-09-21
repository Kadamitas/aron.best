# aron.best

Aron Mlodkowski's professional portfolio, with a separate Minecraft workshop for friends. Angular 22, Angular Material, TypeScript, and a small Node/Fastify service run on a Mac behind Caddy and nginx.

## Two audiences, two hosts

| Host | Purpose |
| --- | --- |
| `aron.best` and `www.aron.best` | Professional experience, selected projects, and contact |
| `mc.modpack.aron.best` | Mod selection, releases, server status, and maintenance |
| `mc.aron.best:25565` | Minecraft Java connection |

The professional page does not link to the workshop. Its host cannot call workshop APIs. Friends use a revocable invitation link, with no account or login form. The secret stays in the URL fragment until the app moves it into session storage. The Node service only exposes fixed Minecraft actions, never a general shell or remote desktop.

## Develop

Use Node 26. Install dependencies with `npm ci`. Run `npm run dev:server` and `npm run dev` in separate terminals. Open `http://localhost:4200`, or `http://localhost:4200/?workshop=1` for the local workshop preview. The workshop preview switch is only recognized on loopback hosts.

`npm run build` produces the Angular application and Node service. `npm start` serves the production build on `127.0.0.1:3000`. `npm test` checks API access boundaries, dependency resolution, archive validation, publishing safeguards, and server maintenance failure paths.

Generate the private invitation with `npm run invite`. It writes a random secret to the ignored `.env` file. `npm run invite -- --rotate --show` revokes the existing invitation and displays its replacement. Restart Node after rotation. Anyone holding that link can change the selected pack and operate the Minecraft server, so share it only with trusted friends.

## Minecraft and CurseForge

The initial runtime follows Friend's Modpack: Minecraft 26.3 and Fabric 0.19.5. A modpack update preserves that game and loader version. It does not silently migrate the world to a different Minecraft release.

`npm run bootstrap` installs the official Fabric launcher and creates local server settings. The owner must read and accept the [Minecraft EULA](https://www.minecraft.net/eula) before starting Minecraft. After accepting, run `npm run bootstrap -- --accept-eula`. A Java 25 path is configured in `.env.example` for Apple Silicon Homebrew installations.

CurseForge catalog access requires an approved API key. Publishing requires a separate author upload token, an owned modpack project, and a matching, unmodified App-exported ZIP. The application reports missing configuration explicitly. A share code is an expiring App import link, not a persistent published project ID. See [CurseForge setup](docs/curseforge.md).

Updates stage downloads, validate checksums, stop Minecraft gracefully, create a consistent backup, and replace mods. Failed startup restores the previous mods and world. Packs containing override files are rejected by automated updates until those configurations can be handled safely. The service does not execute arbitrary scripts from a downloaded archive.

Minecraft mods execute Java code. Only give maintenance invitations to people you trust, and prefer a dedicated macOS account for the service before expanding the group. The initial game listener is loopback-only until the network deployment is completed.

## Host on macOS

See [hosting and recovery](docs/hosting.md) for validated Caddy/nginx configuration, launchd services, DNS, GFiber port mappings, service logs, and rollback. GitHub Actions builds and tests on GitHub-hosted machines. The laptop is not a public CI runner.

Local controls include request and connection limits, bounded request bodies and timeouts, bounded logs and status history, a global API budget, restart cooldowns, serialized maintenance, checksummed downloads, safe archive inspection, origin checks, and an explicit host allowlist. These reduce application abuse. They cannot absorb a volumetric DDoS attack that fills a residential internet link.

The laptop must remain powered, awake, connected, and logged into the service account for user LaunchAgents to remain available. DNS must be updated if the public IPv4 address changes. External reachability must be verified from outside the home network.

## Engineering choices

Standalone Angular components and signals keep UI state local and explicit. Material provides accessible interaction primitives; custom typography, composition, and native enter/leave animations give each audience a distinct visual treatment. Reduced-motion preferences are respected.

The backend separates HTTP policy, CurseForge integration, pack state, artifact downloads, and the Minecraft process. Network and process boundaries are injectable where failure-path testing needs them. Function names describe behavior and units; comments explain operational constraints. This follows the principles discussed by [CodeAesthetic](https://www.youtube.com/@CodeAesthetic), especially clear naming, composition, and avoiding unnecessary abstraction.

Professional content comes from the supplied 2026 resume and public GitHub repositories. Private contact details and internal project information are not included. Runtime data, world saves, invitations, local paths, and credentials remain outside Git.
