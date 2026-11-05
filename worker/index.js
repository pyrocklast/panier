// Panier on Cloudflare Workers. It implements the same small API as the Go server
// (main.go, api.go, store.go): the app works with either, unchanged.
//
// Each list is a Durable Object holding, in its own SQLite database, the SHA-256 hash
// of the list's access token and the encrypted changes in arrival order. Like the Go
// server, it cannot read the lists it stores.
//
// Live updates use WebSockets with Cloudflare's hibernation API: between changes the
// object sleeps and connected phones cost nothing.

import { DurableObject } from "cloudflare:workers";

const MAX_BODY = 256 * 1024; // per request
const MAX_CHANGE = 16 * 1024; // per encrypted change
const MAX_PER_REQUEST = 200;
const MAX_PER_PAGE = 1000;
const MAX_LISTENERS = 16; // live connections per list
const DEFAULT_MAX_LOG_BYTES = 32 * 1024 * 1024; // several years of use for two people

const ID = /^[0-9a-f]{32}$/;
const TOKEN = /^[A-Za-z0-9_-]{43}$/; // 32 bytes, base64url without padding
const CHANGE = /^[A-Za-z0-9+/]+={0,2}$/;

const HEADERS = {
  "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Cache-Control": "no-store",
};

function text(status, body) {
  return new Response(body + "\n", { status, headers: { ...HEADERS, "Content-Type": "text/plain; charset=utf-8" } });
}
function json(status, value) {
  return new Response(JSON.stringify(value), { status, headers: { ...HEADERS, "Content-Type": "application/json" } });
}

const encoder = new TextEncoder();
const sha256 = async bytes => new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
const fromHex = s => Uint8Array.from(s.match(/../g), b => parseInt(b, 16));
const toHex = bytes => [...bytes].map(b => b.toString(16).padStart(2, "0")).join("");
function fromB64url(s) {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4);
  return Uint8Array.from(atob(b64), c => c.charCodeAt(0));
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// Reads a request body, refusing more than max bytes.
async function readBody(req, max) {
  if (Number(req.headers.get("Content-Length")) > max) throw new Error("too large");
  if (!req.body) return "";
  const reader = req.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > max) {
      reader.cancel();
      throw new Error("too large");
    }
    chunks.push(value);
  }
  const all = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    all.set(c, at);
    at += c.length;
  }
  return new TextDecoder().decode(all);
}

// The token comes in the Authorization header, or, for live updates, as the second
// WebSocket subprotocol, since browsers can't set headers on WebSockets.
function tokenOf(req, live) {
  if (!live) {
    const t = (req.headers.get("Authorization") || "").replace(/^Bearer /, "");
    return TOKEN.test(t) ? t : null;
  }
  const offered = (req.headers.get("Sec-WebSocket-Protocol") || "").split(",").map(p => p.trim());
  if (!offered.includes("panier")) return null;
  return offered.find(p => TOKEN.test(p)) || null;
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname === "/api/lists") {
      return req.method === "POST" ? createList(req, env) : text(405, "method not allowed");
    }
    const m = url.pathname.match(/^\/api\/lists\/([^/]+)\/(changes|live)$/);
    if (!m) return text(404, "not found");
    if (!ID.test(m[1])) return text(404, "no such list");
    return env.LISTS.get(env.LISTS.idFromName(m[1])).fetch(req);
  },
};

// createList registers a new list. It needs the setup code (the SETUP_CODE secret),
// so only whoever deployed the Worker can create lists.
async function createList(req, env) {
  const norm = s => (s || "").trim().toUpperCase();
  const want = norm(env.SETUP_CODE);
  const [a, b] = await Promise.all([sha256(encoder.encode(norm(req.headers.get("X-Setup-Code")))), sha256(encoder.encode(want))]);
  if (!want || !crypto.subtle.timingSafeEqual(a, b)) {
    await sleep(1000); // the code is too long to guess; this keeps automated guessing slow too
    return text(403, "wrong setup code");
  }
  let body;
  try {
    body = JSON.parse(await readBody(req, 4096));
  } catch (_) {
    return text(400, "bad request");
  }
  if (!body || typeof body.id !== "string" || !ID.test(body.id) || typeof body.auth !== "string" || !TOKEN.test(body.auth)) {
    return text(400, "bad id or token");
  }
  const hash = toHex(await sha256(fromB64url(body.auth)));
  const created = await env.LISTS.get(env.LISTS.idFromName(body.id)).create(hash);
  return created ? new Response(null, { status: 201, headers: HEADERS }) : text(409, "list already exists");
}

export class List extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.maxLogBytes = Number(env.MAX_LOG_BYTES) || DEFAULT_MAX_LOG_BYTES;
    // Keepalive pings are answered without waking the object.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  // Returns the stored token hash, or null if this list was never created. Reading a
  // list that doesn't exist writes nothing, so stray requests leave no trace.
  meta() {
    try {
      const rows = this.sql.exec("SELECT k, v FROM meta").toArray();
      return Object.fromEntries(rows.map(r => [r.k, r.v]));
    } catch (_) {
      return null; // no tables yet
    }
  }

  async create(authHex) {
    if (this.meta()) return false;
    this.ctx.storage.transactionSync(() => {
      this.sql.exec("CREATE TABLE meta (k TEXT PRIMARY KEY, v)");
      this.sql.exec("CREATE TABLE changes (seq INTEGER PRIMARY KEY, data TEXT NOT NULL)");
      this.sql.exec("INSERT INTO meta (k, v) VALUES ('auth', ?), ('size', 0)", authHex);
    });
    return true;
  }

  latest() {
    return this.sql.exec("SELECT coalesce(max(seq), 0) AS n FROM changes").one().n;
  }

  async fetch(req) {
    const live = new URL(req.url).pathname.endsWith("/live");
    const token = tokenOf(req, live);
    if (!token) return text(401, "missing token");
    const meta = this.meta();
    if (!meta) return text(404, "no such list");
    const sum = await sha256(fromB64url(token));
    if (!crypto.subtle.timingSafeEqual(sum, fromHex(meta.auth))) return text(401, "wrong token");

    if (live) return this.live(req);
    if (req.method === "GET") return this.getChanges(req);
    if (req.method === "POST") return this.postChanges(req, meta);
    return text(405, "method not allowed");
  }

  getChanges(req) {
    const since = new URL(req.url).searchParams.get("since");
    let n = 0;
    if (since !== null && since !== "") {
      if (!/^\d{1,15}$/.test(since)) return text(400, "since must be a sequence number");
      n = Number(since);
    }
    const changes = this.sql
      .exec("SELECT seq, data FROM changes WHERE seq > ? ORDER BY seq LIMIT ?", n, MAX_PER_PAGE)
      .toArray()
      .map(r => ({ seq: r.seq, data: r.data }));
    return json(200, { changes, latest: this.latest() });
  }

  async postChanges(req, meta) {
    let body;
    try {
      body = JSON.parse(await readBody(req, MAX_BODY));
    } catch (_) {
      return text(400, "bad request");
    }
    const changes = body && body.changes;
    if (!Array.isArray(changes) || changes.length === 0 || changes.length > MAX_PER_REQUEST) {
      return text(400, "send between 1 and 200 changes");
    }
    let bytes = 0;
    for (const c of changes) {
      if (typeof c !== "string" || c.length > MAX_CHANGE || !CHANGE.test(c)) return text(400, "changes must be base64");
      bytes += c.length + 1; // counted like the Go server's log lines
    }
    const size = Number(meta.size) + bytes;
    if (size > this.maxLogBytes) return text(507, "this list is full");

    // All or nothing: the changes and the new size are saved in one transaction.
    this.ctx.storage.transactionSync(() => {
      for (const c of changes) this.sql.exec("INSERT INTO changes (data) VALUES (?)", c);
      this.sql.exec("UPDATE meta SET v = ? WHERE k = 'size'", size);
    });
    const latest = this.latest();
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(String(latest));
      } catch (_) {}
    }
    return json(200, { latest });
  }

  live(req) {
    if ((req.headers.get("Upgrade") || "").toLowerCase() !== "websocket") return text(426, "expected a WebSocket");
    if (this.ctx.getWebSockets().length >= MAX_LISTENERS) return text(429, "too many connections");
    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server);
    server.send(String(this.latest()));
    return new Response(null, { status: 101, webSocket: client, headers: { "Sec-WebSocket-Protocol": "panier" } });
  }

  webSocketMessage() {
    // Phones only send keepalive pings, which are answered automatically.
  }

  webSocketClose(ws, code) {
    try {
      ws.close(code === 1005 || code === 1006 ? 1000 : code, "bye");
    } catch (_) {}
  }
}
