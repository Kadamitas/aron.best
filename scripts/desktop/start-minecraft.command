#!/bin/zsh
# Double-click to start the Minecraft server through the workshop API.
# Starts the website services first if they are down, waits for the server,
# and prints the latest crash report if the start fails.
set -u
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
SCRIPT="${0:A}"
ROOT="${SCRIPT:h:h:h}"
API="http://127.0.0.1:3000"

bold() { printf '\n\033[1m%s\033[0m\n' "$*"; }
ok() { printf '  \033[32m✓\033[0m %s\n' "$*"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$*"; }
fail() { printf '  \033[31m✗\033[0m %s\n' "$*"; }
finish() { printf '\n'; read -k1 '?Press any key to close this window. '; printf '\n'; exit "${1:-0}"; }

cd "$ROOT" || { fail "Cannot find the aron.best project at $ROOT"; finish 1; }
bold "aron.best  |  starting the Minecraft server"

if ! curl -fsS "$API/api/health" >/dev/null 2>&1; then
  echo "  The website service is not running. Starting it first..."
  "$ROOT/scripts/desktop/start-website.command" --no-pause || finish 1
fi

# The invitation secret authorizes this laptop the same way a friend's link would. It is never printed.
TOKEN="$(sed -n 's/^FRIEND_ACCESS_TOKEN=//p' .env 2>/dev/null | head -1 | tr -d '"'"'"'')"
if [[ -z "$TOKEN" ]]; then fail "No FRIEND_ACCESS_TOKEN in .env. Run 'npm run invite' in $ROOT first."; finish 1; fi

status() {
  curl -sS -H 'Host: mc.modpack.aron.best' -H "Authorization: Bearer $TOKEN" "$API/api/status" 2>/dev/null
}
field() { node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{const s=JSON.parse(d);const v=process.argv[1].split(".").reduce((o,k)=>o?.[k],s);process.stdout.write(v==null?"":(Array.isArray(v)?v.join("\n"):String(v)))}catch{}})' "$1"; }

state="$(status | field server.state)"
case "$state" in
  running) ok "The server is already running. Connect to mc.aron.best"; finish 0 ;;
  starting|updating|stopping) echo "  The server is busy ($state). Waiting for it..." ;;
  not-installed) fail "The Minecraft server is not installed. Run 'npm run bootstrap' in $ROOT first."; finish 1 ;;
  "") fail "Could not read the server status from the API."; finish 1 ;;
  *)
    response="$(mktemp)"
    code="$(curl -sS -o "$response" -w '%{http_code}' -X POST \
      -H 'Host: mc.modpack.aron.best' -H 'Origin: https://mc.modpack.aron.best' \
      -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
      --data '{"action":"start"}' "$API/api/server/action")"
    if [[ "$code" != "202" ]]; then fail "The API refused the start request (HTTP $code): $(cat "$response")"; rm -f "$response"; finish 1; fi
    rm -f "$response"
    ok "Start requested. Minecraft usually takes 20 to 90 seconds."
    ;;
esac

printf '  Starting'
last=""
for _ in {1..240}; do
  sleep 2
  json="$(status)"
  state="$(printf '%s' "$json" | field server.state)"
  busy="$(printf '%s' "$json" | field jobRunning)"
  [[ "$state" != "$last" ]] && { printf '\n  state: %s' "$state"; last="$state"; }
  printf '.'
  if [[ "$state" == "running" && "$busy" != "true" ]]; then printf '\n'; ok "The server is up. Connect to mc.aron.best"; finish 0; fi
  if [[ "$state" == "failed" || ( "$state" == "stopped" && "$busy" != "true" ) ]]; then break; fi
done
printf '\n'

json="$(status)"
fail "The server did not start. $(printf '%s' "$json" | field server.failure.message)"
crash="$(printf '%s' "$json" | field server.crashLog)"
if [[ -n "$crash" ]]; then
  bold "Latest crash report (first lines)"
  printf '%s\n' "$crash" | head -60 | sed 's/^/    /'
  echo "  Full reports: $ROOT/.runtime/minecraft/crash-reports/"
  open "$ROOT/.runtime/minecraft/crash-reports/" 2>/dev/null || true
else
  echo "  Recent server output:"
  curl -sS -H 'Host: mc.modpack.aron.best' -H "Authorization: Bearer $TOKEN" "$API/api/server/logs" 2>/dev/null | field lines | tail -40 | sed 's/^/    /'
fi
echo "  The same details are shown on https://mc.modpack.aron.best for friends with access."
finish 1
