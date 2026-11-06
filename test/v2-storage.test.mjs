// Browser-real IndexedDB tests: no application backend or v1 state.
// Runs in Chromium/Firefox with a local loopback static HTTP server that serves
// the v2 modules. This avoids synthetic DNS, external network and TLS problems.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const browserType = require("playwright")[process.env.BROWSER || "chromium"];
const STORAGE_SOURCE = readFileSync(fileURLToPath(new URL("../v2/storage.mjs", import.meta.url)), "utf8");
const DOMAIN_SOURCE = readFileSync(fileURLToPath(new URL("../v2/domain.mjs", import.meta.url)), "utf8");
const SYNC_SOURCE = readFileSync(fileURLToPath(new URL("../v2/sync.mjs", import.meta.url)), "utf8");
let browser, server, origin;

before(async () => {
  server = createServer((req, res) => {
    const path = new URL(req.url, "http://127.0.0.1").pathname;
    if (path === "/") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end("<title>V2 storage test</title>");
    } else if (path === "/v2/storage.mjs" || path === "/v2/domain.mjs" || path === "/v2/sync.mjs") {
      res.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8" });
      res.end(path === "/v2/storage.mjs" ? STORAGE_SOURCE :
        path === "/v2/domain.mjs" ? DOMAIN_SOURCE : SYNC_SOURCE);
    } else {
      res.writeHead(404); res.end("Not found");
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  origin = "http://127.0.0.1:" + server.address().port;
  browser = await browserType.launch();
});
after(async () => {
  if (browser) await browser.close();
  if (server?.listening) await new Promise(resolve => server.close(resolve));
});

async function pageWithModules(context) {
  const page = await context.newPage();
  await page.goto(origin + "/", { timeout: 15000 });
  return page;
}

// Fail individual tests promptly rather than leaving CI hung on an unresolved
// IndexedDB request or a browser permission prompt. Closing the test context
// cancels any underlying browser evaluation after this timeout.
function evaluate(page, fn, arg) {
  let timer;
  return Promise.race([
    page.evaluate(fn, arg),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("Browser evaluation timed out after 15s")), 15000);
    }),
  ]).finally(() => clearTimeout(timer));
}

const dbName = () => "panier-v2-test-" + crypto.randomUUID();
const LIST = "household01";
const ITEM = "itemAA001";
const draft = (id, name) => ({ listId: LIST, id, type: "item.add", payload: { id: ITEM, name, position: "a" } });
const accepted = (id, revision, name, itemId = ITEM) => ({
  listId: LIST, id, revision, type: "item.add", payload: { id: itemId, name, position: "a" },
});

test("offline mutation survives database reopen with matching optimistic state and pending outbox", async () => {
  const context = await browser.newContext();
  try {
    const page = await pageWithModules(context);
    const result = await evaluate(page, async ({ name, mutation }) => {
      const real = await import("/v2/storage.mjs");
      // This suite exercises storage, NOT encryption. Supply an inert
      // preprepared envelope through the new sealed-only commit API.
      const s = { ...real, commitLocalMutation: (db, draft) =>
        real.commitSealedLocalMutation(db, draft, {
          listId: draft.listId, id: draft.id, ciphertext: "test-opaque:" + draft.id,
        }) };
      let db = await s.openPanierDatabase({ name });
      await s.createLocalList(db, mutation.listId);
      const saved = await s.commitLocalMutation(db, mutation);
      db.close();
      db = await s.openPanierDatabase({ name });
      const restored = await s.readLocalList(db, mutation.listId);
      db.close();
      return { saved: { count: saved.pendingCount, milk: saved.local.items[mutation.payload.id].name },
        restored: { count: restored.pending.length, milk: restored.local.items[mutation.payload.id].name,
          cursor: restored.accepted.revision, id: restored.pending[0].id } };
    }, { name: dbName(), mutation: draft("mutation01", "Milk") });
    assert.deepEqual(result.saved, { count: 1, milk: "Milk" });
    assert.deepEqual(result.restored, { count: 1, milk: "Milk", cursor: 0, id: "mutation01" });
  } finally { await context.close(); }
});

test("accepted revisions and outbox acknowledgments commit together; remote edits rebase pending", async () => {
  const context = await browser.newContext();
  try {
    const page = await pageWithModules(context);
    const result = await evaluate(page, async ({ name, local, remote, ack }) => {
      const real = await import("/v2/storage.mjs");
      // This suite exercises storage, NOT encryption. Supply an inert
      // preprepared envelope through the new sealed-only commit API.
      const s = { ...real, commitLocalMutation: (db, draft) =>
        real.commitSealedLocalMutation(db, draft, {
          listId: draft.listId, id: draft.id, ciphertext: "test-opaque:" + draft.id,
        }) };
      const db = await s.openPanierDatabase({ name });
      await s.createLocalList(db, local.listId);
      await s.commitLocalMutation(db, local);
      const afterRemote = await s.acceptRemoteOperations(db, local.listId, [remote]);
      const afterAck = await s.acceptRemoteOperations(db, local.listId, [ack]);
      db.close();
      return {
        remote: { rev: afterRemote.accepted.revision, pending: afterRemote.pendingCount,
          names: Object.values(afterRemote.local.items).map(i => i.name).sort() },
        ack: { rev: afterAck.accepted.revision, pending: afterAck.pendingCount,
          names: Object.values(afterAck.local.items).map(i => i.name).sort() },
      };
    }, { name: dbName(), local: draft("mutation01", "Milk"),
      remote: accepted("mutation02", 1, "Eggs", "itemBB002"),
      ack: accepted("mutation01", 2, "Milk") });
    assert.deepEqual(result.remote, { rev: 1, pending: 1, names: ["Eggs", "Milk"] });
    assert.deepEqual(result.ack, { rev: 2, pending: 0, names: ["Eggs", "Milk"] });
  } finally { await context.close(); }
});

test("concurrent writes from two tabs do not overwrite one another", async () => {
  const context = await browser.newContext();
  try {
    const a = await pageWithModules(context), b = await pageWithModules(context);
    const name = dbName();
    await evaluate(a, async name => {
      const real = await import("/v2/storage.mjs");
      // This suite exercises storage, NOT encryption. Supply an inert
      // preprepared envelope through the new sealed-only commit API.
      const s = { ...real, commitLocalMutation: (db, draft) =>
        real.commitSealedLocalMutation(db, draft, {
          listId: draft.listId, id: draft.id, ciphertext: "test-opaque:" + draft.id,
        }) };
      const db = await s.openPanierDatabase({ name });
      await s.createLocalList(db, "household01"); db.close();
    }, name);
    const write = (page, id, itemId) => evaluate(page, async ({ name, id, itemId }) => {
      const real = await import("/v2/storage.mjs");
      // This suite exercises storage, NOT encryption. Supply an inert
      // preprepared envelope through the new sealed-only commit API.
      const s = { ...real, commitLocalMutation: (db, draft) =>
        real.commitSealedLocalMutation(db, draft, {
          listId: draft.listId, id: draft.id, ciphertext: "test-opaque:" + draft.id,
        }) };
      const db = await s.openPanierDatabase({ name });
      await s.commitLocalMutation(db, { listId: "household01", id, type: "item.add",
        payload: { id: itemId, name: id, position: "a" } });
      db.close();
    }, { name, id, itemId });
    await Promise.all([write(a, "mutation01", "itemAA001"), write(b, "mutation02", "itemBB002")]);
    const value = await evaluate(a, async name => {
      const real = await import("/v2/storage.mjs");
      // This suite exercises storage, NOT encryption. Supply an inert
      // preprepared envelope through the new sealed-only commit API.
      const s = { ...real, commitLocalMutation: (db, draft) =>
        real.commitSealedLocalMutation(db, draft, {
          listId: draft.listId, id: draft.id, ciphertext: "test-opaque:" + draft.id,
        }) };
      const db = await s.openPanierDatabase({ name });
      const result = await s.readLocalList(db, "household01"); db.close();
      return { count: result.pending.length, seq: result.nextLocalSeq,
        ids: Object.keys(result.local.items).sort() };
    }, name);
    assert.deepEqual(value, { count: 2, seq: 2, ids: ["itemAA001", "itemBB002"] });
  } finally { await context.close(); }
});

test("duplicate IDs and invalid mutations fail without partial writes", async () => {
  const context = await browser.newContext();
  try {
    const page = await pageWithModules(context);
    const value = await evaluate(page, async name => {
      const real = await import("/v2/storage.mjs");
      // This suite exercises storage, NOT encryption. Supply an inert
      // preprepared envelope through the new sealed-only commit API.
      const s = { ...real, commitLocalMutation: (db, draft) =>
        real.commitSealedLocalMutation(db, draft, {
          listId: draft.listId, id: draft.id, ciphertext: "test-opaque:" + draft.id,
        }) };
      const db = await s.openPanierDatabase({ name });
      await s.createLocalList(db, "household01");
      const valid = { listId: "household01", id: "mutation01", type: "item.add",
        payload: { id: "itemAA001", name: "Bread", position: "a" } };
      await s.commitLocalMutation(db, valid);
      let duplicate = false, invalid = false, gap = false;
      try { await s.commitLocalMutation(db, valid); } catch (_) { duplicate = true; }
      try { await s.commitLocalMutation(db, { ...valid, id: "mutation02",
        payload: { ...valid.payload, name: "" } }); } catch (_) { invalid = true; }
      try { await s.acceptRemoteOperations(db, "household01", [{ ...valid, revision: 4 }]); }
      catch (_) { gap = true; }
      const record = await s.readLocalList(db, "household01");
      db.close();
      return { duplicate, invalid, gap, count: record.pending.length,
        revision: record.accepted.revision, item: record.local.items.itemAA001.name };
    }, dbName());
    assert.deepEqual(value, { duplicate: true, invalid: true, gap: true,
      count: 1, revision: 0, item: "Bread" });
  } finally { await context.close(); }
});

test("closed or unavailable database rejects a save; caller must not show saved", async () => {
  const context = await browser.newContext();
  try {
    const page = await pageWithModules(context);
    const result = await evaluate(page, async name => {
      const real = await import("/v2/storage.mjs");
      // This suite exercises storage, NOT encryption. Supply an inert
      // preprepared envelope through the new sealed-only commit API.
      const s = { ...real, commitLocalMutation: (db, draft) =>
        real.commitSealedLocalMutation(db, draft, {
          listId: draft.listId, id: draft.id, ciphertext: "test-opaque:" + draft.id,
        }) };
      const db = await s.openPanierDatabase({ name });
      await s.createLocalList(db, "household01");
      db.close();
      let closedCode, quotaCode;
      try { await s.commitLocalMutation(db, { listId: "household01", id: "mutation01",
        type: "item.add", payload: { id: "itemAA001", name: "Milk", position: "a" } }); }
      catch (error) { closedCode = error.code; }
      const failedDb = { transaction() { throw new DOMException("Quota exhausted", "QuotaExceededError"); } };
      try { await s.commitLocalMutation(failedDb, { listId: "household01", id: "mutation01",
        type: "item.add", payload: { id: "itemAA001", name: "Milk", position: "a" } }); }
      catch (error) { quotaCode = error.code; }
      return { closedCode, quotaCode };
    }, dbName());
    assert.deepEqual(result, { closedCode: "unavailable", quotaCode: "quota" });
  } finally { await context.close(); }
});

test("list isolation and versionchange notification; existing data preserved", async () => {
  const context = await browser.newContext();
  try {
    const page = await pageWithModules(context);
    const result = await evaluate(page, async name => {
      const real = await import("/v2/storage.mjs");
      // This suite exercises storage, NOT encryption. Supply an inert
      // preprepared envelope through the new sealed-only commit API.
      const s = { ...real, commitLocalMutation: (db, draft) =>
        real.commitSealedLocalMutation(db, draft, {
          listId: draft.listId, id: draft.id, ciphertext: "test-opaque:" + draft.id,
        }) };
      let changed = 0;
      const db = await s.openPanierDatabase({ name, onVersionChange: () => changed++ });
      await s.createLocalList(db, "household01");
      await s.createLocalList(db, "household02");
      await s.commitLocalMutation(db, { listId: "household01", id: "mutation01",
        type: "item.add", payload: { id: "itemAA001", name: "Milk", position: "a" } });
      const other = await s.readLocalList(db, "household02");
      const opened = indexedDB.open(name, 3); // v2 storage schema now opens at version 2
      const upgrade = new Promise((resolve, reject) => {
        opened.onupgradeneeded = () => {};
        opened.onsuccess = () => { opened.result.close(); resolve(true); };
        opened.onerror = () => reject(opened.error);
      });
      const didUpgrade = await upgrade;
      return { otherCount: other.pending.length, otherRev: other.accepted.revision, changed, didUpgrade };
    }, dbName());
    assert.deepEqual(result, { otherCount: 0, otherRev: 0, changed: 1, didUpgrade: true });
  } finally { await context.close(); }
});

test("persistent storage reports capability without claiming durability", async () => {
  const context = await browser.newContext();
  try {
    const page = await pageWithModules(context);
    const result = await evaluate(page, async () => {
      const { requestPersistentStorage } = await import("/v2/storage.mjs");
      // Never invoke the browser's real persist() permission prompt in CI:
      // Firefox can wait indefinitely for the user to respond.
      Object.defineProperty(navigator, "storage", {
        configurable: true, value: { persist: async () => false },
      });
      const denied = await requestPersistentStorage();
      Object.defineProperty(navigator, "storage", {
        configurable: true, value: { persist: async () => true },
      });
      const granted = await requestPersistentStorage();
      Object.defineProperty(navigator, "storage", {
        configurable: true, value: {},
      });
      const unsupported = await requestPersistentStorage();
      return { denied, granted, unsupported };
    });
    assert.deepEqual(result, {
      denied: { supported: true, granted: false },
      granted: { supported: true, granted: true },
      unsupported: { supported: false, granted: false },
    });
  } finally { await context.close(); }
});

test("sealed envelope survives restart byte-for-byte with local mutation and can be loaded", async () => {
  const context = await browser.newContext();
  try {
    const page = await pageWithModules(context);
    const result = await evaluate(page, async name => {
      const storage = await import("/v2/storage.mjs");
      const m = { listId: "household01", id: "mutation01", type: "item.add",
        payload: { id: "itemAA001", name: "Milk", position: "a" } };
      const encrypted = { listId: m.listId, id: m.id,
        ciphertext: "v2-opaque-signed-payload.AQID___same-bytes-on-retry" };
      let db = await storage.openPanierDatabase({ name });
      await storage.createLocalList(db, m.listId);
      await storage.commitSealedLocalMutation(db, m, encrypted);
      db.close();
      db = await storage.openPanierDatabase({ name });
      const persisted = await storage.loadSealedMutation(db, m.listId, m.id);
      const snapshot = await storage.readLocalList(db, m.listId);
      db.close();
      return { persisted, optimistic: snapshot.local.items.itemAA001.name,
        pending: snapshot.pending.length, cursor: snapshot.accepted.revision };
    }, dbName());
    assert.deepEqual(result, {
      persisted: { listId: LIST, id: "mutation01",
        ciphertext: "v2-opaque-signed-payload.AQID___same-bytes-on-retry" },
      optimistic: "Milk", pending: 1, cursor: 0,
    });
  } finally { await context.close(); }
});

test("mismatched, plaintext-shaped or missing sealed envelopes fail without saving the edit", async () => {
  const context = await browser.newContext();
  try {
    const page = await pageWithModules(context);
    const result = await evaluate(page, async name => {
      const storage = await import("/v2/storage.mjs");
      const db = await storage.openPanierDatabase({ name });
      await storage.createLocalList(db, "household01");
      const draft = { listId: "household01", id: "mutation01", type: "item.add",
        payload: { id: "itemAA001", name: "Milk", position: "a" } };
      const bad = [
        null,
        { listId: "household01", id: "different01", ciphertext: "opaque" },
        { listId: "household01", id: "mutation01", ciphertext: "opaque", name: "Milk" },
        { listId: "household01", id: "mutation01", ciphertext: "" },
      ];
      let failures = 0;
      for (const envelope of bad) {
        try { await storage.commitSealedLocalMutation(db, draft, envelope); }
        catch (_) { failures++; }
      }
      const result = await storage.readLocalList(db, "household01");
      const missing = await storage.loadSealedMutation(db, "household01", "mutation01");
      db.close();
      return { failures, pending: result.pending.length, localItems: Object.keys(result.local.items).length, missing };
    }, dbName());
    assert.deepEqual(result, { failures: 4, pending: 0, localItems: 0, missing: null });
  } finally { await context.close(); }
});

test("duplicate mutation ID cannot replace sealed bytes or local state", async () => {
  const context = await browser.newContext();
  try {
    const page = await pageWithModules(context);
    const result = await evaluate(page, async name => {
      const storage = await import("/v2/storage.mjs");
      const db = await storage.openPanierDatabase({ name });
      await storage.createLocalList(db, "household01");
      const m = { listId: "household01", id: "mutation01", type: "item.add",
        payload: { id: "itemAA001", name: "Milk", position: "a" } };
      await storage.commitSealedLocalMutation(db, m,
        { listId: m.listId, id: m.id, ciphertext: "first-envelope" });
      let rejected = false;
      try { await storage.commitSealedLocalMutation(db, { ...m, payload: { ...m.payload, name: "Eggs" } },
        { listId: m.listId, id: m.id, ciphertext: "second-envelope" }); }
      catch (_) { rejected = true; }
      const saved = await storage.loadSealedMutation(db, m.listId, m.id);
      const state = await storage.readLocalList(db, m.listId);
      db.close();
      return { rejected, ciphertext: saved.ciphertext, name: state.local.items.itemAA001.name,
        pending: state.pending.length };
    }, dbName());
    assert.deepEqual(result, { rejected: true, ciphertext: "first-envelope", name: "Milk", pending: 1 });
  } finally { await context.close(); }
});

test("forged acknowledgement with the same mutation ID but different contents preserves pending edit", async () => {
  const context = await browser.newContext();
  try {
    const page = await pageWithModules(context);
    const result = await evaluate(page, async name => {
      const storage = await import("/v2/storage.mjs");
      const db = await storage.openPanierDatabase({ name });
      await storage.createLocalList(db, "household01");
      const m = { listId: "household01", id: "mutation01", type: "item.add",
        payload: { id: "itemAA001", name: "Milk", position: "a" } };
      await storage.commitSealedLocalMutation(db, m,
        { listId: m.listId, id: m.id, ciphertext: "first-envelope" });
      let rejected = false;
      try { await storage.acceptRemoteOperations(db, "household01", [{
        ...m, revision: 1, payload: { ...m.payload, name: "Eggs" },
      }]); } catch (_) { rejected = true; }
      const state = await storage.readLocalList(db, "household01");
      const saved = await storage.loadSealedMutation(db, m.listId, m.id);
      db.close();
      return { rejected, pending: state.pending.length, cursor: state.accepted.revision,
        name: state.local.items.itemAA001.name, ciphertext: saved.ciphertext };
    }, dbName());
    assert.deepEqual(result, {
      rejected: true, pending: 1, cursor: 0, name: "Milk", ciphertext: "first-envelope",
    });
  } finally { await context.close(); }
});

test("sync coordinator uploads exactly persisted bytes after reopen; only verified pull acknowledges", async () => {
  const context = await browser.newContext();
  try {
    const page = await pageWithModules(context);
    const result = await evaluate(page, async name => {
      const storage = await import("/v2/storage.mjs");
      const { syncOnce } = await import("/v2/sync.mjs");
      let db = await storage.openPanierDatabase({ name });
      await storage.createLocalList(db, "household01");
      const m = { listId: "household01", id: "mutation01", type: "item.add",
        payload: { id: "itemAA001", name: "Milk", position: "a" } };
      await storage.commitSealedLocalMutation(db, m,
        { listId: m.listId, id: m.id, ciphertext: "persisted-signed-envelope-byte-sequence" });
      db.close();
      db = await storage.openPanierDatabase({ name });
      const sent = [];
      let history = [];
      // Test doubles are intentionally not real cryptography or an HTTP API.
      const transport = {
        pull: async (_list, since) => ({
          latest: history.length, changes: history.filter(op => op.revision > since),
        }),
        push: async (_list, envelope) => {
          sent.push(envelope.ciphertext);
          if (!history.length) history = [{ ...m, revision: 1, ciphertext: envelope.ciphertext }];
        },
      };
      const security = {
        loadSealed: (listId, id) => storage.loadSealedMutation(db, listId, id),
        decodeAndVerify: async (_list, opaque) => {
          const { ciphertext, ...plaintextTestOperation } = opaque;
          return plaintextTestOperation;
        },
      };
      const outcome = await syncOnce({ db, listId: m.listId, storage, transport, security });
      const empty = await storage.loadSealedMutation(db, m.listId, m.id);
      db.close();
      return { outcome, sent, empty };
    }, dbName());
    assert.deepEqual(result, {
      outcome: { revision: 1, pending: 0, pushed: 1, pulled: 1, synced: true },
      sent: ["persisted-signed-envelope-byte-sequence"], empty: null,
    });
  } finally { await context.close(); }
});
