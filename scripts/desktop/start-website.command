#!/bin/zsh
# Double-click to start (or restart) the aron.best website on this Mac.
# Registers the background services, waits for them, and prints a health summary.
# Pass --no-pause to skip the "press any key" prompt (used by the Minecraft script).
set -u
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
SCRIPT="${0:A}"
ROOT="${SCRIPT:h:h:h}"
API="http://127.0.0.1:3000"
NO_PAUSE=0
[[ "${1:-}" == "--no-pause" ]] && NO_PAUSE=1

bold() { printf '\n\033[1m%s\033[0m\n' "$*"; }
ok() { printf '  \033[32m✓\033[0m %s\n' "$*"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$*"; }
fail() { printf '  \033[31m✗\033[0m %s\n' "$*"; }
finish() {
  if (( NO_PAUSE == 0 )); then printf '\n'; read -k1 '?Press any key to close this window. '; printf '\n'; fi
  exit "${1:-0}"
}

cd "$ROOT" || { fail "Cannot find the aron.best project at $ROOT"; finish 1; }
bold "aron.best  |  starting the website"

if [[ ! -f dist/server/index.js || ! -f dist/aron-best/browser/index.html ]]; then
  echo "  No build found. Building first (about a minute)..."
  if ! npm run build >/dev/null 2>&1; then fail "The build failed. Run 'npm run build' in $ROOT to see why."; finish 1; fi
  ok "Built."
fi

if node scripts/install-services.mjs --install --with-router >/dev/null 2>.runtime/last-install.log; then
  ok "Website, proxies, and router lease renewal are registered with launchd."
elif node scripts/install-services.mjs --install >/dev/null 2>>.runtime/last-install.log; then
  warn "Router forwarding could not be prepared (not on the home network?). Website services are registered."
else
  fail "Could not register the services. Details:"
  sed 's/^/    /' .runtime/last-install.log
  finish 1
fi

printf '  Waiting for the API'
for _ in {1..60}; do
  curl -fsS "$API/api/health" >/dev/null 2>&1 && break
  printf '.'; sleep 1
done
printf '\n'
if curl -fsS "$API/api/health" >/dev/null 2>&1; then ok "API is answering on 127.0.0.1:3000"; else fail "API did not answer. Check .runtime/logs/api.log"; finish 1; fi

for entry in 8081:nginx 443:Caddy-HTTPS 80:Caddy-HTTP 25565:Minecraft-gateway; do
  port="${entry%%:*}"; name="${entry##*:}"
  if lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then ok "$name is listening on port $port"; else warn "$name is not listening on port $port yet"; fi
done

curl -sS -H 'Host: mc.modpack.aron.best' "$API/api/status" 2>/dev/null | node -e '
let data = ""; process.stdin.on("data", c => data += c).on("end", () => {
  try { const s = JSON.parse(data); const f = s.server.failure ? ` (${s.server.failure.message})` : "";
    console.log(`  Minecraft server: ${s.server.state}${f}`); } catch { console.log("  Minecraft server: status unavailable"); }
});'

if [[ -f .runtime/deploy/router-status.json ]]; then
  node -e '
const s = JSON.parse(require("node:fs").readFileSync(".runtime/deploy/router-status.json", "utf8"));
if (s.status === "ready") { console.log(`  Router: ports 80, 443, 25565 forwarded to ${s.address} (public ${s.externalAddress})`);
  for (const e of s.dns?.stale ?? []) console.log(`  ! DNS for ${e.hostname} points at ${e.addresses.join(", ") || "nothing"}, not ${s.externalAddress}. Update it at Squarespace.`);
} else console.log(`  Router: ${s.status} - ${s.message ?? ""}`);'
else
  warn "Router renewal has not reported yet. It runs every 15 minutes; see .runtime/logs/router.log"
fi

wan="$(curl -fsS --max-time 5 https://api.ipify.org 2>/dev/null || true)"
dns="$(dig +short aron.best A 2>/dev/null | tail -1)"
if [[ -n "$wan" && "$wan" == "$dns" ]]; then ok "aron.best resolves to this connection ($wan)"; elif [[ -n "$wan" ]]; then warn "aron.best resolves to ${dns:-nothing} but this connection is $wan. Update the A records at Squarespace."; fi

bold "Addresses"
echo "  Portfolio:  https://aron.best"
echo "  Workshop:   https://mc.modpack.aron.best"
echo "  Minecraft:  mc.aron.best"
echo "  Logs:       $ROOT/.runtime/logs/"
finish 0
