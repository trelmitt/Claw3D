#!/bin/bash
# Auto-start wrapper for CLAW3D Studio (the :3010 dev server that renders the office).
#
# Serves on PORT (default 3010) and whitelists the Paperclip UI origin so the office
# can be embedded in Paperclip's "Office" tab. Loaded at login by
# ~/Library/LaunchAgents/com.trev.claw3d-studio.plist
set -uo pipefail

export PATH="/opt/homebrew/bin:${PATH}"
cd /Users/trev/claw3d || exit 1

export PORT="${PORT:-3010}"
export CLAW3D_FRAME_ANCESTORS="${CLAW3D_FRAME_ANCESTORS:-http://localhost:5173}"

echo "[studio-wrapper] starting Studio on :${PORT} (frame-ancestors: ${CLAW3D_FRAME_ANCESTORS})" >&2
exec node server/index.js --dev
