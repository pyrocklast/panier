// Browser tests: two simulated phones using the app against a running server, Go or
// Cloudflare Worker.
//
//   BASE=http://127.0.0.1:8080 SETUP=ABCD-EFGH-JKMN STORE=./data node --test test/browser.test.mjs
//
// STORE, optional, is the server's data directory; the tests then check that no item
// name was ever written to it. BROWSER picks Playwright's chromium (the default) or
// firefox.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const ENGINE = process.env.BROWSER || "chromium";
const engine = require("playwright")[ENGINE];

const BASE = process.env.BASE || "http://127.0.0.1:8080";
const SETUP = process.env.SETUP;
if (!SETUP) throw new Error("set SETUP to the server's setup code");

let browser;
before(async () => { browser = await engine.launch(); });
after(async () => { await browser.close(); });

/* ---------- Helpers ---------- */

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function eventually(fn, ms = 6000) {
  const end = Date.now() + ms;
  for (;;) {
    try { if (await fn()) return true; } catch (_) {}
    if (Date.now() > end) return false;
    await sleep(100);
  }
}

async function phone(errors, options = {}) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, ...options });
  const page = await ctx.newPage();
  watch(page, errors);
  return { ctx, page };
}
function watch(page, errors) {
  page.on("pageerror", e => errors.push(String(e)));
  page.on("console", m => {
    // Being offline is expected in some tests: Chromium and Firefox each log it in their own words.
    if (m.type() === "error" && !/ERR_INTERNET_DISCONNECTED|Failed to load resource|can.t establish a connection to the server/.test(m.text())) errors.push(m.text());
  });
}

// Two phones sharing a new list: A creates it, B joins with the pairing link.
async function pair(options) {
  const errors = [];
  const A = await phone(errors, options), B = await phone(errors, options);
  await A.page.goto(BASE + "/#setup=" + SETUP.toLowerCase());
  await A.page.locator("#pair").waitFor();
  await A.page.click("#pair-close");
  const key = await A.page.evaluate(() => JSON.parse(localStorage.getItem("panier")).key);
  await B.page.goto(BASE + "/#k=" + key);
  await B.page.locator("#app").waitFor();
  return {
    A: A.ctx, B: B.ctx, a: A.page, b: B.page, key, errors,
    async close() {
      await A.ctx.close();
      await B.ctx.close();
      assert.deepEqual(errors, [], "no errors in the pages");
    },
  };
}

const add = async (pg, sec, text) => { await pg.fill("#add-" + sec, text); await pg.press("#add-" + sec, "Enter"); };
const section = (pg, name) => pg.locator(`#list .sec:has(.sec-name:text-is("${name}"))`);
const texts = (pg, name) => section(pg, name).locator(".items .text").allInnerTexts();
const names = pg => pg.locator("#list .sec-name").allInnerTexts();
const ticked = pg => pg.locator("#basket-list .text").allInnerTexts();
const item = (pg, text) => pg.locator(`#list .item:has(.text:text-is("${text}"))`);
const blur = pg => pg.evaluate(() => document.activeElement.blur());
async function offline(ctx, pg) { await ctx.setOffline(true); await pg.evaluate(() => dispatchEvent(new Event("offline"))); }
async function online(ctx, pg) { await ctx.setOffline(false); await pg.evaluate(() => dispatchEvent(new Event("online"))); }
async function renameSection(pg, from, to) {
  await section(pg, from).locator(".sec-name").click();
  await pg.keyboard.press("Control+A");
  await pg.keyboard.type(to);
  await pg.keyboard.press("Enter");
}

// Drags an item with the mouse to a point; returns before releasing if hold is set.
async function dragTo(pg, from, toY, { hold = false } = {}) {
  const box = await from.boundingBox();
  const x = box.x + 60, y = box.y + box.height / 2;
  await pg.mouse.move(x, y);
  await pg.mouse.down();
  await pg.mouse.move(x, y + 10);
  const target = typeof toY === "function" ? await toY() : toY;
  for (let i = 1; i <= 20; i++) {
    await pg.mouse.move(x, y + ((target - y) * i) / 20);
    await sleep(20);
  }
  await sleep(150);
  if (!hold) await pg.mouse.up();
}

/* ---------- Tests ---------- */

test("two phones share changes live", async () => {
  const t = await pair();
  const { a, b } = t;
  await add(a, "ess", "Milk");
  await add(a, "ess", "Bread");
  await add(a, "look", "Ripe avocados");
  assert.ok(await eventually(async () => (await texts(b, "Essentials")).join() === "Milk,Bread" && (await texts(b, "Look out for")).join() === "Ripe avocados"));

  await item(b, "Milk").locator(".boxcell").click();
  assert.ok(await eventually(async () => (await ticked(a)).includes("Milk")), "a tick reaches the other phone");

  await item(b, "Bread").locator(".text").click();
  await b.keyboard.press("End");
  await b.keyboard.type(" (sliced)");
  await b.keyboard.press("Enter");
  assert.ok(await eventually(async () => (await texts(a, "Essentials")).includes("Bread (sliced)")), "a rename reaches the other phone");

  await item(a, "Ripe avocados").locator(".text").click();
  await a.locator(".item .bin").click();
  assert.ok(await eventually(async () => (await texts(b, "Look out for")).length === 0), "a delete reaches the other phone");
  await a.click("#undo");
  assert.ok(await eventually(async () => (await texts(b, "Look out for")).join() === "Ripe avocados"), "undo reaches the other phone");

  await a.click("#pair-open");
  assert.equal(await a.locator("#pair-title").innerText(), "Add someone to this list");
  await a.click("#pair-close");
  await t.close();
});

test("undo leaves the other phone's later change alone", async () => {
  const t = await pair();
  const { a, b } = t;
  await add(a, "ess", "Bread");
  assert.ok(await eventually(async () => (await texts(b, "Essentials")).includes("Bread")));
  await item(a, "Bread").locator(".text").click();
  await a.keyboard.press("End");
  await a.keyboard.type(" (sliced)");
  await a.keyboard.press("Enter");
  assert.ok(await eventually(async () => (await texts(b, "Essentials")).includes("Bread (sliced)")));
  await item(b, "Bread (sliced)").locator(".text").click();
  await b.keyboard.press("Control+A");
  await b.keyboard.type("Sourdough");
  await b.keyboard.press("Enter");
  assert.ok(await eventually(async () => (await texts(a, "Essentials")).includes("Sourdough")));
  await a.click("#undo");
  await sleep(300);
  assert.deepEqual(await texts(a, "Essentials"), ["Sourdough"]);
  assert.match(await a.locator("#live").innerText(), /other phone already changed it/);
  await t.close();
});

test("changes made offline are sent later, the status says so, and the app opens offline", async () => {
  const t = await pair();
  const { a, b, A, B } = t;
  await offline(B, b);
  await add(b, "long", "Bike lights");
  await blur(b); // the status hides while you type, like undo
  assert.ok(await eventually(() => b.locator("#status").isVisible(), 4000), "the status appears");
  assert.equal(await b.locator("#status-text").innerText(), "Offline");
  await b.click("#status-pill");
  assert.match(await b.locator("#status-detail").innerText(), /1 change is saved on this phone and sent when you're back online/);
  assert.deepEqual(await texts(a, "Long term"), [], "nothing reaches the other phone yet");
  await online(B, b);
  assert.ok(await eventually(async () => (await texts(a, "Long term")).join() === "Bike lights", 10000), "sent when back online");
  assert.ok(await eventually(async () => !(await b.locator("#status").isVisible())), "the status goes away");

  await offline(A, a);
  await a.reload();
  await a.locator("#app").waitFor();
  assert.deepEqual(await texts(a, "Long term"), ["Bike lights"], "the app and list open offline");
  await online(A, a);
  await t.close();
});

test("the server stores no item names", { skip: !process.env.STORE }, async () => {
  const t = await pair();
  const words = ["Camembert", "Baguette tradition", "Persil frais"];
  for (const w of words) await add(t.a, "ess", w);
  assert.ok(await eventually(async () => (await texts(t.b, "Essentials")).length === 3));
  const all = [];
  const walk = dir => {
    for (const f of readdirSync(dir)) {
      const p = join(dir, f);
      if (statSync(p).isDirectory()) walk(p);
      else all.push(readFileSync(p));
    }
  };
  walk(process.env.STORE);
  const blob = Buffer.concat(all);
  for (const w of words) assert.ok(!blob.includes(w), w + " must not appear on the server");
  await t.close();
});

test("sections can be renamed, added, and deleted once empty", async () => {
  const t = await pair();
  const { a, b } = t;
  assert.deepEqual(await names(a), ["Essentials", "Look out for", "Long term"]);
  await add(a, "long", "Bike lights");

  await renameSection(a, "Essentials", "Weekly");
  assert.ok(await eventually(async () => (await names(b))[0] === "Weekly"), "a rename reaches the other phone");
  await a.click("#undo");
  assert.ok(await eventually(async () => (await names(a))[0] === "Essentials" && (await names(b))[0] === "Essentials"), "undo restores the default name");

  await a.fill("#add-sec", "Fruit & Veg");
  const type = sel => a.evaluate(s => { const c = getComputedStyle(document.querySelector(s)); return c.fontSize + " " + c.fontWeight; }, sel);
  assert.equal(await type("#add-sec"), await type(".sec-name"), "a new section's name is typed like one");
  await a.press("#add-sec", "Enter");
  assert.equal(await a.evaluate(() => document.activeElement.getAttribute("aria-label")), "Add item to Fruit & Veg", "the cursor moves to the new section at once");
  await a.keyboard.type("Apples");
  await a.keyboard.press("Enter");
  assert.ok(await eventually(async () => (await texts(b, "Fruit & Veg")).join() === "Apples"));

  await section(a, "Long term").locator(".sec-name").click();
  assert.equal(await a.locator(".sec-head .bin").count(), 0, "no bin while a section has items");
  await a.keyboard.press("Escape");

  await a.fill("#add-sec", "Temp");
  await a.press("#add-sec", "Enter");
  await blur(a);
  await section(a, "Temp").locator(".sec-name").click();
  await a.locator(".sec-head .bin").click();
  assert.ok(await eventually(async () => !(await names(b)).includes("Temp")), "deleting reaches the other phone");
  await a.click("#undo");
  assert.ok(await eventually(async () => (await names(b)).includes("Temp")), "undo brings it back");
  await t.close();
});

test("a section deleted on one phone while the other adds to it stays", async () => {
  const t = await pair();
  const { a, b, B } = t;
  await a.fill("#add-sec", "Temp");
  await a.press("#add-sec", "Enter");
  await blur(a);
  assert.ok(await eventually(async () => (await names(b)).includes("Temp")));
  await offline(B, b);
  const field = section(b, "Temp").locator(".add-input");
  await field.fill("Batteries");
  await field.press("Enter");
  await section(a, "Temp").locator(".sec-name").click();
  await a.locator(".sec-head .bin").click();
  await online(B, b);
  assert.ok(await eventually(async () => (await texts(a, "Temp")).join() === "Batteries" && (await texts(b, "Temp")).join() === "Batteries", 10000));
  await t.close();
});

test("dragging an item onto the drop zone ticks it", async () => {
  const t = await pair();
  const { a, b } = t;
  for (const w of ["Milk", "Bread", "Eggs"]) await add(a, "ess", w);
  await blur(a);
  await sleep(300);
  await dragTo(a, item(a, "Bread"), async () => {
    const z = await a.locator("#tick-drop").boundingBox();
    return z.y + z.height / 2;
  }, { hold: true });
  assert.equal(await a.locator(".ghost.to-tick").count(), 1, "the item shows as ticked over the zone");
  assert.equal(await a.locator("#tick-drop.over").count(), 1);
  await a.mouse.up();
  await sleep(300);
  assert.ok((await ticked(a)).includes("Bread"));
  assert.deepEqual(await texts(a, "Essentials"), ["Milk", "Eggs"]);
  assert.ok(!(await a.locator("#tick-drop").isVisible()), "the zone hides again");
  assert.ok(await eventually(async () => (await ticked(b)).includes("Bread")));
  await t.close();
});

test("an item dropped back where it started shows again", async () => {
  const t = await pair();
  const { a } = t;
  for (const w of ["Milk", "Bread", "Eggs"]) await add(a, "ess", w);
  await blur(a);
  await sleep(300);
  const box = await item(a, "Bread").boundingBox();
  await dragTo(a, item(a, "Bread"), box.y + 80, { hold: true }); // away, past Eggs
  const start = box.y + box.height / 2 - 12; // inside its original slot
  for (let i = 1; i <= 10; i++) { await a.mouse.move(box.x + 60, box.y + 80 + ((start - box.y - 80) * i) / 10); await sleep(20); }
  await sleep(150);
  await a.mouse.up();
  await sleep(300);
  assert.deepEqual(await texts(a, "Essentials"), ["Milk", "Bread", "Eggs"]);
  assert.equal(await a.locator(".item.placeholder").count(), 0, "no item is left as an empty slot");
  assert.ok(await item(a, "Bread").locator(".text").isVisible());
  await t.close();
});

test("unticking an item from a deleted section puts it in the first section", async () => {
  const t = await pair();
  const { a } = t;
  await a.fill("#add-sec", "Fruit & Veg");
  await a.press("#add-sec", "Enter");
  await a.keyboard.type("Apples");
  await a.keyboard.press("Enter");
  await blur(a);
  await item(a, "Apples").locator(".boxcell").click();
  await sleep(1900);
  await section(a, "Fruit & Veg").locator(".sec-name").click();
  await a.locator(".sec-head .bin").click();
  await a.locator('#basket-list .item:has(.text:text-is("Apples")) .boxcell').click();
  await sleep(400);
  assert.ok((await texts(a, "Essentials")).includes("Apples"));
  assert.ok(!(await names(a)).includes("Fruit & Veg"));
  await t.close();
});

test("items hold 120 characters, four lines on a phone", async () => {
  const t = await pair();
  const long = "Organic free-range eggs from the market stall near the church, the brown ones in the cardboard box of twelve, not the six-pack";
  await add(t.a, "ess", long + " and more");
  const text = item(t.a, long.slice(0, 120).trim()).locator(".text");
  assert.equal((await text.innerText()).length, 120);
  const lines = Math.round(((await text.boundingBox()).height - 28) / 23.8);
  assert.equal(lines, 4);
  await t.close();
});

test("leaving the Add item field adds the item, and the tap still works", async () => {
  const t = await pair();
  const { a, b } = t;
  await add(a, "ess", "Milk");
  await add(a, "ess", "Bread");
  await item(a, "Bread").locator(".boxcell").click();
  await sleep(1900);

  await a.fill("#add-ess", "Lemons");
  assert.equal(await a.locator('.sec[data-sec="ess"] .add.typing').count(), 1, "typing makes the row an item");
  await item(a, "Milk").locator(".boxcell").click();
  await sleep(500);
  assert.ok((await texts(a, "Essentials")).includes("Lemons"), "leaving adds the item");
  assert.ok(await item(a, "Milk").locator(".chk").isChecked(), "the tap that left the field still ticks Milk");
  assert.equal(await a.inputValue("#add-ess"), "");
  assert.ok(await eventually(async () => (await texts(b, "Essentials")).includes("Lemons")));

  await a.fill("#add-ess", "bread");
  await blur(a);
  await sleep(400);
  assert.equal((await texts(a, "Essentials")).filter(x => x === "Bread").length, 1, "a name bought before brings that item back");

  await a.fill("#add-look", "MILK");
  await blur(a);
  await sleep(400);
  const all = (await a.locator("#list .items .text").allInnerTexts()).map(x => x.toLowerCase());
  assert.equal(all.filter(x => x === "milk").length, 1, "a duplicate adds nothing");
  assert.equal(await a.inputValue("#add-look"), "");
  await t.close();
});

test("text left in the field when the app closes is added next time", async () => {
  const t = await pair();
  const { A, b } = t;
  let a = t.a;
  await a.fill("#add-long", "Coffee filters");
  assert.match(await a.evaluate(() => localStorage.getItem("panier-drafts")), /Coffee filters/);
  await A.setOffline(true);
  const next = await A.newPage();
  watch(next, t.errors);
  await a.close();
  a = next;
  await a.goto(BASE + "/");
  await a.locator("#app").waitFor();
  assert.deepEqual(await texts(a, "Long term"), ["Coffee filters"]);
  await online(A, a);
  assert.ok(await eventually(async () => (await texts(b, "Long term")).join() === "Coffee filters", 10000));
  await t.close();
});

const clearText = async pg => { await pg.keyboard.press("Control+A"); await pg.keyboard.press("Backspace"); };
const editing = pg => pg.evaluate(() => {
  const el = document.activeElement, sel = getSelection();
  return { editing: el.isContentEditable, text: el.textContent, at: sel.focusOffset };
});

test("clearing an item's text deletes it, and the tap that left it still works", async () => {
  const t = await pair();
  const { a, b } = t;
  for (const x of ["Milk", "Eggs", "Bread"]) await add(a, "ess", x);
  assert.ok(await eventually(async () => (await texts(b, "Essentials")).length === 3));

  await item(a, "Milk").locator(".text").click();
  await clearText(a);
  await a.keyboard.press("Enter");
  assert.ok(await eventually(async () => (await texts(a, "Essentials")).join() === "Eggs,Bread"), "an emptied item is deleted");
  assert.ok(await eventually(async () => (await texts(b, "Essentials")).join() === "Eggs,Bread"), "the delete reaches the other phone");
  await a.click("#undo");
  assert.deepEqual(await texts(a, "Essentials"), ["Milk", "Eggs", "Bread"], "undo brings it back");

  await item(a, "Milk").locator(".text").click();
  await clearText(a);
  await a.evaluate(() => { document.hasFocus = () => false; document.activeElement.blur(); delete document.hasFocus; });
  await sleep(200);
  assert.deepEqual(await texts(a, "Essentials"), ["Milk", "Eggs", "Bread"], "switching apps with the text cleared keeps the item");

  await item(a, "Eggs").locator(".text").click();
  await clearText(a);
  await item(a, "Bread").locator(".boxcell").click();
  await sleep(300);
  assert.ok(await item(a, "Bread").locator(".chk").isChecked(), "the tap that left it still ticks Bread");
  await sleep(1900);
  assert.deepEqual(await texts(a, "Essentials"), ["Milk"]);
  assert.deepEqual(await ticked(a), ["Bread"]);

  await add(a, "ess", "Butter");
  await item(a, "Milk").locator(".text").click();
  await clearText(a);
  await item(a, "Butter").locator(".text").click();
  assert.equal((await editing(a)).text, "Butter", "the tap that left it starts editing Butter");
  await a.keyboard.press("End");
  await a.keyboard.type(" (salted)");
  await a.keyboard.press("Enter");
  assert.ok(await eventually(async () => (await texts(a, "Essentials")).join() === "Butter (salted)"), "Milk goes once the edit ends");
  assert.ok(await eventually(async () => (await texts(b, "Essentials")).join() === "Butter (salted)"));
  await t.close();
});

test("Enter in the middle of an item splits it in two", async () => {
  const t = await pair();
  const { a, b } = t;
  await add(a, "ess", "Milk eggs");
  await add(a, "ess", "Bread");
  await item(a, "Milk eggs").locator(".text").click();
  await a.keyboard.press("Home");
  for (let i = 0; i < 5; i++) await a.keyboard.press("ArrowRight");
  await a.keyboard.press("Enter");
  assert.deepEqual(await texts(a, "Essentials"), ["Milk", "eggs", "Bread"]);
  assert.deepEqual(await editing(a), { editing: true, text: "eggs", at: 0 }, "the cursor is at the start of the second part");
  await a.keyboard.type("Free-range ");
  await blur(a);
  assert.ok(await eventually(async () => (await texts(a, "Essentials")).join() === "Milk,Free-range eggs,Bread"));
  assert.ok(await eventually(async () => (await texts(b, "Essentials")).join() === "Milk,Free-range eggs,Bread"), "both parts reach the other phone");

  await a.click("#undo"); // the edit after splitting
  await a.click("#undo"); // the split
  assert.deepEqual(await texts(a, "Essentials"), ["Milk eggs", "Bread"], "one undo joins the parts again");

  await item(a, "Bread").locator(".text").click();
  await a.keyboard.press("End");
  await a.keyboard.press("Enter");
  assert.deepEqual(await texts(a, "Essentials"), ["Milk eggs", "Bread"], "Enter at the end only finishes editing");
  assert.equal((await editing(a)).editing, false);

  await item(a, "Milk eggs").locator(".text").click();
  await a.keyboard.press("End");
  await a.keyboard.type(" bread");
  for (let i = 0; i < 5; i++) await a.keyboard.press("ArrowLeft");
  await a.keyboard.press("Enter");
  assert.deepEqual(await texts(a, "Essentials"), ["Milk eggs", "Bread"], "a part already on the list isn't added twice");
  await t.close();
});

test("a × on a suggestion removes that item for good", async () => {
  const t = await pair();
  const { a, b } = t;
  for (const x of ["Mlik", "Milk", "Mild cheese"]) {
    await add(a, "ess", x);
    await item(a, x).locator(".boxcell").click();
  }
  await sleep(1900);
  assert.ok(await eventually(async () => (await ticked(b)).length === 3));

  await a.fill("#add-ess", "mli");
  assert.deepEqual(await a.locator("#sug-ess .t").allInnerTexts(), ["Mlik"]);
  await a.locator("#sug-ess .sug-x").first().click();
  assert.equal(await a.locator("#sug-ess").isHidden(), true, "the suggestion goes");
  assert.equal(await a.evaluate(() => document.activeElement.id), "add-ess", "the cursor stays in the field");
  assert.equal(await a.inputValue("#add-ess"), "mli");
  assert.deepEqual(await ticked(a), ["Mild cheese", "Milk"]);
  assert.ok(await eventually(async () => (await ticked(b)).join() === "Mild cheese,Milk"), "it goes on the other phone too");

  await a.fill("#add-ess", "mil");
  assert.deepEqual(await a.locator("#sug-ess .t").allInnerTexts(), ["Mild cheese", "Milk"]);
  await a.keyboard.press("ArrowDown");
  await a.keyboard.press("ArrowRight");
  assert.equal(await a.getAttribute("#add-ess", "aria-activedescendant"), "sug-ess-0-x");
  await a.keyboard.press("Enter");
  assert.deepEqual(await a.locator("#sug-ess .t").allInnerTexts(), ["Milk"], "the keyboard can remove one too");

  await a.fill("#add-ess", "");
  await blur(a);
  await a.click("#undo");
  assert.deepEqual(await ticked(a), ["Mild cheese", "Milk"], "undo brings it back");
  await t.close();
});

// With a finger, a field is left only once it lifts, just before the tap itself.
test("on a touch screen, the tap that leaves an item still lands", async () => {
  const t = await pair(ENGINE === "firefox" ? { hasTouch: true } : { hasTouch: true, isMobile: true });
  const { a, b } = t;
  for (const x of ["Milk", "Eggs", "Bread", "Tea"]) await add(a, "ess", x);
  await blur(a);

  await item(a, "Eggs").locator(".text").tap();
  await clearText(a);
  await item(a, "Bread").locator(".boxcell").tap();
  await sleep(300);
  assert.ok(await item(a, "Bread").locator(".chk").isChecked(), "after clearing an item, the tap ticks Bread");
  assert.equal(await item(a, "Eggs").count(), 0);

  await item(a, "Milk").locator(".text").tap();
  await a.keyboard.press("End");
  await a.keyboard.type(" (oat)");
  await item(a, "Tea").locator(".text").tap();
  assert.equal((await editing(a)).text, "Tea", "after renaming an item, the tap edits Tea");
  await a.keyboard.press("Escape");
  assert.ok(await eventually(async () => (await texts(b, "Essentials")).includes("Milk (oat)")));
  await t.close();
});
