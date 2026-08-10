# Claw3D × Paperclip

Visualize a live [Paperclip](https://github.com/paperclipai/paperclip) fleet inside the Claw3D
office. `server/paperclip-gateway-adapter.js` is a **read-only observer**: it speaks the same
gateway protocol Claw3D Studio already uses (see `server/demo-gateway-adapter.js`) but sources
agents and their live activity from a running Paperclip instance.

It does not drive agent runs — the office *shows* what Paperclip is doing.

## Configuration (env)

| Var | Required | Example | Notes |
|-----|----------|---------|-------|
| `PAPERCLIP_API_URL` | live | `http://localhost:3100` | Paperclip server origin |
| `PAPERCLIP_API_KEY` | live | `pk_…` | Sent as `Authorization: Bearer` + `x-api-key` |
| `PAPERCLIP_COMPANY_ID` | live | `54f418d2-…` | Which company/fleet to show |
| `PAPERCLIP_ADAPTER_PORT` | no | `18789` | WebSocket port (default, same as demo) |
| `PAPERCLIP_POLL_MS` | no | `5000` | Agent refresh interval |

If the three connection vars are **unset**, the adapter starts in **demo mode** with a small
static roster, so `npm run dev` still shows an office.

## Run

**Demo (no Paperclip needed):**
```bash
npm run paperclip-gateway   # ws://localhost:18789, demo roster
npm run dev                 # Studio; connect to ws://localhost:18789
```

**Live (against a real fleet):**
```bash
PAPERCLIP_API_URL=http://localhost:3100 \
PAPERCLIP_API_KEY=<your-key> \
PAPERCLIP_COMPANY_ID=<company-id> \
npm run paperclip-gateway

npm run dev                 # Studio; connect to ws://localhost:18789
```

It reads `GET {PAPERCLIP_API_URL}/api/companies/{COMPANY_ID}/agents` and re-polls every
`PAPERCLIP_POLL_MS`, broadcasting `presence` events when the active-agent set changes.

## Status → office presence

| Paperclip status | Office presence |
|------------------|-----------------|
| `running` | focused (active session) |
| `active` | working (active session) |
| `idle` | idle |
| `paused` / `pending_approval` | waiting |
| `error` | error |
| `terminated` | hidden |

## Embed in the Paperclip "Office" tab

The Paperclip UI has an `Office` sub-tab that embeds a Claw3D URL via an iframe (flag
`office3dUrl`). To allow embedding, start Studio with the parent origin whitelisted:

```bash
CLAW3D_FRAME_ANCESTORS="http://localhost:5173" npm run dev
```

This widens the CSP `frame-ancestors` and drops `X-Frame-Options` **only when set** (default
stays same-origin/secure). Then set Paperclip's `office3dUrl` to the Studio URL (e.g.
`http://localhost:3009`).

## Scope / limitations

- MVP surface: `agents.list`, `status`/`presence`, `sessions.list`. Chat/exec are stubbed
  (read-only). Extend `handleMethod` to add more.
- Paperclip exposes company-scoped REST (`/api/companies/:id/agents`), not a `/api/v1` API.
