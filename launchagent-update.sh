#!/bin/zsh
# Polly-Router LaunchAgent Update Script
# Updates the LaunchAgent plist to use Homebrew Node instead of NVM Node

PLIST_SOURCE="/Users/brettgershon/.openclaw/workspace/polly-router/com.brett.polly-router.plist"
PLIST_DEST="/Users/brettgershon/Library/LaunchAgents/com.brett.polly-router.plist"

echo "=== Polly-Router LaunchAgent Migration ==="
echo ""

# Stop current service
echo "1. Stopping current polly-router service..."
launchctl stop com.brett.polly-router 2>/dev/null
launchctl unload "$PLIST_DEST" 2>/dev/null
sleep 2

# Verify old process is gone
if pgrep -f "polly-router/dist/server.js" > /dev/null; then
    echo "   WARNING: Old polly-router still running, killing..."
    pkill -f "polly-router/dist/server.js"
    sleep 1
fi

echo "2. Installing updated LaunchAgent plist..."
cp "$PLIST_SOURCE" "$PLIST_DEST"

# Load new service
echo "3. Loading new LaunchAgent..."
launchctl load "$PLIST_DEST"
sleep 2

# Verify
if pgrep -f "polly-router/dist/server.js" > /dev/null; then
    PID=$(pgrep -f "polly-router/dist/server.js")
    NODE_PATH=$(ps -p "$PID" -o comm=)
    echo ""
    echo "✅ Polly-Router running successfully!"
    echo "   PID: $PID"
    echo "   Node: $NODE_PATH"
else
    echo "❌ Failed to start Polly-Router"
    exit 1
fi

echo ""
echo "Migration complete."
