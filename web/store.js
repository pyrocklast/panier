// Panier's data layer.
//
// The list is a set of items. Every field of every item (text, section, pos, checked,
// checkedAt, deleted) is merged on its own: the most recent write wins, with the
// device id breaking ties. That lets two phones edit offline and converge.
//
// Changes are encrypted on the phone with a key the server never sees. The key also
// yields the list's id and access token, so a single secret (carried in the pairing
// link) is all a phone needs.

const STORAGE_KEY = "panier";
const MAX_UNDO = 100;
const text = new TextEncoder();

const b64 = bytes => btoa(String.fromCharCode(...bytes));
const fromB64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
const b64u = bytes => b64(new Uint8Array(bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const fromB64u = s => fromB64(s.replace(/-/g, "+").replace(/_/g, "/"));
const hex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
export const newId = () => b64u(crypto.getRandomValues(new Uint8Array(9)));

function blank(key, dev) {
  return { key, dev: dev || newId(), clock: 0, seq: 0, items: {}, devs: [], outbox: [] };
}
// Each field is stored as [value, time, device], the device as its place in devs, so
// its id is written once rather than in every field.
function devNo(st, dev) {
  const i = st.devs.indexOf(dev);
  return i >= 0 ? i : st.devs.push(dev) - 1;
}
// Deleted items are kept, so a late change from a phone that was offline can't bring
// them back, but only for about six months.
const FORGET_MS = 183 * 24 * 3600 * 1000;
function load() {
  try {
    const st = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (!st || !st.items || !Array.isArray(st.outbox)) return blank(null);
    if (!st.devs) { // stored by an earlier version, with each field's device id in full
      st.devs = [];
      for (const f of Object.values(st.items)) for (const v of Object.values(f)) v[2] = devNo(st, v[2]);
    }
    const before = Date.now() - FORGET_MS;
    for (const [id, f] of Object.entries(st.items)) {
      if (id[0] !== "#" && f.deleted && f.deleted[0] === true && f.deleted[1] < before) delete st.items[id];
    }
    return st;
  } catch (_) {
    return blank(null);
  }
}
let s = load();
// Writing the whole list takes a while once it's big, so changes close together are
// written once, and anything pending is written as soon as the app is put away.
let saveTimer = 0;
function saveNow() {
  clearTimeout(saveTimer);
  saveTimer = 0;
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(s)); } catch (_) {}
}
function save() {
  if (!saveTimer) saveTimer = setTimeout(saveNow, 400);
}
document.addEventListener("visibilitychange", () => { if (document.hidden && saveTimer) saveNow(); });
addEventListener("pagehide", () => { if (saveTimer) saveNow(); });

/* Listeners: kind is "local", "remote" or "status" */
const listeners = new Set();
export const subscribe = fn => { listeners.add(fn); return () => listeners.delete(fn); };
const emit = kind => listeners.forEach(fn => fn(kind));

/* ---------- Merging ---------- */

// The latest write wins; on a tie, the device id decides, the same way on every phone.
const newer = (a, b) => !b || a[1] > b[1] || (a[1] === b[1] && s.devs[a[2]] > s.devs[b[2]]);

function put(id, field, value, t, dev) {
  const item = (s.items[id] ||= {});
  const cand = [value, t, devNo(s, dev)];
  if (!newer(cand, item[field])) return false;
  item[field] = cand;
  return true;
}
const valueOf = (id, field) => (s.items[id] && s.items[id][field] ? s.items[id][field][0] : undefined);

function tick() {
  s.clock = Math.max(Date.now(), s.clock + 1);
  return s.clock;
}

// Items and sections share one map. A section's key is "#" followed by its id; the
// three default sections ("ess", "look", "long") are only stored once changed.
export function items() {
  const out = [];
  for (const [id, f] of Object.entries(s.items)) {
    if (id[0] === "#" || !f.text || (f.deleted && f.deleted[0])) continue;
    out.push({
      id,
      text: f.text[0],
      section: f.section ? f.section[0] : "ess",
      pos: f.pos ? f.pos[0] : 0,
      checked: !!(f.checked && f.checked[0]),
      checkedAt: f.checkedAt ? f.checkedAt[0] : 0,
    });
  }
  return out;
}

export function sections() {
  const out = [];
  for (const [key, f] of Object.entries(s.items)) {
    if (key[0] !== "#") continue;
    out.push({
      id: key.slice(1),
      name: f.name ? f.name[0] : undefined,
      pos: f.pos ? f.pos[0] : undefined,
      color: f.color ? f.color[0] : undefined,
      deleted: !!(f.deleted && f.deleted[0]),
    });
  }
  return out;
}

/* ---------- Local changes and undo ---------- */

const undoStack = [], redoStack = [];

// change applies [[id, field, value, fallback?], ...] as one step. fallback is the value
// to assume when the field was never stored, such as a default section's name, so undo
// can restore it. With a label, the step can be undone. Returns what changed as
// [id, field, newValue, previousValue] records.
export function change(label, ops) {
  const t = tick();
  const recs = [];
  for (const [id, field, value, fallback] of ops) {
    const stored = valueOf(id, field);
    const prev = stored === undefined ? fallback : stored;
    if (prev !== undefined && same(prev, value)) continue;
    put(id, field, value, t, s.dev);
    recs.push([id, field, value, prev]);
  }
  if (!recs.length) return null;
  s.outbox.push({ d: s.dev, o: recs.map(([id, field, value]) => [id, field, value, t]) });
  if (label) {
    undoStack.push({ label, recs });
    if (undoStack.length > MAX_UNDO) undoStack.shift();
    redoStack.length = 0;
  }
  save();
  emit("local");
  flushSoon();
  return recs;
}

// Reverse a step, but only the fields still holding what that step set: if the other
// phone has changed a field since, its change stands.
function reverse(recs) {
  const ops = [];
  for (const [id, field, next, prev] of recs) {
    if (!same(valueOf(id, field), next)) continue;
    const target = prev === undefined ? (field === "deleted" ? true : undefined) : prev;
    if (target !== undefined) ops.push([id, field, target]);
  }
  return change(null, ops);
}
// Returns { label, done }; done is false when the other phone had already changed
// everything this step touched.
function step(from, to) {
  const entry = from.pop();
  if (!entry) return null;
  const recs = reverse(entry.recs);
  if (recs) to.push({ label: entry.label, recs });
  return { label: entry.label, done: !!recs };
}
export const undo = () => step(undoStack, redoStack);
export const redo = () => step(redoStack, undoStack);
export const undoLabel = () => (undoStack.length ? undoStack[undoStack.length - 1].label : null);
export const redoLabel = () => (redoStack.length ? redoStack[redoStack.length - 1].label : null);

/* ---------- Keys and encryption ---------- */

let session = null; // { id, auth, key } derived from the list key

async function derive(raw) {
  const base = await crypto.subtle.importKey("raw", raw, "HKDF", false, ["deriveBits", "deriveKey"]);
  const p = info => ({ name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: text.encode(info) });
  return {
    id: hex(await crypto.subtle.deriveBits(p("panier list id"), base, 128)),
    auth: b64u(await crypto.subtle.deriveBits(p("panier auth"), base, 256)),
    key: await crypto.subtle.deriveKey(p("panier encryption"), base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]),
  };
}

// Changes are padded with spaces to a multiple of 256 bytes before encryption, so the
// server can't tell an item's name length from the size of what it stores.
const PAD = 256;
async function seal(obj) {
  const plain = text.encode(JSON.stringify(obj));
  const padded = new Uint8Array(Math.ceil((plain.length + 1) / PAD) * PAD).fill(0x20);
  padded.set(plain);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const params = { name: "AES-GCM", iv, additionalData: text.encode(session.id) };
  const ct = new Uint8Array(await crypto.subtle.encrypt(params, session.key, padded));
  const out = new Uint8Array(iv.length + ct.length);
  out.set(iv);
  out.set(ct, iv.length);
  return b64(out);
}
async function open(data) {
  const bytes = fromB64(data);
  const params = { name: "AES-GCM", iv: bytes.subarray(0, 12), additionalData: text.encode(session.id) };
  return JSON.parse(new TextDecoder().decode(await crypto.subtle.decrypt(params, session.key, bytes.subarray(12))));
}

export const hasList = () => !!s.key;
export const pairingLink = () => location.origin + "/#k=" + s.key;

// createList makes a new list on the server, using the server's setup code.
export async function createList(code) {
  const raw = crypto.getRandomValues(new Uint8Array(32));
  const d = await derive(raw);
  const res = await fetch("/api/lists", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Setup-Code": code.trim() },
    body: JSON.stringify({ id: d.id, auth: d.auth }),
  });
  if (!res.ok) throw new Error(res.status === 403 ? "code" : "server");
  s = blank(b64u(raw), s.dev);
  saveNow();
  session = d;
  start();
}

// join switches this phone to the list whose key is in a pairing link.
export async function join(key) {
  if (!/^[A-Za-z0-9_-]{43}$/.test(key)) throw new Error("link");
  if (key === s.key) return;
  stop();
  s = blank(key, s.dev);
  undoStack.length = redoStack.length = 0;
  saveNow();
  emit("remote");
}

/* ---------- Sync ---------- */

let state = "offline"; // "online", "offline", or "full" when the server has no room left for this list
let started = false, flushing = false, pulling = null, pullAgain = false, flushTimer = 0;
let wake = null, socket = null, reconnectNow = false, heard = 0;

export const status = () => ({ online: state === "online", full: state === "full", waiting: s.outbox.length });
function setState(next) {
  if (state !== next) { state = next; emit("status"); }
}

async function api(path, opts = {}) {
  const res = await fetch("/api/lists/" + session.id + path, {
    ...opts,
    headers: { ...opts.headers, Authorization: "Bearer " + session.auth },
  });
  if (!res.ok) throw new Error(res.status === 507 ? "full" : "HTTP " + res.status);
  return res;
}

function flushSoon() {
  clearTimeout(flushTimer);
  flushTimer = setTimeout(flush, 150);
}

async function flush() {
  if (!session || flushing || !s.outbox.length) return;
  flushing = true;
  try {
    const batch = s.outbox.slice(0, 100);
    const changes = await Promise.all(batch.map(seal));
    const res = await api("/changes", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ changes }) });
    const { latest } = await res.json();
    s.outbox.splice(0, batch.length);
    // Nothing else arrived in between: the server holds just what this phone already has.
    if (latest === s.seq + batch.length) s.seq = latest;
    save();
    setState("online");
    emit("status");
  } catch (err) {
    setState(err.message === "full" ? "full" : "offline");
  } finally {
    flushing = false;
  }
  if (heard > s.seq) pull(); // news that came in while sending, unless it was this phone's own
  heard = 0;
  if (s.outbox.length && state === "online") flushSoon();
}

function pull() {
  if (!session) return Promise.resolve();
  if (pulling) { pullAgain = true; return pulling; }
  pulling = (async () => {
    let changed = false;
    do {
      pullAgain = false;
      for (;;) {
        const { changes, latest } = await (await api("/changes?since=" + s.seq)).json();
        for (const c of changes) {
          try {
            const ch = await open(c.data);
            for (const [id, field, value, t] of ch.o) {
              s.clock = Math.max(s.clock, t);
              if (put(id, field, value, t, ch.d)) changed = true;
            }
          } catch (_) { /* unreadable change: written with another key, skip it */ }
          s.seq = c.seq;
        }
        if (!changes.length || s.seq >= latest) break;
      }
    } while (pullAgain);
    save();
    setState("online");
    if (changed) emit("remote");
  })().catch(() => setState("offline")).finally(() => { pulling = null; });
  return pulling;
}

const nap = ms => new Promise(r => { wake = r; setTimeout(r, ms); });

// connect opens the live-update WebSocket and resolves when it closes. The access
// token travels as a subprotocol, since browsers can't set headers on WebSockets.
function connect(current, onOpen) {
  return new Promise(resolve => {
    let ws, pinger = 0;
    try {
      const url = (location.protocol === "https:" ? "wss://" : "ws://") + location.host + "/api/lists/" + current.id + "/live";
      ws = new WebSocket(url, ["panier", current.auth]);
    } catch (_) {
      return resolve();
    }
    socket = ws;
    ws.onopen = () => {
      onOpen();
      pinger = setInterval(() => { try { ws.send("ping"); } catch (_) {} }, 30000);
    };
    ws.onmessage = e => {
      if (!/^\d+$/.test(e.data) || +e.data <= s.seq) return;
      if (flushing) heard = Math.max(heard, +e.data); // probably this phone's own changes: wait and see
      else pull();
    };
    ws.onclose = () => {
      clearInterval(pinger);
      if (socket === ws) socket = null;
      resolve();
    };
  });
}

// listen keeps a live connection open and pulls whenever the server reports news.
async function listen() {
  let delay = 1000;
  while (session) {
    const current = session;
    await connect(current, () => {
      delay = 1000;
      setState("online");
      flush();
    });
    if (session !== current) return;
    if (reconnectNow) { reconnectNow = false; continue; } // resumed on purpose
    if (state !== "full") setState("offline");
    await nap(delay);
    delay = Math.min(delay * 2, 30000);
  }
}

export async function start() {
  if (!s.key || started) return;
  started = true;
  session = session || (await derive(fromB64u(s.key)));
  pull();
  listen();
}
function stop() {
  started = false;
  session = null;
  if (socket) socket.close();
}

// Phones drop connections in the background, sometimes without noticing; reconnect
// and catch up as soon as the app is back.
function resume() {
  if (!session) return;
  if (socket && socket.readyState === WebSocket.OPEN) { reconnectNow = true; socket.close(); }
  if (wake) wake();
  pull();
  flush();
}
document.addEventListener("visibilitychange", () => { if (!document.hidden) resume(); });
addEventListener("online", resume);
// Another tab saved the list: take its copy, rather than later writing this one over it.
addEventListener("storage", e => {
  if (e.key !== STORAGE_KEY) return;
  clearTimeout(saveTimer);
  saveTimer = 0;
  s = load();
  emit("remote");
});
