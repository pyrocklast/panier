// Browser-real IndexedDB tests: no server, build tools, app state or v1 data.
// Runs in Chromium/Firefox via Playwright. The secure synthetic origin is routed
// to the v2 modules, avoiding any actual network requests.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const browserType = require("playwright")[process.env.BROWSER || "chromium"];
const STORAGE_SOURCE = readFileSync(fileURLToPath(new URL("../v2/storage.mjs", import.meta.url)), "utf8");
const DOMAIN_SOURCE = readFileSync(fileURLToPath(new URL("../v2/domain.mjs", import.meta.url)), "utf8");
const ORIGIN = "https://panier-v2.test";
let browser;

before(async () => { browser = await browserType.launch(); });
after(async () => { await browser.close(); });

async function pageWithModules(context) {
  const page = await context.newPage();
  await page.route(ORIGIN + "/**", async route => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/") return route.fulfill({ status: 200, contentType: "text/html", body: "<title>V2 storage test</title>" });
    if (path === "/v2/storage.mjs") return route.fulfill({ status: 200, contentType: "text/javascript", body: STORAGE_SOURCE });
    if (path === "/v2/domain.mjs") return route.fulfill({ status: 200, contentType: "text/javascript", body: DOMAIN_SOURCE });
    return route.fulfill({ status: 404, body: "not found" });
  });
  await page.goto(ORIGIN + "/");
  return page;
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
    const result = await page.evaluate(async ({ name, mutation }) => {
      const s = await import("/v2/storage.mjs");
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
    const result = await page.evaluate(async ({ name, local, remote, ack }) => {
      const s = await import("/v2/storage.mjs");
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
    await a.evaluate(async name => {
      const s = await import("/v2/storage.mjs");
      const db = await s.openPanierDatabase({ name });
      await s.createLocalList(db, "household01"); db.close();
    }, name);
    const write = (page, id, itemId) => page.evaluate(async ({ name, id, itemId }) => {
      const s = await import("/v2/storage.mjs");
      const db = await s.openPanierDatabase({ name });
      await s.commitLocalMutation(db, { listId: "household01", id, type: "item.add",
        payload: { id: itemId, name: id, position: "a" } });
      db.close();
    }, { name, id, itemId });
    await Promise.all([write(a, "mutation01", "itemAA001"), write(b, "mutation02", "itemBB002")]);
    const value = await a.evaluate(async name => {
      const s = await import("/v2/storage.mjs");
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
    const value = await page.evaluate(async name => {
      const s = await import("/v2/storage.mjs");
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
    const result = await page.evaluate(async name => {
      const s = await import("/v2/storage.mjs");
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
    const result = await page.evaluate(async name => {
      const s = await import("/v2/storage.mjs");
      let changed = 0;
      const db = await s.openPanierDatabase({ name, onVersionChange: () => changed++ });
      await s.createLocalList(db, "household01");
      await s.createLocalList(db, "household02");
      await s.commitLocalMutation(db, { listId: "household01", id: "mutation01",
        type: "item.add", payload: { id: "itemAA001", name: "Milk", position: "a" } });
      const other = await s.readLocalList(db, "household02");
      const opened = indexedDB.open(name, 2);
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
    const result = await page.evaluate(async () => {
      const { requestPersistentStorage } = await import("/v2/storage.mjs");
      const outcome = await requestPersistentStorage();
      return { supported: typeof outcome.supported, granted: typeof outcome.granted };
    });
    assert.deepEqual(result, { supported: "boolean", granted: "boolean" });
  } finally { await context.close(); }
});
