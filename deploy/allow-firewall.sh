#!/bin/bash
# Lets the macOS application firewall accept incoming connections for the
# exact Caddy and Node binaries the services use, then installs the pf anchor.
# Run once with sudo from the project root:
#   sudo bash deploy/allow-firewall.sh
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
ALF=/usr/libexec/ApplicationFirewall/socketfilterfw
SETTINGS="$ROOT/.runtime/deploy/service-settings.json"
if [[ $EUID -ne 0 ]]; then echo "Run with sudo."; exit 1; fi
if [[ ! -f "$SETTINGS" ]]; then echo "Run 'node scripts/install-services.mjs' first so $SETTINGS exists."; exit 1; fi

# The binaries come from the rendered service settings, never from arguments.
mapfile -t BINARIES < <(/usr/bin/python3 - "$SETTINGS" <<'PY'
import json, sys
settings = json.load(open(sys.argv[1]))
seen = []
for name in ("caddy", "api"):
    binary = settings["services"].get(name, {}).get("binary")
    if binary and binary not in seen: seen.append(binary)
print("\n".join(seen))
PY
)
for binary in "${BINARIES[@]}"; do
  [[ -x "$binary" ]] || { echo "Missing executable: $binary"; exit 1; }
  "$ALF" --add "$binary" >/dev/null || true
  "$ALF" --unblockapp "$binary" >/dev/null
  echo "Allowed incoming connections: $binary"
done
"$ALF" --setglobalstate on >/dev/null
echo "Application firewall stays on; only the listed binaries accept incoming connections."
bash "$HERE/pf/install-pf.sh"
