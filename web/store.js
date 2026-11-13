// Panier's data layer: the lists on this phone.
//
// A list is a set of items. Every field of every item (text, section, pos, checked,
// checkedAt, deleted) is merged on its own: the most recent write wins, with the
// device id breaking ties. That lets phones edit offline and converge.
//
// Changes are encrypted on the phone with a key the server never sees. The key also
// yields the list's id and access token, so a single secret (carried in the pairing
// link) is all a phone needs.
//
// A phone keeps an index of its lists, in the order they're shown, with what each one
// looked like last time (its name, colour and what's left to get), so the lists page
// draws without opening them; and one storage entry per list. Only the list on screen
// listens live. The others catch up when the lists page shows, and send what they have
// waiting whenever the connection returns.

const INDEX = "panier2"; // this phone's id and name, and its lists
const ENTRY = "panier2:"; // one list, by its id on this phone
const FORMAT = 1; // what this app reads; a list can ask for more with "@list" "format"
const MAX_UNDO = 100;
const text = new TextEncoder();

const b64 = bytes => btoa(String.fromCharCode(...bytes));
const fromB64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
const b64u = bytes => b64(new Uint8Array(bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const fromB64u = s => fromB64(s.replace(/-/g, "+").replace(/_/g, "/"));
const hex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
export const newId = () => b64u(crypto.getRandomValues(new Uint8Array(9)));
const KEY = /^[A-Za-z0-9_-]{43}$/; // a list key: 32 bytes, in base64url

/* Listeners: kind is "local", "remote" or "status" for the list on screen, "lists" for the index */
const listeners = new Set();
export const subscribe = fn => { listeners.add(fn); return () => listeners.delete(fn); };
const emit = kind => listeners.forEach(fn => fn(kind));

/* ---------- The index ---------- */

function loadIndex() {
  try {
    const ix = JSON.parse(localStorage.getItem(INDEX));
    if (ix && ix.dev && Array.isArray(ix.lists)) return ix;
  } catch (_) {}
  return { dev: newId(), name: "", open: null, lists: [] };
}
let index = loadIndex();
let indexTimer = 0;
function saveIndexNow() {
  clearTimeout(indexTimer);
  indexTimer = 0;
  try { localStorage.setItem(INDEX, JSON.stringify(index)); } catch (_) {}
}
const saveIndex = () => { if (!indexTimer) indexTimer = setTimeout(saveIndexNow, 400); };
const entryOf = lid => index.lists.find(e => e.lid === lid);

// The lists, in order: { lid, key, name, color, toGet, first, with, closed, newer, folded },
// as last seen.
export const lists = () => index.lists;
export const openId = () => index.open;

/* ---------- One list ---------- */

// Deleted items are kept, so a late change from a phone that was offline can't bring
// them back, but only for about six months.
const FORGET_MS = 183 * 24 * 3600 * 1000;
const blank = key => ({ key, clock: 0, seq: 0, items: {}, devs: [], outbox: [] });
// The three sections a list starts with, as model.js names them, in their first order.
const DEFAULT_POS = { ess: 1, look: 2, long: 3 };
const isItem = id => id[0] !== "#" && id[0] !== "@";
const MEMBER = "@m/"; // a phone on the list: "@m/" + its id, with "on" and, if given, "name"

// Changes are padded with spaces to a multiple of 256 bytes before encryption, so the
// server can't tell an item's name length from the size of what it stores. A change
// holding more than CHUNK bytes, such as an import, is sent as several, each well
// under the server's 16 KiB once encrypted and in base64; it is still one step to undo.
const PAD = 256, CHUNK = 6000, BATCH = 192 * 1024;

async function derive(raw) {
  const base = await crypto.subtle.importKey("raw", raw, "HKDF", false, ["deriveBits", "deriveKey"]);
  const p = info => ({ name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: text.encode(info) });
  return {
    id: hex(await crypto.subtle.deriveBits(p("panier list id"), base, 128)),
    auth: b64u(await crypto.subtle.deriveBits(p("panier auth"), base, 256)),
    key: await crypto.subtle.deriveKey(p("panier encryption"), base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]),
  };
}

class List {
  constructor(lid, fresh) {
    this.lid = lid;
    this.s = fresh || this.load();
    this.reset();
    this.undoStack = [];
    this.redoStack = [];
    this.fresh = new Set(); // items others added, renamed, moved, ticked or unticked, for the page to point out
    this.session = null; // { id, auth, key } derived from the list key
    this.deriving = null;
    this.state = this.s.closed ? "closed" : "offline"; // "online", "offline", "full" when the server has no room, or "closed"
    this.flushing = false;
    this.pulling = null;
    this.pullAgain = false;
    this.flushTimer = 0;
    this.saveTimer = 0;
    this.heard = 0;
    this.live = false; // listening live: only the list on screen does
    this.socket = null;
    this.reconnectNow = false;
    this.wake = null;
  }
  // The items are worked out once per list and then kept up to date: a change redoes
  // only the items it touched, so a tap costs the same however long the list has grown.
  // Each item has a slot in the order the map holds them, kept while it's deleted, so the
  // list comes out in the same order as when worked out afresh. Item objects are only read.
  reset() {
    this.view = null; // id → item, or null for a deleted one
    this.ordered = null; // the items in order
    this.touched = new Set(); // ids written since items() last looked
    this.sectionKeys = null;
  }
  load() {
    try {
      const st = JSON.parse(localStorage.getItem(ENTRY + this.lid));
      if (st && st.key && st.items && Array.isArray(st.outbox)) {
        const before = Date.now() - FORGET_MS;
        for (const [id, f] of Object.entries(st.items)) {
          if (isItem(id) && f.deleted && f.deleted[0] === true && f.deleted[1] < before) delete st.items[id];
        }
        return st;
      }
    } catch (_) {}
    const e = entryOf(this.lid);
    return blank(e && e.key);
  }
  // Writing the whole list takes a while once it's big, so changes close together are
  // written once, and anything pending is written as soon as the app is put away.
  saveNow() {
    clearTimeout(this.saveTimer);
    this.saveTimer = 0;
    if (this.gone || this.unsaved) return; // taken off this phone, replaced by a copy, or a copy not yet in place
    try { localStorage.setItem(ENTRY + this.lid, JSON.stringify(this.s)); } catch (_) {}
  }
  save() {
    if (!this.saveTimer) this.saveTimer = setTimeout(() => this.saveNow(), 400);
  }

  /* Merging */

  // Each field is stored as [value, time, device], the device as its place in devs, so
  // its id is written once rather than in every field.
  devNo(d) {
    const i = this.s.devs.indexOf(d);
    return i >= 0 ? i : this.s.devs.push(d) - 1;
  }
  // The latest write wins; on a tie, the device id decides, the same way on every phone.
  newer(a, b) {
    return !b || a[1] > b[1] || (a[1] === b[1] && this.s.devs[a[2]] > this.s.devs[b[2]]);
  }
  put(id, field, value, t, d) {
    if (id[0] === "#" && this.sectionKeys) this.sectionKeys.add(id);
    const item = (this.s.items[id] ||= {});
    const cand = [value, t, this.devNo(d)];
    if (!this.newer(cand, item[field])) return false;
    item[field] = cand;
    this.touched.add(id);
    return true;
  }
  valueOf(id, field) {
    const f = this.s.items[id];
    return f && f[field] ? f[field][0] : undefined;
  }
  tick() {
    this.s.clock = Math.max(Date.now(), this.s.clock + 1);
    return this.s.clock;
  }

  /* Reading */

  // Items, sections, the list's own name and the phones on it share one map. A section's
  // key is "#" followed by its id; the three default sections ("ess", "look", "long") are
  // only stored once changed. The list's name and colour are under "@list", each phone
  // under "@m/" and its id. Item ids never start with either sign.
  items() {
    if (!this.view) {
      this.view = new Map();
      for (const [id, f] of Object.entries(this.s.items)) if (isItem(id)) this.view.set(id, itemOf(id, f));
      this.touched.clear();
      this.ordered = null;
    }
    if (this.touched.size) {
      for (const id of this.touched) if (isItem(id)) this.view.set(id, itemOf(id, this.s.items[id]));
      this.touched.clear();
      this.ordered = null;
    }
    return this.ordered || (this.ordered = [...this.view.values()].filter(Boolean));
  }
  sections() {
    this.sectionKeys ||= new Set(Object.keys(this.s.items).filter(id => id[0] === "#"));
    const out = [];
    for (const key of this.sectionKeys) {
      const f = this.s.items[key];
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
  // A list written by a newer version of Panier than this one is left alone.
  newerFormat() {
    return (this.valueOf("@list", "format") || 1) > FORMAT;
  }
  // The phones on this list, this one first, then in the order they joined.
  members() {
    const me = index.dev, out = [];
    for (const [id, f] of Object.entries(this.s.items)) {
      if (!id.startsWith(MEMBER) || !f.on || !f.on[0]) continue;
      const d = id.slice(MEMBER.length);
      out.push({ dev: d, me: d === me, name: f.name ? f.name[0] : "", since: f.on[1] });
    }
    return out.sort((a, b) => b.me - a.me || a.since - b.since);
  }
  // What the lists page shows of this list: its name and colour, how much is left to get,
  // and the first three of those, in the order the list shows them.
  summarize() {
    const e = entryOf(this.lid);
    if (!e || this.gone) return;
    const at = i => { const f = this.s.items["#" + i.section]; return f && f.pos ? f.pos[0] : DEFAULT_POS[i.section] ?? 100; }; // as model.js orders sections
    const toGet = this.items().filter(i => !i.checked);
    toGet.sort((a, b) => at(a) - at(b) || (a.section < b.section ? -1 : a.section > b.section ? 1 : 0) || a.pos - b.pos || (a.id < b.id ? -1 : 1));
    const others = this.members().filter(m => !m.me);
    const next = {
      name: this.valueOf("@list", "name") || null, color: this.valueOf("@list", "color") || "",
      toGet: toGet.length, first: toGet.slice(0, 3).map(i => i.text),
      with: { names: others.filter(m => m.name).map(m => m.name), nameless: others.filter(m => !m.name).length },
      closed: !!this.s.closed, newer: this.newerFormat(),
    };
    if (Object.keys(next).every(k => same(next[k], e[k]))) return;
    Object.assign(e, next);
    saveIndex();
    emit("lists");
  }
  // The whole list as changes, for a copy of it: every section and the list's own name
  // and colour, every item not deleted, and this phone; not the other phones, which are
  // on the copy once they open it.
  snapshot() {
    const ops = [];
    for (const [id, f] of Object.entries(this.s.items)) {
      if (id.startsWith(MEMBER) && id !== MEMBER + index.dev) continue;
      if (isItem(id) && f.deleted && f.deleted[0]) continue;
      for (const [field, v] of Object.entries(f)) ops.push([id, field, v[0]]);
    }
    return ops;
  }

  /* Local changes and undo */

  // change applies [[id, field, value, fallback?], ...] as one step, unless the list is
  // closed. fallback is the value
  // to assume when the field was never stored, such as a default section's name, so undo
  // can restore it. With a label, the step can be undone. Returns what changed as
  // [id, field, newValue, previousValue] records.
  change(label, ops) {
    if (this.s.closed) return null; // a closed list takes nothing more
    const t = this.tick();
    const recs = [];
    for (const [id, field, value, fallback] of ops) {
      const stored = this.valueOf(id, field);
      const prev = stored === undefined ? fallback : stored;
      if (prev !== undefined && same(prev, value)) continue;
      this.put(id, field, value, t, index.dev);
      recs.push([id, field, value, prev]);
    }
    if (!recs.length) return null;
    let chunk = [], size = 0;
    const out = () => { if (chunk.length) this.s.outbox.push({ d: index.dev, o: chunk }); chunk = []; size = 0; };
    for (const [id, field, value] of recs) {
      const op = [id, field, value, t], n = text.encode(JSON.stringify(op)).length + 1;
      if (size + n > CHUNK) out();
      chunk.push(op);
      size += n;
    }
    out();
    if (label) {
      this.undoStack.push({ label, recs });
      if (this.undoStack.length > MAX_UNDO) this.undoStack.shift();
      this.redoStack.length = 0;
    }
    this.save();
    if (this === cur) emit("local");
    this.summarize();
    this.flushSoon();
    return recs;
  }
  // Reverse a step, but only the fields still holding what that step set: if someone
  // else has changed a field since, their change stands. by is the phone that did.
  reverse(recs) {
    const ops = [];
    let by = null, at = -1;
    for (const [id, field, next, prev] of recs) {
      if (!same(this.valueOf(id, field), next)) {
        const v = this.s.items[id][field];
        if (v[1] > at) { at = v[1]; by = this.s.devs[v[2]]; }
        continue;
      }
      const target = prev === undefined ? (field === "deleted" ? true : undefined) : prev;
      if (target !== undefined) ops.push([id, field, target]);
    }
    return { recs: this.change(null, ops), by };
  }
  // Returns { label, done, by }; done is false when others had already changed
  // everything this step touched, the last of them by.
  step(from, to) {
    const entry = from.pop();
    if (!entry) return null;
    const { recs, by } = this.reverse(entry.recs);
    if (recs) to.push({ label: entry.label, recs });
    return { label: entry.label, done: !!recs, by };
  }

  /* Keys and encryption */

  ready() {
    return (this.deriving ||= derive(fromB64u(this.s.key)).then(d => (this.session = d)));
  }
  async seal(obj) {
    const plain = text.encode(JSON.stringify(obj));
    const padded = new Uint8Array(Math.ceil((plain.length + 1) / PAD) * PAD).fill(0x20);
    padded.set(plain);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const params = { name: "AES-GCM", iv, additionalData: text.encode(this.session.id) };
    const ct = new Uint8Array(await crypto.subtle.encrypt(params, this.session.key, padded));
    const out = new Uint8Array(iv.length + ct.length);
    out.set(iv);
    out.set(ct, iv.length);
    return b64(out);
  }
  async open(data) {
    const bytes = fromB64(data);
    const params = { name: "AES-GCM", iv: bytes.subarray(0, 12), additionalData: text.encode(this.session.id) };
    return JSON.parse(new TextDecoder().decode(await crypto.subtle.decrypt(params, this.session.key, bytes.subarray(12))));
  }

  /* Sync */

  status() {
    return { online: this.state === "online", full: this.state === "full", closed: this.state === "closed", waiting: this.s.outbox.length };
  }
  setState(next) {
    if (this.state === next || this.state === "closed") return;
    this.state = next;
    if (this === cur) emit("status");
  }
  async api(path, opts = {}) {
    const res = await fetch("/api/lists/" + this.session.id + path, {
      ...opts,
      headers: { ...opts.headers, Authorization: "Bearer " + this.session.auth },
    });
    if (res.status === 410) { this.closed(); throw new Error("closed"); }
    if (!res.ok) throw new Error(res.status === 507 ? "full" : "HTTP " + res.status);
    return res;
  }
  // Someone closed this list on the server: it keeps what this phone has, sends nothing
  // more, and says so.
  closed() {
    if (this.s.closed || this.gone) return;
    this.s.closed = true;
    this.state = "closed";
    this.saveNow();
    this.stopLive();
    this.summarize();
    if (this === cur) emit("status");
  }
  flushSoon() {
    clearTimeout(this.flushTimer);
    this.flushTimer = setTimeout(() => this.flush(), 150);
  }
  // A download or a send still under way when this list is swapped for another state
  // (another tab's copy, a new key) is dropped, so nothing ends up in the wrong one.
  still(st, session) {
    return this.s === st && this.session === session;
  }
  async flush() {
    if (this.gone || this.s.closed || this.newerFormat() || this.flushing || !this.s.outbox.length) return;
    if (!this.session) { this.ready().then(() => this.flush(), () => {}); return; }
    this.flushing = true;
    const st = this.s, session = this.session;
    try {
      const changes = [];
      let bytes = 0;
      for (const c of st.outbox.slice(0, 100)) {
        const sealed = await this.seal(c);
        if (changes.length && bytes + sealed.length > BATCH) break;
        changes.push(sealed);
        bytes += sealed.length + 3;
      }
      const res = await this.api("/changes", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ changes }) });
      const { latest } = await res.json();
      if (!this.still(st, session)) return;
      st.outbox.splice(0, changes.length);
      // Nothing else arrived in between: the server holds just what this phone already has.
      if (latest === st.seq + changes.length) st.seq = latest;
      this.save();
      this.setState("online");
      if (this === cur) emit("status");
    } catch (err) {
      this.setState(err.message === "full" ? "full" : "offline");
    } finally {
      this.flushing = false;
    }
    if (this.heard > this.s.seq) this.pull(); // news that came in while sending, unless it was this phone's own
    this.heard = 0;
    if (this.s.outbox.length && this.state === "online") this.flushSoon();
  }
  // Downloads what's new. Not on a phone's first download of a list, when everything is
  // new, does it point anything out; s.pulled records that it has had one.
  pull() {
    if (this.gone || this.s.closed) return Promise.resolve();
    if (!this.session) return this.ready().then(() => this.pull(), () => {});
    if (this.pulling) { this.pullAgain = true; return this.pulling; }
    const NOTED = ["text", "section", "checked"];
    this.pulling = (async () => {
      let changed = false;
      const st = this.s, session = this.session;
      const known = st.seq > 0 || !!st.pulled, from = st.seq;
      do {
        this.pullAgain = false;
        for (;;) {
          const { changes, latest } = await (await this.api("/changes?since=" + st.seq)).json();
          if (!this.still(st, session)) return;
          for (const c of changes) {
            let ch = null;
            try { ch = await this.open(c.data); } catch (_) { /* unreadable change: written with another key, skip it */ }
            if (!this.still(st, session)) return;
            if (ch) for (const [id, field, value, t] of ch.o) {
              st.clock = Math.max(st.clock, t);
              if (this.put(id, field, value, t, ch.d)) {
                changed = true;
                if (known && NOTED.includes(field) && isItem(id)) this.fresh.add(id);
              }
            }
            st.seq = c.seq;
          }
          if (!changes.length || st.seq >= latest) break;
        }
      } while (this.pullAgain);
      // Written only when something came in: opening the app usually brings nothing new.
      if (changed || st.seq !== from || !st.pulled) { st.pulled = 1; this.save(); }
      this.setState("online");
      if (changed) {
        this.summarize();
        if (this === cur) emit("remote");
      }
    })().catch(() => this.setState(this.state === "full" ? "full" : "offline")).finally(() => { this.pulling = null; });
    return this.pulling;
  }
  // Catches up once and sends what's waiting, without listening: a list not on screen.
  async refresh() {
    try { await this.ready(); } catch (_) { return; }
    await this.pull();
    await this.flush();
  }

  // connect opens the live-update WebSocket and resolves when it closes. The access
  // token travels as a subprotocol, since browsers can't set headers on WebSockets.
  connect(session, onOpen) {
    return new Promise(resolve => {
      let ws, pinger = 0;
      try {
        const url = (location.protocol === "https:" ? "wss://" : "ws://") + location.host + "/api/lists/" + session.id + "/live";
        ws = new WebSocket(url, ["panier", session.auth]);
      } catch (_) {
        return resolve();
      }
      this.socket = ws;
      ws.onopen = () => {
        onOpen();
        pinger = setInterval(() => { try { ws.send("ping"); } catch (_) {} }, 30000);
      };
      ws.onmessage = e => {
        if (e.data === "closed") { this.pull(); return; } // the server says why with the next download
        if (!/^\d+$/.test(e.data) || +e.data <= this.s.seq) return;
        if (this.flushing) this.heard = Math.max(this.heard, +e.data); // probably this phone's own changes: wait and see
        else this.pull();
      };
      ws.onclose = () => {
        clearInterval(pinger);
        if (this.socket === ws) this.socket = null;
        resolve();
      };
    });
  }
  // listen keeps a live connection open and pulls whenever the server reports news, but
  // only while the list is on screen: out of sight, nothing runs, and coming back
  // reconnects and catches up (see resume).
  async listen() {
    if (this.listening) return; // stopped and started again before it noticed: it carries on
    this.listening = true;
    try { await this.listenLoop(); } finally { this.listening = false; }
  }
  async listenLoop() {
    let delay = 1000;
    while (this.live && !this.s.closed) {
      const session = this.session;
      while (document.hidden && this.live) await new Promise(r => { this.wake = r; });
      if (!this.live || this.session !== session) return;
      await this.connect(session, () => {
        delay = 1000;
        this.setState("online");
        this.flush();
      });
      if (!this.live || this.session !== session) return;
      if (this.reconnectNow) { this.reconnectNow = false; continue; } // closed on purpose: put away, or back
      if (this.state !== "full") this.setState("offline");
      await new Promise(r => { this.wake = r; setTimeout(r, delay); });
      delay = Math.min(delay * 2, 30000);
    }
  }
  async startLive() {
    if (this.live || !this.s.key || this.s.closed) return;
    this.live = true;
    try { await this.ready(); } catch (_) { this.live = false; return; }
    await this.pull(); // first, as it's what finds a list closed, which has nothing to listen to
    if (this.live) this.listen();
  }
  stopLive() {
    this.live = false;
    if (this.wake) this.wake();
    if (this.socket) this.socket.close();
  }
  // Back on screen, or back online: reconnect and catch up. A connection still open is
  // replaced too, as phones sometimes drop one without noticing.
  resume() {
    if (!this.live) return;
    if (this.socket && this.socket.readyState === WebSocket.OPEN) { this.reconnectNow = true; this.socket.close(); }
    if (this.wake) this.wake();
    this.pull();
    this.flush();
  }
  // A phone writes itself onto a list the first time it has it, with its name if it has one.
  hello() {
    const me = MEMBER + index.dev;
    if (this.valueOf(me, "on")) return;
    this.change(null, [[me, "on", true], ...(index.name ? [[me, "name", index.name]] : [])]);
  }
}

function itemOf(id, f) {
  if (!f.text || (f.deleted && f.deleted[0])) return null;
  return {
    id,
    text: f.text[0],
    section: f.section ? f.section[0] : "ess",
    pos: f.pos ? f.pos[0] : 0,
    checked: !!(f.checked && f.checked[0]),
    checkedAt: f.checkedAt ? f.checkedAt[0] : 0,
  };
}

// Each list is read from storage the first time it's needed, then kept for the session,
// with its undo history.
const loaded = new Map();
const get = lid => {
  let l = loaded.get(lid);
  if (!l) loaded.set(lid, (l = new List(lid)));
  return l;
};
let cur = null; // the list on screen, or last on screen

/* ---------- The list on screen ---------- */

// With no list on screen (one just taken off this phone), these answer as for an empty one.
export const current = () => (cur ? cur.lid : null);
export const items = () => (cur ? cur.items() : []);
export const sections = () => (cur ? cur.sections() : []);
export const listName = () => cur && cur.valueOf("@list", "name");
export const listColor = () => cur && cur.valueOf("@list", "color");
export const change = (label, ops) => (cur ? cur.change(label, ops) : null);
export const undo = () => cur && cur.step(cur.undoStack, cur.redoStack);
export const redo = () => cur && cur.step(cur.redoStack, cur.undoStack);
const last = s => (s && s.length ? s[s.length - 1].label : null);
export const undoLabel = () => last(cur && cur.undoStack);
export const redoLabel = () => last(cur && cur.redoStack);
export const status = () => (cur ? cur.status() : { online: true, full: false, closed: false, waiting: 0 });
export const newerFormat = () => !!cur && cur.newerFormat();
export const members = () => (cur ? cur.members() : []);
export const memberName = d => { const m = members().find(m => m.dev === d); return m ? m.name : ""; };
// Any list on this phone, as export reads it.
export function peek(lid) {
  const l = get(lid);
  return { name: l.valueOf("@list", "name"), color: l.valueOf("@list", "color"), sections: l.sections(), items: l.items() };
}
export const storedSize = lid => { try { return new Blob([localStorage.getItem(ENTRY + lid) || ""]).size; } catch (_) { return 0; } };
export function takeFresh() {
  const ids = cur.fresh;
  cur.fresh = new Set();
  return ids;
}

// open puts a list on screen, listening live; leave takes it off, as the lists page shows.
export function open(lid) {
  if (!entryOf(lid)) return false;
  if (cur && cur.lid !== lid) cur.stopLive();
  cur = get(lid);
  if (index.open !== lid) { index.open = lid; saveIndexNow(); }
  cur.hello();
  cur.summarize();
  cur.startLive();
  return true;
}
export function leave() {
  if (cur) cur.stopLive();
}

/* ---------- The lists on this phone ---------- */

// Every list catches up, and sends what it has waiting: as the lists page shows.
export function refreshAll() {
  for (const e of index.lists) if (!e.closed && !(cur && cur.lid === e.lid && cur.live)) get(e.lid).refresh();
}

// A link that opens one list, or several: their keys after "#k=", joined by dots.
// Browsers never send what follows "#" to servers.
const linkFor = keys => location.origin + "/#k=" + keys.join(".");
export const pairingLink = () => linkFor([cur.s.key]);
export const allLink = () => linkFor(index.lists.filter(e => !e.closed).map(e => e.key));
export const keysIn = s => (s || "").split(".").filter(k => KEY.test(k));

function add(key, fresh) {
  const lid = newId();
  index.lists.push({ lid, key, name: null, color: "", toGet: 0, first: [] });
  const l = new List(lid, fresh || blank(key));
  loaded.set(lid, l);
  l.saveNow();
  saveIndexNow();
  return l;
}
// addKeys adds the lists a link holds and returns their ids on this phone, including
// those it already had.
export function addKeys(keys) {
  const out = [];
  for (const key of keys) {
    const had = index.lists.find(e => e.key === key);
    if (had) { out.push(had.lid); continue; }
    const l = add(key);
    l.hello();
    l.refresh();
    out.push(l.lid);
  }
  emit("lists");
  return out;
}

// createList makes a new list on the server: vouched for by a list this phone already
// has there, or with the server's setup code when it has none, or none will. Throws
// "code" when the setup code is needed (or was wrong), "server" when unreachable.
export async function createList({ code = null, name = "" } = {}) {
  const raw = crypto.getRandomValues(new Uint8Array(32));
  const d = await derive(raw);
  const body = { id: d.id, auth: d.auth };
  const post = (headers, extra = {}) => fetch("/api/lists", {
    method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify({ ...body, ...extra }),
  });
  let res = null;
  try {
    if (code !== null) res = await post({ "X-Setup-Code": code.trim() });
    else {
      for (const e of index.lists) {
        if (e.closed) continue;
        const v = get(e.lid);
        await v.ready();
        res = await post({ Authorization: "Bearer " + v.session.auth }, { by: v.session.id });
        if (res.status !== 403) break;
      }
    }
  } catch (_) {
    throw new Error("server");
  }
  if (!res || res.status === 403) throw new Error("code");
  if (!res.ok) throw new Error("server");
  const l = add(b64u(raw));
  l.session = d;
  l.deriving = Promise.resolve(d);
  l.hello();
  if (name) l.change(null, [["@list", "name", name]]);
  l.summarize();
  emit("lists");
  return l.lid;
}

// A new list holding ops, for an import: one step, as if typed. Returns its id.
export async function createFrom(ops, opts) {
  const lid = await createList(opts);
  get(lid).change(null, ops);
  return lid;
}

// remove takes a list off this phone; it stays on the server for the others. Returns
// what restore needs to put it back as it was, for undo.
export function remove(lid) {
  const at = index.lists.findIndex(e => e.lid === lid);
  if (at < 0) return null;
  const l = get(lid);
  l.saveNow();
  l.stopLive();
  l.gone = true;
  let raw = null;
  try { raw = localStorage.getItem(ENTRY + lid); localStorage.removeItem(ENTRY + lid); } catch (_) {}
  const [entry] = index.lists.splice(at, 1);
  if (index.open === lid) index.open = null;
  if (cur === l) cur = null;
  loaded.delete(lid);
  saveIndexNow();
  emit("lists");
  return { entry, at, raw };
}
export function restore(r) {
  if (!r || entryOf(r.entry.lid)) return;
  index.lists.splice(Math.min(r.at, index.lists.length), 0, r.entry);
  try { if (r.raw) localStorage.setItem(ENTRY + r.entry.lid, r.raw); } catch (_) {}
  saveIndexNow();
  get(r.entry.lid).refresh();
  emit("lists");
}
export function reorder(lids) {
  const by = new Map(index.lists.map(e => [e.lid, e]));
  const next = lids.map(l => by.get(l)).filter(Boolean);
  if (next.length !== index.lists.length) return;
  index.lists = next;
  saveIndexNow();
  emit("lists");
}
export function setFolded(lid, folded) {
  const e = entryOf(lid);
  if (e && !!e.folded !== folded) { e.folded = folded; saveIndex(); }
}

// This phone's name, shown to the people its lists are shared with, on every list it has.
export const myName = () => index.name || "";
export function setMyName(name) {
  if (name === myName()) return;
  index.name = name;
  saveIndexNow();
  for (const e of index.lists) if (!e.closed) get(e.lid).change(null, [[MEMBER + index.dev, "on", true], [MEMBER + index.dev, "name", name]]);
}

// changeKey gives the list on screen a new key, for when someone should no longer have
// it: a copy is made under a new key, the old list is closed on the server, and this
// phone carries on with the copy. The others need the new link.
export async function changeKey() {
  const old = cur;
  await old.ready();
  await old.flush();
  const raw = crypto.getRandomValues(new Uint8Array(32));
  const d = await derive(raw);
  let res;
  try {
    res = await fetch("/api/lists", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + old.session.auth },
      body: JSON.stringify({ id: d.id, auth: d.auth, by: old.session.id }),
    });
  } catch (_) { throw new Error("server"); }
  if (!res.ok) throw new Error(res.status === 403 ? "full" : "server");
  const copy = new List(old.lid, blank(b64u(raw)));
  copy.unsaved = true; // written only once the old list is closed: until then, it is the one kept
  copy.session = d;
  copy.deriving = Promise.resolve(d);
  copy.change(null, old.snapshot());
  await copy.flush();
  if (copy.s.outbox.length) throw new Error("server"); // not all sent: the old list stays as it was
  old.stopLive();
  try {
    await closeOnServer(old);
  } catch (err) {
    old.startLive();
    throw err;
  }
  old.gone = true;
  loaded.set(old.lid, copy);
  entryOf(old.lid).key = copy.s.key;
  copy.unsaved = false;
  copy.saveNow();
  saveIndexNow();
  cur = copy;
  copy.summarize();
  copy.startLive();
  emit("remote");
}
async function closeOnServer(l) {
  await l.ready();
  try {
    await l.api("", { method: "DELETE" });
  } catch (err) {
    if (err.message !== "closed") throw new Error("server");
  }
}
// deleteForEveryone closes the list on the server, for everyone who has it, and takes
// it off this phone. It can't be undone.
export async function deleteForEveryone(lid) {
  await closeOnServer(get(lid));
  remove(lid);
}

/* ---------- Coming and going ---------- */

// Put away, the app stops listening, so it uses no network or battery in the background.
document.addEventListener("visibilitychange", () => {
  for (const l of loaded.values()) if (document.hidden && l.saveTimer) l.saveNow();
  if (document.hidden && indexTimer) saveIndexNow();
  if (!cur) return;
  if (!document.hidden) cur.resume();
  else if (cur.socket) { cur.reconnectNow = true; cur.socket.close(); }
});
addEventListener("pagehide", () => {
  for (const l of loaded.values()) if (l.saveTimer) l.saveNow();
  if (indexTimer) saveIndexNow();
});
addEventListener("online", () => {
  if (cur) cur.resume();
  for (const l of loaded.values()) if (l !== cur || !l.live) l.flush();
});
// Another tab saved: take its copy, rather than later writing this one over it.
addEventListener("storage", e => {
  if (e.key === INDEX) {
    clearTimeout(indexTimer);
    indexTimer = 0;
    index = loadIndex();
    emit("lists");
    return;
  }
  if (!e.key || !e.key.startsWith(ENTRY)) return;
  const l = loaded.get(e.key.slice(ENTRY.length));
  if (!l) return;
  clearTimeout(l.saveTimer);
  l.saveTimer = 0;
  if (e.newValue === null) { // taken off this phone there: gone here too, never written back
    l.stopLive();
    l.gone = true;
    loaded.delete(l.lid);
    if (l === cur) cur = null;
    emit("lists");
    return;
  }
  l.s = l.load();
  l.reset();
  if (l === cur) emit("remote");
});
