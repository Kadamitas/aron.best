# Hosting aron.best on this Mac

The deployment files prepare a local HTTPS gateway and background services. DNS records, router rules, public TLS, and remote reachability must be verified separately. A successful local build does not establish that the domain is live.

## Service layout

```text
Internet HTTPS :443
  -> GFiber TCP forwarding to the Mac :443
  -> Caddy: TLS, hostname selection, forwarding-header replacement
  -> nginx 127.0.0.1:8081: request and connection limits
  -> Node 127.0.0.1:3000: Angular assets and application API

Internet HTTP :80 -> GFiber -> Caddy :80: HTTPS redirect and ACME
Minecraft Java TCP :25565 -> GFiber -> nginx :25565 -> Minecraft 127.0.0.1:25566
```

`aron.best` and `www.aron.best` serve the professional site. Both proxies reject `/api` and `/api/*` on these hosts. `mc.modpack.aron.best` serves the workshop and API, with search indexing disabled. The application must also validate the host and the authority required for each operation. The workshop hostname is discoverable and is not an access credential.

All services run without root privileges. Node and nginx's HTTP listener use IPv4 loopback. nginx also exposes the Minecraft TCP gateway on port 25565, while Java binds to `127.0.0.1:25566`. Caddy listens directly on 80 and 443, which macOS allows without root, because the GFiber port rules cannot translate port numbers. The Caddy administration API stays at `127.0.0.1:2019`. Do not forward port 2019, 3000, 8081, 25566, development servers, SSH, or Minecraft RCON.

## Prepare the Mac

1. Connect AC power and preferably Ethernet. While the API runs, its service wrapper uses macOS `caffeinate -s -w` with that API process ID to prevent system sleep on AC power. The assertion ends with the API process and does not modify global power settings or keep the display awake. Closing the laptop lid or explicitly putting the Mac to sleep can still affect availability. Verify the actual hardware arrangement rather than assuming wake-on-network provides continuous hosting.
2. Install Node.js 26, Caddy, and nginx. With an existing trusted Homebrew installation, `brew install caddy nginx` supplies the proxies. The nginx build must include `http_realip_module` and the stream modules; the validation command will fail clearly if it does not. For automatic router lease renewal also install `miniupnpc`. Use the Java runtime required by the selected Minecraft version and mod loader.
3. Keep this checkout at a stable absolute path. Configure the application using its `.env.example`, retain secrets only in `.env`, and keep `.env` private. Never commit credentials, invite secrets, TLS private keys, world data, or generated `.runtime/` files.
4. Run the checks and build:

   ```sh
   npm ci
   npm run check
   npm test
   npm run build
   node scripts/install-services.mjs
   ```

The final command discovers absolute executable paths, renders configuration under `.runtime/deploy/`, and checks the nginx, Caddy, and launchd syntax. It does not start services, edit the router, modify DNS, change power settings, or install packages. If an executable is outside PATH, specify `--node /absolute/path/to/node`, `--caddy /absolute/path/to/caddy`, or `--nginx /absolute/path/to/nginx`. `--local-only` omits Caddy registration while keeping the API and nginx available; nginx's game gateway still listens on the LAN.

Paths are encoded for their target configuration formats. The generated service settings retain the actual binaries selected during preparation. Rerun the installer after a package upgrade that removes an old binary path or after moving the checkout.

## Squarespace DNS

First inspect the current authoritative nameservers and existing records. If Squarespace is only the registrar and another provider hosts DNS, edit that provider. Save a copy of the existing DNS records before changing web-hosting records, and preserve email, domain verification, and other unrelated records.

For direct IPv4 hosting, the target record set is:

| Type | Name in the `aron.best` zone | Data |
| --- | --- | --- |
| A | `@` | Verified GFiber public WAN IPv4 |
| CNAME | `www` | `aron.best` |
| A | `mc` | Verified GFiber public WAN IPv4 |
| CNAME | `mc.modpack` | `aron.best` |

In Squarespace, select **Domains → aron.best → DNS → DNS Settings → Custom Records**. A CNAME target is a hostname with no scheme, slash, or port. Enter `mc.modpack` as the relative record name, then verify that Squarespace shows `mc.modpack.aron.best`. Do not add a CNAME alongside another record with the same name. Replace only conflicting web records after inspecting their current use.

There is no Minecraft SRV record requirement when the Java server uses its normal port 25565. The `mc.aron.best` record is for the game connection, not the workshop website.

Add no AAAA records until the Mac's stable IPv6 address, GFiber IPv6 firewall openings, and external IPv6 tests are complete. A stale AAAA record can break access and certificate issuance even when IPv4 works.

Squarespace currently defaults custom records to a four-hour TTL and documents that changes may take 24 to 48 hours to propagate. A shorter supported TTL is useful during setup. Residential WAN addresses can change. Before declaring this unattended hosting, establish a supported dynamic DNS update mechanism or a static public address. This repository does not claim that Squarespace DNS automatically follows the router's address.

## GFiber port forwarding

Confirm the actual router model and reserve the Mac's current LAN IPv4 address. Verify the router's WAN IPv4 against an independent public-address lookup. A private or shared WAN address, an additional router, or a VPN may change the routing required.

| Protocol | Public port | Mac LAN port | Purpose |
| --- | --- | --- | --- |
| TCP | 80 | 80 | ACME certificate validation and HTTPS redirect |
| TCP | 443 | 443 | HTTPS website and workshop |
| TCP | 25565 | 25565 | Minecraft Java server |

HTTP/3 is intentionally disabled in this Caddy configuration, so UDP 443 is not required. Additional mod-specific UDP ports must be reviewed separately if a chosen mod needs them. Port forwarding rules should target this Mac only. A router DMZ is not required.

For **GFiber Wi-Fi 6, Wi-Fi 6E, Multi-Gig, or Network Box** hardware, sign in to myFiber, select Network and the Mac, open Advanced, reserve its address, and add the three Custom single-port rules above. Google documents that different internal and external numbers are supported for individual ports.

For **Google Wifi or Nest Wifi Pro**, use the Google Home app: **Home → Wifi → Settings → Advanced Networking → Port management → Add**. Select IPv4, choose the Mac, enter the internal and external ports, select TCP, and save each rule.

The actual router was identified as a **GFiber Wi-Fi 7 GRBE331C**. Its portal differs from the older hardware instructions above. The standard UPnP IGD interface was found at `http://192.168.1.1:5000/rootDesc.xml`, with the Mac on interface `en0`. The optional renewal service uses this exact endpoint without network discovery. It verifies that the default gateway remains `192.168.1.1` on `en0` and pins the router's UDN, manufacturer, and model from its description. These checks prevent silently configuring a different network or replacement router; they are not cryptographic device authentication.

Prepare and validate optional router automation with:

```sh
node scripts/install-services.mjs --with-router
```

Preparation performs only local network and device-identity reads. The pinned identity and discovered executable path are written to private `.runtime/deploy/router-settings.json`; no router credentials or new application environment variables are needed. `--upnpc /absolute/path/to/upnpc` selects a specific installed binary. Start it along with the application using:

```sh
node scripts/install-services.mjs --install --with-router
```

The `best.aron.router` user agent renews only the three TCP mappings in the table, every 15 minutes, with 3600-second leases. The descriptions must be exactly `aron.best-http`, `aron.best-https`, and `aron.best-minecraft`. Before writing it reads the full table and rejects any occupied TCP target port whose destination, description, remote-host restriction, or lease differs from the expected rule. It rechecks the table immediately before each change and verifies the result. It never deletes mappings, uses a permanent-lease fallback, adopts another application's rules, or changes UDP ports. UPnP does not provide a transaction across all three rules, so a failure can leave a subset renewed; the next cycle rechecks all rules.

The current `en0` IPv4 address is read each cycle. If the router still has a mapping to an old local address, the service reports a conflict and preserves it. Reserve the Mac's LAN address, or let the old one-hour lease expire before renewal on a changed address. A gateway, interface, or device-identity change blocks renewal. After verifying an intentional router replacement, archive the old private router settings and rerun preparation to pin the replacement.

Review `.runtime/deploy/router-status.json` and `.runtime/logs/router.log` for success or conflict details. Stopping the renewal agent does not delete rules; its leases expire on the router. The service runs only while its macOS user is logged in, so the leases naturally expire after a prolonged shutdown or logout. This renews router leases only. It does not update public DNS if GFiber changes the WAN address.

The macOS application firewall must permit the intended incoming Caddy and nginx listeners. Do not disable the firewall globally. If a firewall prompt appears, identify the verified executable before allowing it. Keep Node, nginx HTTP, and Minecraft bound to loopback regardless of firewall configuration.

## Start and verify

Once the build and application configuration are ready, register the user services:

```sh
node scripts/install-services.mjs --install
```

This copies the three application `best.aron.*.plist` files into the current user's `Library/LaunchAgents` and bootstraps them with `launchctl`. `--with-router` also installs the optional router agent. It refuses to replace a plist that points at a different checkout. Re-running it restarts the selected services, so schedule this around Minecraft maintenance if the Node service owns a running server process. The generated router service configuration is preserved when a later application-only preparation omits `--with-router`.

The installer pins the Node listener to `127.0.0.1:3000` and sets production mode. Caddy stores certificate and configuration state under `.runtime/caddy/`. Preserve this private directory across routine deployments so certificate state survives restarts.

Inspect service status and listeners:

```sh
launchctl print gui/$(id -u)/best.aron.api
launchctl print gui/$(id -u)/best.aron.nginx
launchctl print gui/$(id -u)/best.aron.caddy
lsof -nP -iTCP:3000 -iTCP:8081 -iTCP:80 -iTCP:443 -iTCP:25565 -iTCP:25566 -sTCP:LISTEN
```

Ports 3000, 8081, and Java's 25566 must show `127.0.0.1`, not `*`. nginx owns public-facing port 25565. Validate the hostname boundary locally:

```sh
curl -I -H 'Host: aron.best' http://127.0.0.1:8081/
curl -i -H 'Host: aron.best' http://127.0.0.1:8081/api/pack
curl -i -H 'Host: unexpected.invalid' http://127.0.0.1:8081/
```

The professional page should load, its API request should return 404, and the unknown host should close the connection. nginx's default status 444 is an intentional connection close, so curl reports an empty reply.

After DNS and forwarding are active, Caddy will request certificates for the three website hostnames. Avoid repeatedly testing real certificate issuance while DNS is incorrect. Caddy's documentation describes using an ACME staging issuer when troubleshooting issuance.

Use a phone on cellular data or another external network for the final tests. Check normal HTTP redirects to HTTPS, trusted certificates for both websites, professional-host API rejection, authorized workshop actions, rejection of an invalid invite, and a real Minecraft client joining `mc.aron.best`. A local test or a router's NAT loopback test cannot establish external reachability. Verify the game version and modpack fingerprint on both the server and client.

## Client identity and local abuse controls

Caddy is the only internet-facing HTTP process. It replaces `X-Real-IP`, `X-Forwarded-For`, `X-Forwarded-Host`, and `X-Forwarded-Proto`, and removes the standard `Forwarded` header. It derives client identity from the actual socket peer. It is not configured to trust a client-supplied forwarding chain.

nginx accepts its real-IP header only over the loopback hop, rewrites its client address using Caddy's value, and sends a fresh single-value forwarding header to Node. The application must trust only its loopback proxy. An attacker connecting directly to Caddy cannot select a new rate-limit identity by changing a forwarding header. A process already running on the Mac can connect to loopback services; this configuration does not isolate hostile local users. Deploying under a dedicated restricted account is appropriate when that threat matters.

Do not put a CDN or an additional proxy in front of this setup without updating and retesting its trust boundary. Otherwise all visitors may appear to share that proxy's address. If Cloudflare is considered later, its standard full-zone Universal SSL coverage does not include the nested `mc.modpack.aron.best` hostname; review certificate coverage before enabling its proxy.

The nginx defaults allow 20 active HTTP requests per client address and 120 per website host, limit page traffic to 20 requests/second with a short burst, limit API traffic to 5 requests/second, and limit modifying API requests to 30/minute with a small burst. Requests beyond the limits return 429. Caddy and nginx also bound request size and timeouts. Friends behind the same NAT share an address, so review legitimate traffic before lowering these values. Expensive server operations also need application-level serialization and cooldowns.

The Minecraft stream gateway allows six simultaneous connections per network client address and 64 total, connects to Java with a three-second timeout, and closes connections idle for 120 seconds. It does not send PROXY protocol because the unmodified Minecraft server does not understand that protocol. nginx therefore applies IP limits before forwarding, while Minecraft sees the proxy's loopback address. Use authenticated player identities and the server allowlist for game access rather than Minecraft IP bans. Friends sharing one public IP also share the six-connection limit.

These controls provide local protection from HTTP floods and excess Minecraft connections. They cannot prevent a distributed attack from saturating the GFiber connection before traffic reaches the laptop. Large volumetric attacks require upstream mitigation or a protected external gateway. Game-server limits, backups, and a player allowlist are separate controls.

## Operations and recovery

`launchd` restarts failed processes with a 15-second throttle. The wrapper forwards termination to each service and allows up to 90 seconds for shutdown; launchd's outer timeout is 120 seconds. The Minecraft controller should stop and save its own child process inside that window. During reinstallation, the installer waits up to 60 seconds for the previous job registration and wrapper process to disappear before bootstrapping its replacement. If a longer graceful shutdown is still in progress, installation stops without forcibly terminating it. A brief launchd cleanup race receives bounded bootstrap retries. Permission failures and an unexpected registration are reported directly.

The wrapper writes logs to `.runtime/logs/{api,nginx,caddy,router}.log` for the enabled services. Each file is limited to 5 MiB, with three rotated files per service, for at most roughly 80 MiB with all four services enabled. Routine HTTP access logs and nginx's per-rejection warnings are disabled to avoid turning floods into disk-write floods. Application logs must redact authorization credentials. Minecraft world backups and game logs have their own retention and disk budgets; the proxy wrapper does not manage them.

The Minecraft controller retains up to 20 backup directories. It refuses another backup or update when that cap is reached. It never automatically deletes a completed world backup. Copy older backups to verified external storage and deliberately remove the local copies when room is needed. Incomplete backup directories left after an interrupted copy also count toward the cap and require inspection. Before copying, the controller counts regular files recursively, rejects symbolic links, and requires twice the snapshot size plus 256 MiB of free space. It also checks available space before staging mod downloads. Successful snapshots appear only after the entire staged copy completes. Failed-update files are quarantined for recovery and need separate manual review; the cap is a backup count, not a total world-storage quota.

User LaunchAgents run while this user is logged in. They do not guarantee availability before login after a reboot, through FileVault unlock, during sleep, or after power or network loss. A dedicated non-admin service account and a properly configured system LaunchDaemon are a possible later migration when unattended boot is required. This installer does not register a root service.

Before an application update, allow active maintenance work to finish, save the world, and retain the last known-good application release and pack state. Build and test the new code before restarting services. A Minecraft update must use the pack's pinned version and loader, perform a pre-update backup, stage downloads, verify hashes, and preserve a recoverable previous version. Never downgrade a world in place as a rollback strategy.

Stop the services with:

```sh
node scripts/install-services.mjs --stop
```

This stops the selected application jobs and any installed router renewal job, and keeps their files. They will load again at next login. To uninstall permanently, stop them first, inspect `best.aron.api.plist`, `best.aron.nginx.plist`, `best.aron.caddy.plist`, and any installed `best.aron.router.plist` in `Library/LaunchAgents`, then move those exact files to Trash. Let this deployment's one-hour router leases expire, or remove only its three exact rules after inspecting them. Remove only the corresponding DNS records if public hosting is being retired. Preserve worlds, backups, `.env`, and certificate state until their recovery needs are resolved.

## GitHub CI

The included workflow runs dependency installation, the application checks, tests, and deployment-script syntax checks on a GitHub-hosted runner with Node 26. Its token has read-only repository access, checkout credentials are not retained, and superseded runs are cancelled. Dependabot checks application and Actions dependencies weekly.

The workflow does not deploy to this laptop. A general self-hosted runner on a personal laptop would let executable workflow code reach that machine, and GitHub specifically cautions against using one for public repositories. The deployment script is a deliberate local installation boundary.

## Primary references

- [GFiber device configuration and forwarding](https://support.google.com/fiber/answer/4650342?hl=en)
- [Google Home and Nest forwarding](https://support.google.com/googlehome/answer/6274503?hl=en)
- [Squarespace DNS for web hosting](https://support.squarespace.com/hc/en-us/articles/31119879125645-DNS-records-for-web-hosting)
- [Squarespace subdomain pointing](https://support.squarespace.com/hc/en-us/articles/215744668-Pointing-a-Squarespace-domain)
- [Caddy automatic HTTPS and port requirements](https://caddyserver.com/docs/automatic-https)
- [Caddy reverse-proxy headers](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy)
- [nginx client-address replacement](https://nginx.org/en/docs/http/ngx_http_realip_module.html)
- [nginx request and connection limits](https://docs.nginx.com/nginx/admin-guide/security-controls/controlling-access-proxied-http/)
- [nginx stream connection limits](https://nginx.org/en/docs/stream/ngx_stream_limit_conn_module.html)
- [MiniUPnP project and miniupnpc client](https://miniupnp.tuxfamily.org/)
- [Apple sleep and wake settings](https://support.apple.com/en-asia/guide/mac-help/mchle41a6ccd/mac)
- [Apple launchd service lifecycle](https://developer.apple.com/library/archive/documentation/MacOSX/Conceptual/BPSystemStartup/Chapters/CreatingLaunchdJobs.html)
- [GitHub self-hosted runner guidance](https://docs.github.com/en/actions/how-tos/manage-runners/self-hosted-runners/add-runners)
- [Why local appliances cannot prevent link saturation](https://blog.cloudflare.com/magic-transit/)
- [Cloudflare nested-subdomain certificate limitations](https://developers.cloudflare.com/ssl/edge-certificates/universal-ssl/limitations/)
