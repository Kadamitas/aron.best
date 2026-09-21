#!/bin/bash
# Installs the aron.best pf anchor system-wide. Run once with sudo:
#   sudo bash deploy/pf/install-pf.sh
# Re-run after editing aron-best.pf.conf. Use --status to inspect, --remove to undo.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ANCHOR_NAME="aron.best"
ANCHOR_FILE="/etc/pf.anchors/aron.best"
PF_CONF="/etc/pf.conf"
LOAD_PLIST="/Library/LaunchDaemons/best.aron.pf.plist"
EXPIRE_PLIST="/Library/LaunchDaemons/best.aron.pf-expire.plist"
MARKER="# aron.best anchor (deploy/pf/install-pf.sh)"

if [[ "${1:-}" == "--status" ]]; then
  pfctl -s info | head -3
  echo "--- anchor rules"; pfctl -a "$ANCHOR_NAME" -s rules || true
  echo "--- blocked sources"; pfctl -a "$ANCHOR_NAME" -t aron_flooders -T show 2>/dev/null || echo "(none)"
  exit 0
fi
if [[ $EUID -ne 0 ]]; then echo "Run with sudo."; exit 1; fi

if [[ "${1:-}" == "--remove" ]]; then
  launchctl bootout system "$LOAD_PLIST" 2>/dev/null || true
  launchctl bootout system "$EXPIRE_PLIST" 2>/dev/null || true
  rm -f "$LOAD_PLIST" "$EXPIRE_PLIST" "$ANCHOR_FILE"
  if grep -q "$MARKER" "$PF_CONF"; then
    /usr/bin/sed -i '' "/$MARKER/,/^load anchor \"$ANCHOR_NAME\"/d" "$PF_CONF"
  fi
  pfctl -f "$PF_CONF" >/dev/null 2>&1 || true
  echo "Removed the aron.best pf anchor. Apple's default rules remain loaded."
  exit 0
fi

# 1. The anchor file itself.
install -m 0644 "$HERE/aron-best.pf.conf" "$ANCHOR_FILE"
pfctl -n -a "$ANCHOR_NAME" -f "$ANCHOR_FILE"

# 2. Reference it from the main ruleset, after Apple's own anchors, exactly once.
if ! grep -q "$MARKER" "$PF_CONF"; then
  cp "$PF_CONF" "$PF_CONF.aron-best.bak"
  printf '\n%s\nanchor "%s"\nload anchor "%s" from "%s"\n' "$MARKER" "$ANCHOR_NAME" "$ANCHOR_NAME" "$ANCHOR_FILE" >> "$PF_CONF"
fi
pfctl -n -f "$PF_CONF"

# 3. Enable pf at boot with the full ruleset. macOS only parses /etc/pf.conf at
#    boot; it does not enable pf unless another feature turned it on.
cat > "$LOAD_PLIST" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>best.aron.pf</string>
  <key>ProgramArguments</key><array><string>/sbin/pfctl</string><string>-E</string><string>-f</string><string>/etc/pf.conf</string></array>
  <key>RunAtLoad</key><true/>
</dict></plist>
PLIST
# 4. Let blocked sources back in after 30 minutes.
cat > "$EXPIRE_PLIST" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>best.aron.pf-expire</string>
  <key>ProgramArguments</key><array><string>/sbin/pfctl</string><string>-a</string><string>aron.best</string><string>-t</string><string>aron_flooders</string><string>-T</string><string>expire</string><string>1800</string></array>
  <key>StartInterval</key><integer>300</integer>
</dict></plist>
PLIST
chmod 0644 "$LOAD_PLIST" "$EXPIRE_PLIST"
chown root:wheel "$LOAD_PLIST" "$EXPIRE_PLIST" "$ANCHOR_FILE"
launchctl bootout system "$LOAD_PLIST" 2>/dev/null || true
launchctl bootout system "$EXPIRE_PLIST" 2>/dev/null || true
launchctl bootstrap system "$LOAD_PLIST"
launchctl bootstrap system "$EXPIRE_PLIST"
pfctl -E -f "$PF_CONF" 2>&1 | grep -v "^No ALTQ" || true
echo "pf is enabled with the aron.best anchor. Check it any time with: sudo bash deploy/pf/install-pf.sh --status"
