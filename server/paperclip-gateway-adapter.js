"use strict";

// Paperclip → Claw3D gateway adapter.
//
// A read-only observer that maps a Paperclip fleet into the Claw3D office. It
// speaks the SAME gateway protocol as server/demo-gateway-adapter.js (connect →
// hello-ok, then agents.list / status / sessions.* methods and presence events),
// but sources agents and their live activity from a running Paperclip instance.
//
// Config (env):
//   PAPERCLIP_API_URL       e.g. http://localhost:3100   (Paperclip server origin)
//   PAPERCLIP_API_KEY       a Paperclip API key (sent as Bearer + x-api-key)
//   PAPERCLIP_COMPANY_ID    which company/fleet to visualize
//   PAPERCLIP_ADAPTER_PORT  websocket port (default 18789 — same as demo)
//   PAPERCLIP_POLL_MS       agent refresh interval (default 5000)
//
// When the three PAPERCLIP_* connection vars are unset, the adapter starts in
// DEMO mode with a small static roster so `npm run dev` still shows an office.

const http = require("http");
const { randomUUID } = require("crypto");
const { WebSocketServer } = require("ws");

const ADAPTER_PORT = parseInt(process.env.PAPERCLIP_ADAPTER_PORT || "18789", 10);
const API_URL = (process.env.PAPERCLIP_API_URL || "").replace(/\/+$/, "");
const API_KEY = process.env.PAPERCLIP_API_KEY || "";
const COMPANY_ID = process.env.PAPERCLIP_COMPANY_ID || "";
const POLL_MS = Math.max(1500, parseInt(process.env.PAPERCLIP_POLL_MS || "5000", 10));
const LIVE = Boolean(API_URL && API_KEY && COMPANY_ID);
const MAIN_KEY = "main";
const MODELS = [{ id: "paperclip/fleet", name: "Paperclip Fleet", provider: "paperclip" }];

// Paperclip agent status → Claw3D office presence. "Active" agents (running /
// active) are reported as having a live session so the office animates them at
// their desks; the rest read as idle. (See docs STATUS_PRESENCE_MAP.)
const ACTIVE_STATUSES = new Set(["running", "active"]);
const PRESENCE_BY_STATUS = {
  running: "focused",
  active: "working",
  idle: "idle",
  paused: "waiting",
  pending_approval: "waiting",
  error: "error",
  terminated: "idle",
};

const DEMO_AGENTS = [
  { id: "demo-orchestrator", name: "Avery", role: "Orchestrator", workspace: "/demo/orchestrator", status: "active" },
  { id: "demo-researcher", name: "Mika", role: "Research", workspace: "/demo/research", status: "idle" },
  { id: "demo-builder", name: "Rune", role: "Builder", workspace: "/demo/builder", status: "running" },
];

/** id → { id, name, role, workspace, status } */
let agents = new Map();
const activeSendEventFns = new Set();

function randomId() {
  return randomUUID().replace(/-/g, "");
}

function sessionKeyFor(agentId) {
  return `agent:${agentId}:${MAIN_KEY}`;
}

function resOk(id, payload) {
  return { type: "res", id, ok: true, payload: payload ?? {} };
}

function resErr(id, code, message) {
  return { type: "res", id, ok: false, error: { code, message } };
}

function broadcastEvent(frame) {
  for (const send of activeSendEventFns) {
    try {
      send(frame);
    } catch {}
  }
}

async function fetchPaperclipAgents() {
  const url = `${API_URL}/api/companies/${encodeURIComponent(COMPANY_ID)}/agents`;
  const res = await fetch(url, {
    headers: { authorization: `Bearer ${API_KEY}`, "x-api-key": API_KEY, accept: "application/json" },
  });
  if (!res.ok) {
    throw new Error(`GET ${url} → ${res.status} ${res.statusText}`);
  }
  const list = await res.json();
  if (!Array.isArray(list)) throw new Error("agents response was not an array");
  return list
    .filter((a) => a && a.status !== "terminated")
    .map((a) => ({
      id: String(a.id),
      name: String(a.name ?? a.id),
      role: String(a.title || a.role || "agent"),
      workspace: `/paperclip/${String(a.urlKey || a.role || "agent")}`,
      status: String(a.status || "idle"),
    }));
}

/** Refresh the roster. Returns true when the active-agent set changed. */
async function refreshAgents() {
  let next;
  if (LIVE) {
    try {
      next = await fetchPaperclipAgents();
    } catch (error) {
      console.error(`[paperclip-gateway] refresh failed: ${error.message}`);
      return false;
    }
  } else {
    next = DEMO_AGENTS.map((a) => ({ ...a }));
  }
  const beforeActive = activeAgentIds().join(",");
  agents = new Map(next.map((a) => [a.id, a]));
  return activeAgentIds().join(",") !== beforeActive;
}

function activeAgentIds() {
  return [...agents.values()].filter((a) => ACTIVE_STATUSES.has(a.status)).map((a) => a.id).sort();
}

function defaultAgentId() {
  const first = [...agents.keys()][0];
  return first || "paperclip";
}

function agentListPayload() {
  return [...agents.values()].map((agent) => ({
    id: agent.id,
    name: agent.name,
    workspace: agent.workspace,
    identity: { name: agent.name, emoji: "📎" },
    role: agent.role,
    presence: PRESENCE_BY_STATUS[agent.status] || "idle",
  }));
}

// Presence payload: report a "recent session" for every currently-active agent
// so the office seats and animates them; idle agents produce no recent entry.
function presencePayload() {
  const now = Date.now();
  const active = [...agents.values()].filter((a) => ACTIVE_STATUSES.has(a.status));
  const recent = active.map((a) => ({ key: sessionKeyFor(a.id), updatedAt: now }));
  return {
    sessions: {
      recent,
      byAgent: [...agents.values()].map((a) => ({
        agentId: a.id,
        recent: ACTIVE_STATUSES.has(a.status) ? [{ key: sessionKeyFor(a.id), updatedAt: now }] : [],
      })),
    },
  };
}

function sessionsListPayload() {
  return [...agents.values()].map((agent) => ({
    key: sessionKeyFor(agent.id),
    agentId: agent.id,
    updatedAt: ACTIVE_STATUSES.has(agent.status) ? Date.now() : null,
    displayName: "Main",
    origin: { label: agent.name, provider: "paperclip" },
    model: MODELS[0].id,
    modelProvider: "paperclip",
  }));
}

async function handleMethod(method, params, id) {
  const p = params || {};
  switch (method) {
    case "agents.list":
      return resOk(id, { defaultId: defaultAgentId(), mainKey: MAIN_KEY, agents: agentListPayload() });

    case "sessions.list":
      return resOk(id, { sessions: sessionsListPayload() });

    case "sessions.preview": {
      const keys = Array.isArray(p.keys) ? p.keys : [];
      return resOk(id, {
        ts: Date.now(),
        previews: keys.map((key) => ({ key, status: "empty", items: [] })),
      });
    }

    case "sessions.patch":
      return resOk(id, { ok: true, key: p.key, resolved: { model: MODELS[0].id, modelProvider: "paperclip" } });

    case "sessions.reset":
      return resOk(id, { ok: true });

    case "status":
      return resOk(id, presencePayload());

    case "chat.history":
      return resOk(id, { sessionKey: p.sessionKey || sessionKeyFor(defaultAgentId()), messages: [] });

    case "chat.send":
      // Read-only observer: the office visualizes Paperclip; it does not drive runs.
      return resOk(id, { status: "no-op", runId: randomId() });

    case "chat.abort":
      return resOk(id, { ok: true, aborted: 0 });

    case "models.list":
      return resOk(id, { models: MODELS });

    case "skills.status":
      return resOk(id, { skills: [] });

    case "cron.list":
      return resOk(id, { jobs: [] });

    case "config.get":
      return resOk(id, { config: {}, hash: "paperclip-gateway", exists: true, path: "/paperclip/config.json" });

    case "config.set":
    case "config.patch":
      return resOk(id, { hash: "paperclip-gateway" });

    case "exec.approvals.get":
      return resOk(id, {
        path: "",
        exists: true,
        hash: "paperclip-approvals",
        file: { version: 1, defaults: { security: "full", ask: "off", autoAllowSkills: true }, agents: {} },
      });

    case "exec.approvals.set":
      return resOk(id, { hash: "paperclip-approvals" });

    case "exec.approval.resolve":
      return resOk(id, { ok: true });

    case "agents.files.get":
      return resOk(id, { file: { missing: true } });

    case "agents.files.set":
      return resOk(id, {});

    case "wake":
      return resOk(id, { ok: true });

    default:
      return resOk(id, {});
  }
}

function helloPayload() {
  return {
    type: "hello-ok",
    protocol: 3,
    adapterType: "paperclip",
    features: {
      methods: [
        "agents.list",
        "sessions.list",
        "sessions.preview",
        "sessions.patch",
        "sessions.reset",
        "chat.history",
        "chat.send",
        "chat.abort",
        "status",
        "config.get",
        "config.set",
        "config.patch",
        "exec.approvals.get",
        "exec.approvals.set",
        "exec.approval.resolve",
        "agents.files.get",
        "agents.files.set",
        "wake",
        "skills.status",
        "models.list",
        "cron.list",
      ],
      events: ["presence", "heartbeat"],
    },
    snapshot: {
      health: {
        agents: [...agents.values()].map((agent) => ({
          agentId: agent.id,
          name: agent.name,
          isDefault: agent.id === defaultAgentId(),
        })),
        defaultAgentId: defaultAgentId(),
      },
      sessionDefaults: { mainKey: MAIN_KEY },
    },
    auth: { role: "operator", scopes: ["operator.admin"] },
    policy: { tickIntervalMs: POLL_MS },
  };
}

async function startAdapter() {
  await refreshAgents();

  const httpServer = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end(`Claw3D Paperclip Gateway Adapter (${LIVE ? "live" : "demo"})\n`);
  });

  const wss = new WebSocketServer({ server: httpServer });
  wss.on("connection", (ws) => {
    let connected = false;
    let globalSeq = 0;

    const send = (frame) => {
      if (ws.readyState !== ws.OPEN) return;
      ws.send(JSON.stringify(frame));
    };
    const sendEventFn = (frame) => {
      if (frame.type === "event" && typeof frame.seq !== "number") frame.seq = globalSeq++;
      send(frame);
    };

    activeSendEventFns.add(sendEventFn);
    send({ type: "event", event: "connect.challenge", payload: { nonce: randomId() } });

    ws.on("message", async (raw) => {
      let frame;
      try {
        frame = JSON.parse(raw.toString("utf8"));
      } catch {
        return;
      }
      if (!frame || typeof frame !== "object" || frame.type !== "req") return;
      const { id, method, params } = frame;
      if (typeof id !== "string" || typeof method !== "string") return;

      if (method === "connect") {
        connected = true;
        send({ type: "res", id, ok: true, payload: helloPayload() });
        // Push an initial presence snapshot right after connect.
        sendEventFn({ type: "event", event: "presence", payload: presencePayload() });
        return;
      }
      if (!connected) {
        send(resErr(id, "not_connected", "Send connect first."));
        return;
      }
      try {
        send(await handleMethod(method, params, id));
      } catch (error) {
        send(resErr(id, "internal_error", error instanceof Error ? error.message : "Internal error"));
      }
    });

    ws.on("close", () => activeSendEventFns.delete(sendEventFn));
    ws.on("error", () => activeSendEventFns.delete(sendEventFn));
  });

  // Poll Paperclip; broadcast presence when the active-agent set changes.
  setInterval(async () => {
    const changed = await refreshAgents();
    if (changed) broadcastEvent({ type: "event", event: "presence", payload: presencePayload() });
  }, POLL_MS).unref();

  httpServer.listen(ADAPTER_PORT, "127.0.0.1", () => {
    console.log(`[paperclip-gateway] Listening on ws://localhost:${ADAPTER_PORT} (${LIVE ? "LIVE" : "DEMO"} mode)`);
    if (LIVE) {
      console.log(`[paperclip-gateway] Fleet: ${API_URL} company=${COMPANY_ID} (${agents.size} agents)`);
    } else {
      console.log("[paperclip-gateway] Set PAPERCLIP_API_URL / PAPERCLIP_API_KEY / PAPERCLIP_COMPANY_ID for live data.");
    }
  });
}

if (require.main === module) {
  startAdapter();
}

module.exports = { handleMethod, startAdapter, refreshAgents };
