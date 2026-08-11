#!/bin/bash
# Auto-start wrapper for the CLAW3D -> Paperclip gateway adapter.
#
# Reads the live fleet token fresh from the local board-auth store at each launch
# (plain JSON read, never printed, never baked into the plist). If no token is
# present it falls back to DEMO mode so Studio still shows an office.
#
# Loaded at login by ~/Library/LaunchAgents/com.trev.claw3d-paperclip-gateway.plist
set -uo pipefail

export PATH="/opt/homebrew/bin:${PATH}"

CLAW3D_DIR="/Users/trev/claw3d"
API_URL="${PAPERCLIP_API_URL:-http://localhost:3100}"
COMPANY_ID="${PAPERCLIP_COMPANY_ID:-54f418d2-d1ef-400f-9f09-684246293de1}"
AUTH_STORE="${HOME}/.paperclip/auth.json"

# Token read: plain JSON, no tsx/npx. Emits the token to stdout (captured, never logged).
TOKEN="$(API_URL="$API_URL" AUTH_STORE="$AUTH_STORE" node -e \
  'const fs=require("fs");try{const s=JSON.parse(fs.readFileSync(process.env.AUTH_STORE,"utf8"));const c=s.credentials?.[process.env.API_URL];process.stdout.write(c?.token??"")}catch{process.stdout.write("")}')"

if [ -z "$TOKEN" ]; then
  echo "[gateway-wrapper] no token for $API_URL -> starting DEMO mode" >&2
  exec node "$CLAW3D_DIR/server/paperclip-gateway-adapter.js"
fi

echo "[gateway-wrapper] token resolved (${#TOKEN} chars) -> LIVE against $API_URL" >&2
export PAPERCLIP_API_URL="$API_URL"
export PAPERCLIP_COMPANY_ID="$COMPANY_ID"
export PAPERCLIP_API_KEY="$TOKEN"
exec node "$CLAW3D_DIR/server/paperclip-gateway-adapter.js"
