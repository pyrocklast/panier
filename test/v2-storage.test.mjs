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
const CRYPTO_SOURCE = readFileSync(fileURLToPath(new URL("../v2/crypto.mjs", import.meta.url)), "utf8");
const QR_SOURCE = readFileSync(fileURLToPath(new URL("../v2/qr-pairing.mjs", import.meta.url)), "utf8");
const REKEY_SOURCE = readFileSync(fileURLToPath(new URL("../v2/rekey.mjs", import.meta.url)), "utf8");
const TRUST_SOURCE = readFileSync(fileURLToPath(new URL("../v2/trust.mjs", import.meta.url)), "utf8");
const LEDGER_SOURCE = readFileSync(fileURLToPath(new URL("../v2/membership-ledger.mjs", import.meta.url)), "utf8");
const REGISTRY_SOURCE = readFileSync(fileURLToPath(new URL("../v2/qr-registry.mjs", import.meta.url)), "utf8");
let browser, server, origin;

before(async () => {
  server = createServer((req, res) => {
    const path = new URL(req.url, "http://127.0.0.1").pathname;
    if (path === "/") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end("<title>V2 storage test</title>");
    } else if (path === "/v2/storage.mjs" || path === "/v2/domain.mjs" ||
        path === "/v2/sync.mjs" || path === "/v2/crypto.mjs" ||
        path === "/v2/qr-pairing.mjs" || path === "/v2/rekey.mjs" ||
        path === "/v2/trust.mjs" || path === "/v2/membership-ledger.mjs" ||
        path === "/v2/qr-registry.mjs") {
      res.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8" });
      res.end(path === "/v2/storage.mjs" ? STORAGE_SOURCE :
        path === "/v2/domain.mjs" ? DOMAIN_SOURCE :
        path === "/v2/sync.mjs" ? SYNC_SOURCE :
        path === "/v2/crypto.mjs" ? CRYPTO_SOURCE :
        path === "/v2/qr-pairing.mjs" ? QR_SOURCE :
        path === "/v2/rekey.mjs" ? REKEY_SOURCE :
        path === "/v2/trust.mjs" ? TRUST_SOURCE :
        path === "/v2/membership-ledger.mjs" ? LEDGER_SOURCE : REGISTRY_SOURCE);
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

test("accepted mutation matches queued payload despite different object key order", async () => {
  const context = await browser.newContext();
  try {
    const page = await pageWithModules(context);
    const result = await evaluate(page, async name => {
      const storage = await import("/v2/storage.mjs");
      const db = await storage.openPanierDatabase({ name });
      await storage.createLocalList(db, "household01");
      const m = { listId: "household01", id: "mutation01", type: "item.add",
        payload: { id: "itemAA001", name: "Milk", position: "a", checked: true } };
      await storage.commitSealedLocalMutation(db, m,
        { listId: m.listId, id: m.id, ciphertext: "same-valid-signed-envelope" });
      const accepted = await storage.acceptRemoteOperations(db, m.listId, [{
        listId: m.listId, id: m.id, revision: 1, type: m.type,
        payload: { checked: true, position: "a", name: "Milk", id: "itemAA001" },
      }]);
      db.close();
      return { revision: accepted.accepted.revision, pending: accepted.pendingCount,
        name: accepted.local.items.itemAA001.name };
    }, dbName());
    assert.deepEqual(result, { revision: 1, pending: 0, name: "Milk" });
  } finally { await context.close(); }
});

test("interrupted write transaction rolls back both sealed outbox and optimistic state", async () => {
  const context = await browser.newContext();
  try {
    const page = await pageWithModules(context);
    const result = await evaluate(page, async name => {
      const storage = await import("/v2/storage.mjs");
      const db = await storage.openPanierDatabase({ name });
      await storage.createLocalList(db, "household01");
      const fault = {
        transaction(stores, mode) {
          const tx = db.transaction(stores, mode);
          return new Proxy(tx, {
            get(target, field) {
              if (field !== "objectStore") {
                const value = Reflect.get(target, field, target);
                return typeof value === "function" ? value.bind(target) : value;
              }
              return storeName => {
                const store = target.objectStore(storeName);
                if (storeName !== "lists") return store;
                return new Proxy(store, {
                  get(base, property) {
                    if (property === "put") return value => {
                      const request = base.put(value);
                      target.abort(); // simulated browser crash / transaction abort
                      return request;
                    };
                    const value = Reflect.get(base, property, base);
                    return typeof value === "function" ? value.bind(base) : value;
                  },
                });
              };
            },
          });
        },
      };
      const draft = { listId: "household01", id: "mutation01", type: "item.add",
        payload: { id: "itemAA001", name: "Milk", position: "a" } };
      let rejected = false;
      try {
        await storage.commitSealedLocalMutation(fault, draft,
          { listId: draft.listId, id: draft.id, ciphertext: "must-not-survive" });
      } catch (_) { rejected = true; }
      const remaining = await storage.readLocalList(db, draft.listId);
      const envelope = await storage.loadSealedMutation(db, draft.listId, draft.id);
      db.close();
      return { rejected, pending: remaining.pending.length,
        cursor: remaining.accepted.revision,
        itemCount: Object.keys(remaining.local.items).length, envelope };
    }, dbName());
    assert.deepEqual(result, { rejected: true, pending: 0,
      cursor: 0, itemCount: 0, envelope: null });
  } finally { await context.close(); }
});

test("experimental v2 unsealed entries survive schema upgrade but cannot be uploaded", async () => {
  const context = await browser.newContext();
  try {
    const page = await pageWithModules(context);
    const result = await evaluate(page, async name => {
      localStorage.setItem("panier", "original-v1-data-must-survive");
      // Build a historical v2 prototype database at version 1.
      const open = indexedDB.open(name, 1);
      const original = await new Promise((resolve, reject) => {
        open.onupgradeneeded = () => {
          const db = open.result;
          db.createObjectStore("lists", { keyPath: "listId" });
          db.createObjectStore("outbox", { keyPath: ["listId", "id"] })
            .createIndex("byList", "listId");
        };
        open.onsuccess = () => resolve(open.result);
        open.onerror = () => reject(open.error);
      });
      const { emptyList } = await import("/v2/domain.mjs");
      const state = emptyList("household01");
      const tx = original.transaction(["lists", "outbox"], "readwrite");
      tx.objectStore("lists").add({ listId: state.listId, accepted: state,
        local: state, nextLocalSeq: 1 });
      tx.objectStore("outbox").add({
        listId: state.listId, id: "mutation01", type: "item.add",
        payload: { id: "itemAA001", name: "Milk", position: "a" }, localSeq: 1,
      });
      await new Promise((resolve, reject) => {
        tx.oncomplete = resolve;
        tx.onabort = () => reject(tx.error);
      });
      original.close();
      const storage = await import("/v2/storage.mjs");
      const upgraded = await storage.openPanierDatabase({ name });
      const pending = await storage.readLocalList(upgraded, state.listId);
      let denied = false;
      try { await storage.loadSealedMutation(upgraded, state.listId, "mutation01"); }
      catch (_) { denied = true; }
      const schema = upgraded.version;
      upgraded.close();
      return { pending: pending.pending.length, denied, schema,
        v1: localStorage.getItem("panier") };
    }, dbName());
    assert.deepEqual(result, {
      pending: 1, denied: true, schema: 2,
      v1: "original-v1-data-must-survive",
    });
  } finally { await context.close(); }
});

test("WebCrypto signed mutation round-trips through durable IndexedDB in Chromium and Firefox", async () => {
  const context = await browser.newContext();
  try {
    const page = await pageWithModules(context);
    const result = await evaluate(page, async name => {
      const storage = await import("/v2/storage.mjs");
      const crypt = await import("/v2/crypto.mjs");
      const identity = await crypt.generateSigningIdentity();
      const listSecret = crypto.getRandomValues(new Uint8Array(32));
      const draft = { listId: "household01", id: "mutation01", type: "item.add",
        payload: { id: "itemAA001", name: "Milk", position: "a" } };
      const sealed = await crypt.sealMutation({
        draft, epoch: 1, actorId: identity.actorId,
        privateKey: identity.privateKey, listSecret,
      });
      let db = await storage.openPanierDatabase({ name });
      await storage.createLocalList(db, draft.listId);
      await storage.commitSealedLocalMutation(db, draft, sealed);
      db.close();
      db = await storage.openPanierDatabase({ name });
      const restored = await storage.loadSealedMutation(db, draft.listId, draft.id);
      const trusted = await crypt.importMemberPublicKey(identity.publicKeyJwk);
      const accepted = await crypt.openMutation({
        listId: draft.listId,
        opaque: { id: draft.id, revision: 1, ciphertext: restored.ciphertext },
        resolveMember: async ({ listId, actorId, epoch }) =>
          listId === draft.listId && actorId === identity.actorId && epoch === 1 ? trusted : null,
        resolveListSecret: async ({ listId, epoch }) =>
          listId === draft.listId && epoch === 1 ? listSecret : null,
      });
      await storage.acceptRemoteOperations(db, draft.listId, [accepted]);
      const state = await storage.readLocalList(db, draft.listId);
      const gone = await storage.loadSealedMutation(db, draft.listId, draft.id);
      db.close();
      return { item: state.accepted.items.itemAA001.name, cursor: state.accepted.revision,
        pending: state.pending.length, ciphertextIdentical: sealed.ciphertext === restored.ciphertext,
        acknowledged: gone === null, nonExtractable: identity.privateKey.extractable === false };
    }, dbName());
    assert.deepEqual(result, {
      item: "Milk", cursor: 1, pending: 0, ciphertextIdentical: true,
      acknowledged: true, nonExtractable: true,
    });
  } finally { await context.close(); }
});

test("in-person QR owner-offline key transfer works in Chromium and Firefox Web Crypto", async () => {
  const context = await browser.newContext();
  try {
    const page = await pageWithModules(context);
    const result = await evaluate(page, async () => {
      const { generateSigningIdentity } = await import("/v2/crypto.mjs");
      const { prepareQrInvitation, prepareQrRedemption, openQrKeyPackage } =
        await import("/v2/qr-pairing.mjs");
      const owner = await generateSigningIdentity();
      const listSecret = crypto.getRandomValues(new Uint8Array(32));
      const issued = await prepareQrInvitation({
        listId: "household01", ownerId: owner.actorId, epoch: 1,
        listSecret, ownerPrivateKey: owner.privateKey,
        ownerPublicJwk: owner.publicKeyJwk,
      });
      const redeem = await prepareQrRedemption(issued.qr);
      // The owner is no longer involved; scanner verifies package independently.
      const imported = await openQrKeyPackage({
        qr: issued.qr, serverRecord: issued.serverRecord,
      });
      return {
        sameKey: imported.listSecret.every((value, i) => value === listSecret[i]),
        sameList: imported.listId === "household01",
        distinctToken: redeem.token !== issued.serverRecord.tokenHash,
        ownerKeyPrivate: owner.privateKey.extractable === false,
      };
    });
    assert.deepEqual(result, {
      sameKey: true, sameList: true, distinctToken: true, ownerKeyPrivate: true,
    });
  } finally { await context.close(); }
});

test("Web Crypto rekey envelope round trip and wrong-recipient refusal in real browsers", async () => {
  const context = await browser.newContext();
  try {
    const page = await pageWithModules(context);
    const result = await evaluate(page, async () => {
      const { generateSigningIdentity } = await import("/v2/crypto.mjs");
      const { generateRecipientAgreementKey, sealRotatedKeyPackages,
        openRotatedKeyPackage } = await import("/v2/rekey.mjs");
      const owner = await generateSigningIdentity();
      const remaining = await generateRecipientAgreementKey();
      const revoked = await generateRecipientAgreementKey();
      const listSecret = crypto.getRandomValues(new Uint8Array(32));
      const rotationHead = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)))
        .replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/g, "");
      const packages = await sealRotatedKeyPackages({
        listId: "household01", ownerId: owner.actorId, epoch: 2,
        rotationHead, ownerSigningKey: owner.privateKey,
        listSecret, removedMemberId: "removed001",
        trustedRecipients: [{ memberId: "memberAA01",
          agreementPublicJwk: remaining.publicJwk }],
      });
      const args = {
        envelope: packages[0], listId: "household01", memberId: "memberAA01",
        currentEpoch: 2, rotationHead, trustedOwnerSigningKey: owner.publicKey,
      };
      const decrypted = await openRotatedKeyPackage({
        ...args, recipientAgreementPrivateKey: remaining.privateKey,
      });
      let refused = false;
      try {
        await openRotatedKeyPackage({
          ...args, recipientAgreementPrivateKey: revoked.privateKey,
        });
      } catch (_) { refused = true; }
      return { sameKey: decrypted.every((byte, i) => byte === listSecret[i]),
        refused, keyNotExtractable: remaining.privateKey.extractable === false };
    });
    assert.deepEqual(result, {
      sameKey: true, refused: true, keyNotExtractable: true,
    });
  } finally { await context.close(); }
});

test("trusted owner genesis and non-extractable private signing key survive browser restart",async()=>{
  const context=await browser.newContext();
  try{
    const page=await pageWithModules(context);
    const result=await evaluate(page,async name=>{
      const trust=await import("/v2/trust.mjs");
      const {generateSigningIdentity}=await import("/v2/crypto.mjs");
      const identity=await generateSigningIdentity();
      let db=await trust.openTrustDatabase({name});
      const prepared=await trust.pinNewOwnerBeforeBootstrap(db,{
        listId:"household01",identity});
      const before=await trust.readPinnedTrust(db,"household01");
      db.close();
      db=await trust.openTrustDatabase({name});
      const recovered=await trust.readPinnedTrust(db,"household01");
      const key=await trust.readLocalOwnerSigningKey(db,"household01");
      const data=new TextEncoder().encode("owner key persisted, no server trust");
      const signature=await crypto.subtle.sign({name:"ECDSA",hash:"SHA-256"},key,data);
      const good=await crypto.subtle.verify({name:"ECDSA",hash:"SHA-256"},
        identity.publicKey,signature,data);
      let denied=false;
      try{await trust.pinNewOwnerBeforeBootstrap(db,{listId:"household01",
        identity:await generateSigningIdentity()});}
      catch(e){denied=/already pinned/.test(e.message);}
      await trust.advancePinnedMembership(db,"household01",[prepared.event]);
      const after=await trust.readPinnedTrust(db,"household01");
      db.close();
      return {sameRoot:before.ownerPublicJwk.x===recovered.ownerPublicJwk.x,
        sameHead:after.checkpoint.head===before.checkpoint.head,
        durableKey:good,nonExtractable:key.extractable===false,
        duplicateRefused:denied,source:recovered.source};
    },dbName());
    assert.deepEqual(result,{sameRoot:true,sameHead:true,durableKey:true,
      nonExtractable:true,duplicateRefused:true,source:"owner-local"});
  }finally{await context.close();}
});

test("recipient trusts owner only through scanned physical QR, not server-provided genesis",async()=>{
  const context=await browser.newContext();
  try{
    const page=await pageWithModules(context);
    const result=await evaluate(page,async name=>{
      const trust=await import("/v2/trust.mjs");
      const {generateSigningIdentity}=await import("/v2/crypto.mjs");
      const {signGenesis}=await import("/v2/membership-ledger.mjs");
      const {prepareQrInvitation}=await import("/v2/qr-pairing.mjs");
      const owner=await generateSigningIdentity();
      const genesis=await signGenesis({listId:"household01",
        ownerId:owner.actorId,ownerPublicJwk:owner.publicKeyJwk,
        privateKey:owner.privateKey});
      const secret=crypto.getRandomValues(new Uint8Array(32));
      const now=Date.now();
      const {qr,serverRecord}=await prepareQrInvitation({
        listId:"household01",ownerId:owner.actorId,epoch:1,listSecret:secret,
        ownerPrivateKey:owner.privateKey,ownerPublicJwk:owner.publicKeyJwk,now});
      const attacker=await generateSigningIdentity();
      const swapped=await signGenesis({listId:"household01",
        ownerId:attacker.actorId,ownerPublicJwk:attacker.publicKeyJwk,
        privateKey:attacker.privateKey});
      const db=await trust.openTrustDatabase({name});
      let rejected=false;
      try{await trust.pinOwnerFromScannedQr(db,{
        qr,serverRecord,events:[swapped],now:now+100});}
      catch(e){rejected=true;}
      const empty=await trust.readPinnedTrust(db,"household01");
      const accepted=await trust.pinOwnerFromScannedQr(db,{
        qr,serverRecord,events:[genesis],now:now+100});
      const pinned=await trust.readPinnedTrust(db,"household01");
      const wrong=await trust.readLocalOwnerSigningKey(db,"household01")
        .then(()=>false,()=>true);
      db.close();
      return {rejected,empty:empty===null,
        sameSecret:accepted.listSecret.every((v,i)=>v===secret[i]),
        pinnedOwner:accepted.trust.ownerId===owner.actorId,
        rootMatches:pinned.ownerPublicJwk.x===owner.publicKeyJwk.x,
        noPrivateKey:wrong,source:pinned.source};
    },dbName());
    assert.deepEqual(result,{rejected:true,empty:true,sameSecret:true,
      pinnedOwner:true,rootMatches:true,noPrivateKey:true,source:"physical-qr"});
  }finally{await context.close();}
});

test("two tabs cannot persist different valid membership forks over the same checkpoint",async()=>{
  const context=await browser.newContext();
  try{
    const a=await pageWithModules(context),b=await pageWithModules(context);
    const name=dbName();
    const histories=await evaluate(a,async name=>{
      const trust=await import("/v2/trust.mjs");
      const {generateSigningIdentity}=await import("/v2/crypto.mjs");
      const {generateRecipientAgreementKey}=await import("/v2/rekey.mjs");
      const {prepareQrInvitation}=await import("/v2/qr-pairing.mjs");
      const {enrollmentStatement}=await import("/v2/qr-registry.mjs");
      const owner=await generateSigningIdentity();
      const db=await trust.openTrustDatabase({name});
      const {event}=await trust.pinNewOwnerBeforeBootstrap(db,{
        listId:"household01",identity:owner});
      const pinned=await trust.readPinnedTrust(db,"household01");
      db.close();
      const make=async memberId=>{
        const signer=await generateSigningIdentity();
        const agreement=await generateRecipientAgreementKey();
        const {serverRecord}=await prepareQrInvitation({
          listId:"household01",ownerId:owner.actorId,epoch:1,
          listSecret:crypto.getRandomValues(new Uint8Array(32)),
          ownerPublicJwk:owner.publicKeyJwk,
          ownerPrivateKey:owner.privateKey});
        const nonce=btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))))
          .replaceAll("+","-").replaceAll("/","_").replace(/=+$/g,"");
        const proof=await crypto.subtle.sign({name:"ECDSA",hash:"SHA-256"},
          signer.privateKey,new TextEncoder().encode(enrollmentStatement({
            listId:"household01",inviteId:serverRecord.inviteId,memberId,nonce,
            tokenHash:serverRecord.tokenHash,agreementPublicJwk:agreement.publicJwk,
          })));
        const encoded=btoa(String.fromCharCode(...new Uint8Array(proof)))
          .replaceAll("+","-").replaceAll("/","_").replace(/=+$/g,"");
        return {v:2,kind:"join",listId:"household01",sequence:2,
          previous:pinned.checkpoint.head,ownerId:owner.actorId,epoch:1,
          inviteId:serverRecord.inviteId,memberId,
          memberPublicJwk:{kty:"EC",crv:"P-256",
            x:signer.publicKeyJwk.x,y:signer.publicKeyJwk.y},
          agreementPublicJwk:agreement.publicJwk,nonce,proof:encoded,grant:serverRecord};
      };
      return {name,first:[event,await make("newmember01")],
        second:[event,await make("newmember02")]};
    },name);
    const attempt=(page,events)=>evaluate(page,async({name,events})=>{
      const trust=await import("/v2/trust.mjs");
      const db=await trust.openTrustDatabase({name});
      try{
        return (await trust.advancePinnedMembership(db,"household01",events))
          .checkpoint.head;
      }finally{db.close();}
    },{name,events});
    const outcome=await Promise.allSettled([
      attempt(a,histories.first),attempt(b,histories.second)]);
    assert.equal(outcome.filter(x=>x.status==="fulfilled").length,1);
    assert.equal(outcome.filter(x=>x.status==="rejected").length,1);
    const persisted=await evaluate(a,async name=>{
      const trust=await import("/v2/trust.mjs");
      const db=await trust.openTrustDatabase({name});
      const value=await trust.readPinnedTrust(db,"household01");
      db.close();
      return value.checkpoint;
    },name);
    assert.equal(persisted.sequence,2);
    assert.equal(persisted.head,outcome.find(x=>x.status==="fulfilled").value);
    const stale=await evaluate(b,async({name,events})=>{
      const trust=await import("/v2/trust.mjs");
      const db=await trust.openTrustDatabase({name});
      try{await trust.advancePinnedMembership(db,"household01",events);
        return false;}catch(e){return /rollback/.test(e.message);}
      finally{db.close();}
    },{name,events:[histories.first[0]]});
    assert.equal(stale,true);
  }finally{await context.close();}
});
