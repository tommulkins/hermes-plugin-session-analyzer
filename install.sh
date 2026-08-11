#!/usr/bin/env bash
# Install Hermes Session Stats (desktop plugin + backend).
# Idempotent: safe to re-run after updates; never duplicates config entries.
set -euo pipefail

HERMES_HOME="${HERMES_HOME:-$HOME/.hermes}"
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_ID="session-dashboard"
CONFIG="$HERMES_HOME/config.yaml"

echo "→ Installing Session Stats into $HERMES_HOME"

# 1. Desktop JS plugin (hot-reloads; no restart needed for the UI side)
mkdir -p "$HERMES_HOME/desktop-plugins/$PLUGIN_ID"
cp "$SRC_DIR/desktop-plugins/$PLUGIN_ID/plugin.js" "$HERMES_HOME/desktop-plugins/$PLUGIN_ID/plugin.js"
echo "  ✓ desktop-plugins/$PLUGIN_ID/plugin.js"

# 2. Python backend (mounted at the next Hermes Desktop restart)
mkdir -p "$HERMES_HOME/plugins/$PLUGIN_ID/dashboard"
cp "$SRC_DIR/plugins/$PLUGIN_ID/dashboard/manifest.json" "$HERMES_HOME/plugins/$PLUGIN_ID/dashboard/"
cp "$SRC_DIR/plugins/$PLUGIN_ID/dashboard/plugin_api.py" "$HERMES_HOME/plugins/$PLUGIN_ID/dashboard/"
echo "  ✓ plugins/$PLUGIN_ID/dashboard/{manifest.json,plugin_api.py}"

# 3. Enable in config.yaml (plugins.enabled) if not already listed
if [ -f "$CONFIG" ]; then
  # Entries are indented 4 spaces: "    - session-dashboard"
  if ! grep -q "^    - $PLUGIN_ID\$" "$CONFIG"; then
    if grep -q "^plugins:" "$CONFIG" && grep -q "^  enabled:" "$CONFIG"; then
      # Insert after the first "  enabled:" line (portable awk; BSD sed
      # lacks GNU's 0,/re/ range, so sed-based insertion silently no-ops).
      awk -v id="$PLUGIN_ID" '
        /^  enabled:/ && !done { print; print "    - " id; done=1; next }
        { print }
      ' "$CONFIG" > "$CONFIG.tmp" && mv "$CONFIG.tmp" "$CONFIG"
      if ! grep -q "^    - $PLUGIN_ID\$" "$CONFIG"; then
        printf "\nplugins:\n  enabled:\n    - %s\n" "$PLUGIN_ID" >> "$CONFIG"
      fi
    else
      printf "\nplugins:\n  enabled:\n    - %s\n" "$PLUGIN_ID" >> "$CONFIG"
    fi
    echo "  ✓ added $PLUGIN_ID to plugins.enabled in config.yaml"
  else
    echo "  ✓ $PLUGIN_ID already enabled"
  fi
else
  printf "plugins:\n  enabled:\n    - %s\n" "$PLUGIN_ID" > "$CONFIG"
  echo "  ✓ created config.yaml with $PLUGIN_ID enabled"
fi

echo ""
echo "Done. Restart Hermes Desktop once so the backend mounts:"
echo "  Quit Hermes Desktop (⌘Q) and reopen it."
echo ""
echo "Then open it via:"
echo "  • Sidebar → “Session Stats” row (graph icon)"
echo "  • ⌘K → “Session Stats: Open”"
