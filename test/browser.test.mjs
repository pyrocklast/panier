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
    // So is Firefox noting a live connection cut short when a test reloads the page.
    if (m.type() === "error" && !/ERR_INTERNET_DISCONNECTED|Failed to load resource|can.t establish a connection to the server|was interrupted while the page was loading/.test(m.text())) errors.push(m.text());
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
// An item by its whole text, including a quantity shown apart from the name.
const exactly = text => new RegExp("^\\s*" + text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s*$");
const item = (pg, text) => pg.locator("#list .item").filter({ has: pg.locator(".text", { hasText: exactly(text) }) });
const blur = pg => pg.evaluate(() => document.activeElement.blur());
async function offline(ctx, pg) { await ctx.setOffline(true); await pg.evaluate(() => dispatchEvent(new Event("offline"))); }
async function online(ctx, pg) { await ctx.setOffline(false); await pg.evaluate(() => dispatchEvent(new Event("online"))); }
async function renameSection(pg, from, to) {
  await section(pg, from).locator(".sec-name").click();
  await pg.keyboard.press("Control+A");
  await pg.keyboard.type(to);
  await pg.keyboard.press("Enter");
}

async function renameList(pg, to) {
  await pg.click("#list-name");
  await pg.keyboard.press("Control+A");
  await pg.keyboard.type(to);
  await pg.keyboard.press("Enter");
}

// Waits until nothing is gliding (see Motion in app.js), so positions measured next are final.
const still = pg => pg.waitForFunction(() => !document.getAnimations().some(a => (a.id === "glide" || a.id === "fly") && a.playState === "running"));

// Drags an item with the mouse to a point; returns before releasing if hold is set.
async function dragTo(pg, from, toY, { hold = false } = {}) {
  await still(pg);
  const box = await from.boundingBox();
  const x = box.x + 60, y = box.y + box.height / 2;
  await pg.mouse.move(x, y);
  await pg.mouse.down();
  await pg.mouse.move(x, y + 10);
  await still(pg);
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
  assert.equal(await a.locator("#undo-what").innerText(), "Ripe avocados", "undo names what it would bring back");
  assert.equal(await a.locator("#redo").isVisible(), false, "redo only shows once something has been undone");
  await a.click("#undo");
  assert.ok(await eventually(async () => (await texts(b, "Look out for")).join() === "Ripe avocados"), "undo reaches the other phone");
  assert.equal(await a.locator("#undo-what").isVisible(), false);
  assert.equal(await a.locator("#redo").isVisible(), true, "and now redo can put the delete back");

  await a.click("#pair-open");
  assert.equal(await a.locator("#pair-title").innerText(), "Add someone to this list");
  await a.click("#pair-close");

  assert.equal(await b.evaluate(() => typeof window.qrcode), "undefined", "the QR code library loads only for pairing");
  await b.click("#pair-open");
  assert.ok(await eventually(async () => (await b.locator("#qr svg").count()) === 1), "and draws the code when pairing opens");
  await b.click("#pair-close");
  assert.equal(await a.locator(".item .boxcell svg").count(), 0, "tick boxes draw their tick and grip in CSS");
  await t.close();
});

test("what the other phone changes is tinted where it is", async () => {
  const t = await pair();
  const { a, b } = t;
  const tinted = (pg, sel = "#list") => pg.locator(sel + " .item.flash .text").allInnerTexts();
  for (const x of ["Milk", "Bread", "Eggs"]) await add(a, "ess", x);
  await blur(a);
  assert.ok(await eventually(async () => (await texts(b, "Essentials")).join() === "Milk,Bread,Eggs"));
  assert.ok(await eventually(async () => (await tinted(b)).length > 0), "items the other phone adds are tinted");

  await item(b, "Eggs").locator(".chk").focus();
  await b.keyboard.press("Alt+ArrowUp");
  assert.ok(await eventually(async () => (await texts(a, "Essentials")).join() === "Milk,Eggs,Bread"));
  await sleep(300);
  assert.deepEqual(await tinted(a), [], "a change of order alone isn't");
  await item(b, "Bread").locator(".boxcell").click();
  assert.ok(await eventually(async () => (await tinted(a, "#basket-list")).join() === "Bread"), "an item the other phone ticks is, in the ticked group");

  const C = await browser.newContext({ viewport: { width: 390, height: 844 } }), c = await C.newPage();
  await c.goto(BASE + "/#k=" + t.key);
  assert.ok(await eventually(async () => (await texts(c, "Essentials")).join() === "Milk,Eggs"));
  assert.deepEqual(await c.locator(".item.flash").allInnerTexts(), [], "a phone opening the list for the first time sees nothing tinted");
  await C.close();
  await t.close();
});

test("a link to another list asks before this phone leaves its own", async () => {
  const t = await pair();
  const { a, A } = t;
  await add(a, "ess", "Milk");
  await blur(a);
  const other = await browser.newContext(), o = await other.newPage();
  await o.goto(BASE + "/#setup=" + SETUP.toLowerCase());
  await o.locator("#pair").waitFor();
  await o.click("#pair-close");
  await add(o, "ess", "Garden hose");
  assert.ok(await eventually(() => o.evaluate(() => { // saved, and sent, before that phone closes
    const st = JSON.parse(localStorage.getItem("panier"));
    return !st.outbox.length && Object.values(st.items).some(f => f.text && f.text[0] === "Garden hose");
  })));
  const key2 = await o.evaluate(() => JSON.parse(localStorage.getItem("panier")).key);
  await other.close();

  await a.goto("about:blank");
  await a.goto(BASE + "/#k=" + t.key);
  await a.locator("#app").waitFor();
  assert.equal(await a.locator("#switch").isVisible(), false, "its own link opens the list without asking");

  await a.goto("about:blank"); // a link opened from another app loads the page afresh
  await a.goto(BASE + "/#k=" + key2);
  await a.locator("#switch").waitFor();
  assert.equal(await a.locator("#switch-text").innerText(), "This phone will leave “Shopping list” and open the list from the link.");
  assert.equal(await a.locator("#switch-lost").isVisible(), false);
  await a.click("#switch-cancel");
  assert.equal(await a.locator("#switch").isVisible(), false);
  assert.deepEqual(await texts(a, "Essentials"), ["Milk"], "Cancel keeps the list");
  assert.equal(await a.evaluate(() => JSON.parse(localStorage.getItem("panier")).key), t.key);

  await offline(A, a);
  await add(a, "ess", "Bread");
  await blur(a);
  await a.goto("about:blank"); // a link opened from another app loads the page afresh
  await a.goto(BASE + "/#k=" + key2);
  await a.locator("#switch").waitFor();
  assert.equal(await a.locator("#switch-lost").innerText(), "1 change made here hasn't been sent yet, and would be lost.");
  await online(A, a);
  await a.click("#switch-ok");
  assert.ok(await eventually(async () => (await texts(a, "Essentials")).join() === "Garden hose", 10000), "Switch opens the other list");
  assert.equal(await a.evaluate(() => JSON.parse(localStorage.getItem("panier")).key), key2);
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
  assert.match(await b.locator("#status-detail").innerText(), /1 change is saved on this phone, to be sent when you're back online/);
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
  await renameList(t.a, "Marché du samedi");
  words.push("Marché du samedi");
  assert.ok(await eventually(async () => (await t.b.locator("#list-name").innerText()) === "Marché du samedi"));
  const all = [];
  const walk = dir => {
    for (const f of readdirSync(dir)) {
      const p = join(dir, f);
      try {
        if (statSync(p).isDirectory()) walk(p);
        else all.push(readFileSync(p));
      } catch (e) {
        if (e.code !== "ENOENT") throw e; // a database's temporary file, gone as it closed
      }
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

test("the list has a name, at the top, renamed with a tap", async () => {
  const t = await pair();
  const { a, b } = t;
  assert.equal(await a.locator("#list-name").innerText(), "Shopping list", "a new list has a name to start with");
  assert.equal(await a.title(), "Shopping list");
  const box = await a.locator("#list-name").boundingBox();
  assert.ok(box.height >= 44, "big enough to tap");
  const font = await a.locator("#list-name").evaluate(el => getComputedStyle(el).fontSize);
  assert.equal(font, "26px", "the size of a page title");

  await renameList(a, "Courses");
  assert.equal(await a.locator("#list-name").innerText(), "Courses");
  assert.ok(await eventually(async () => (await b.locator("#list-name").innerText()) === "Courses"), "both phones see the new name");
  assert.equal(await b.title(), "Courses");
  assert.equal(await a.getAttribute("#undo", "aria-label"), "Undo renaming the list “Shopping list”");

  await a.click("#list-name");
  await a.keyboard.press("Control+A");
  await a.keyboard.press("Backspace");
  await blur(a);
  assert.equal(await a.locator("#list-name").innerText(), "Courses", "an emptied name goes back to the old one");
  await a.click("#list-name");
  await a.keyboard.type(" du samedi");
  await a.keyboard.press("Escape");
  assert.equal(await a.locator("#list-name").innerText(), "Courses", "Escape cancels");

  await a.click("#undo");
  assert.ok(await eventually(async () => (await b.locator("#list-name").innerText()) === "Shopping list"), "undo brings the first name back");
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

test("dragging an item onto the drop zone, under the ticked group's heading, ticks it", async () => {
  const t = await pair();
  const { a, b } = t;
  for (const w of ["Milk", "Bread", "Eggs"]) await add(a, "ess", w);
  await blur(a);
  await sleep(300);
  assert.equal(await a.locator("#basket").isVisible(), false, "nothing is ticked yet");
  await dragTo(a, item(a, "Bread"), async () => {
    const z = await a.locator("#tick-drop").boundingBox();
    return z.y + z.height / 2;
  }, { hold: true });
  const head = await a.locator(".basket-head").boundingBox(), zone = await a.locator("#tick-drop").boundingBox();
  assert.ok(head && zone.y >= head.y + head.height, "during the drag, the heading shows with the zone under it");
  assert.equal(await a.locator(".ghost.done").count(), 1, "the item shows as ticked over the zone");
  assert.equal(await a.locator("#tick-drop.over").count(), 1);
  await a.mouse.up();
  assert.ok(await eventually(async () => (await ticked(a)).includes("Bread")));
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
  await still(a);
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
  assert.ok(await a.locator('.sec[data-sec="ess"] .add-x').isVisible(), "typing shows the cross");
  assert.ok(await a.locator('.sec[data-sec="ess"] .add-plus svg').isVisible(), "and the plus stays");
  await item(a, "Milk").locator(".boxcell").click();
  await sleep(500);
  assert.ok((await texts(a, "Essentials")).includes("Lemons"), "leaving adds the item");
  assert.ok(await item(a, "Milk").locator(".chk").isChecked(), "the tap that left the field still ticks Milk");
  assert.equal(await a.inputValue("#add-ess"), "");
  assert.ok(await eventually(async () => (await texts(b, "Essentials")).includes("Lemons")));

  await a.fill("#add-ess", "bread");
  await blur(a);
  await sleep(400);
  assert.deepEqual((await texts(a, "Essentials")).filter(x => x.toLowerCase() === "bread"), ["bread"], "a name bought before brings that item back, as typed");
  assert.ok(!(await ticked(a)).includes("Bread"), "rather than adding a copy");

  await a.fill("#add-look", "MILK");
  await blur(a);
  await sleep(400);
  const all = (await a.locator("#list .items .text").allInnerTexts()).map(x => x.toLowerCase());
  assert.equal(all.filter(x => x === "milk").length, 1, "a duplicate adds nothing");
  assert.equal(await a.inputValue("#add-look"), "");
  await t.close();
});

test("the plus adds a new item and the cross throws it away, with a finger; Escape too", async () => {
  const t = await pair(ENGINE === "firefox" ? { hasTouch: true } : { hasTouch: true, isMobile: true });
  const { a, b } = t;
  const x = a.locator('.sec[data-sec="ess"] .add-x');
  assert.equal(await x.isVisible(), false, "no cross before typing");
  await a.locator("#add-ess").tap();
  await a.keyboard.type("Bananas");
  assert.ok(await x.isVisible(), "a cross once something is typed");
  const row = await a.locator('.sec[data-sec="ess"] .add').boundingBox(), xb = await x.boundingBox();
  assert.ok(xb.height >= 44 && Math.abs(xb.x + xb.width - (row.x + row.width)) < 1, "at the end of the row, big enough to tap");
  await x.tap();
  assert.equal(await a.inputValue("#add-ess"), "", "the text goes");
  assert.equal(await a.evaluate(() => document.activeElement.id), "add-ess", "the cursor stays, for the next one");
  assert.equal(await x.isVisible(), false);

  await a.keyboard.type("Pears");
  await a.keyboard.press("Escape");
  assert.equal(await a.inputValue("#add-ess"), "", "Escape throws it away too");

  await a.keyboard.type("Apples");
  await a.locator('.sec[data-sec="ess"] .add-plus').tap();
  assert.ok(await eventually(async () => (await texts(a, "Essentials")).join() === "Apples"), "the plus adds it, like Enter");
  assert.equal(await a.evaluate(() => document.activeElement.id), "add-ess", "and the cursor stays for the next one");
  await a.keyboard.type("Pears");
  await a.keyboard.press("Escape");
  assert.equal(await a.inputValue("#add-ess"), "", "Escape throws it away too");
  await blur(a);
  await sleep(500);
  assert.deepEqual(await texts(a, "Essentials"), ["Apples"], "nothing else was added");
  await add(a, "ess", "Milk");
  assert.ok(await eventually(async () => (await texts(b, "Essentials")).join() === "Apples,Milk"), "the other phone only ever gets those two");

  await blur(a);
  await a.locator('.sec[data-sec="look"] .add-plus').tap();
  assert.equal(await a.evaluate(() => document.activeElement.id), "add-look", "with nothing typed, the plus opens the field");
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

test("Backspace at the start of an item joins it to the one above", async () => {
  const t = await pair();
  const { a, b } = t;
  const now = () => texts(a, "Essentials");
  const splitAt = async (text, n) => {
    await item(a, text).locator(".text").click();
    await a.keyboard.press("Home");
    for (let i = 0; i < n; i++) await a.keyboard.press("ArrowRight");
    await a.keyboard.press("Enter");
  };
  await add(a, "ess", "Milk eggs");
  await add(a, "ess", "Bread");
  await blur(a);

  await splitAt("Milk eggs", 5);
  assert.deepEqual(await now(), ["Milk", "eggs", "Bread"]);
  await a.keyboard.press("Backspace");
  assert.deepEqual(await now(), ["Milk eggs", "Bread"], "right after a split, Backspace undoes it");
  assert.deepEqual(await editing(a), { editing: true, text: "Milk eggs", at: 5 }, "the cursor is where the parts meet");
  await blur(a);
  assert.ok(await eventually(async () => (await texts(b, "Essentials")).join() === "Milk eggs,Bread"));

  await splitAt("Bread", 3);
  assert.deepEqual(await now(), ["Milk eggs", "Bre", "ad"]);
  await a.evaluate(() => document.activeElement.dispatchEvent(new InputEvent("beforeinput", { inputType: "deleteContentBackward", bubbles: true, cancelable: true })));
  assert.deepEqual(await now(), ["Milk eggs", "Bread"], "a word split in the middle joins without a space, also from a phone keyboard");
  await blur(a);

  await item(a, "Bread").locator(".text").click();
  await clearText(a);
  await a.keyboard.press("Backspace");
  assert.deepEqual(await now(), ["Milk eggs"], "Backspace in an emptied item deletes it");
  assert.deepEqual(await editing(a), { editing: true, text: "Milk eggs", at: 9 }, "and moves to the end of the one above");
  await a.keyboard.press("Home");
  await a.keyboard.press("Backspace");
  assert.deepEqual(await now(), ["Milk eggs"], "the first item has nothing to join");
  assert.equal((await editing(a)).editing, true);
  await blur(a);

  await a.click("#undo");
  assert.deepEqual(await now(), ["Milk eggs", "Bread"], "undo brings the deleted item back");
  await t.close();
});

test("a ticked item dragged into a section goes back on the list there", async () => {
  const t = await pair();
  const { a, b } = t;
  for (const w of ["Milk", "Bread", "Eggs"]) await add(a, "ess", w);
  await blur(a);
  await item(a, "Bread").locator(".boxcell").click();
  await sleep(1900);
  assert.deepEqual(await ticked(a), ["Bread"]);
  const bread = () => a.locator('#basket-list .item:has(.text:text-is("Bread"))');
  const belowMilk = async () => { const m = await item(a, "Milk").boundingBox(); return m.y + m.height - 4; };

  await dragTo(a, bread(), belowMilk, { hold: true });
  assert.equal(await a.locator(".ghost.done").count(), 0, "over a section, it shows unticked");
  assert.equal(await a.locator("#tick-drop").isVisible(), false, "no drop zone for an item already ticked");
  await a.mouse.up();
  assert.ok(await eventually(async () => (await texts(a, "Essentials")).join() === "Milk,Bread,Eggs"), "it lands where it was dropped");
  assert.equal(await item(a, "Bread").locator(".chk").isChecked(), false);
  assert.deepEqual(await ticked(a), []);
  assert.ok(await eventually(async () => (await texts(b, "Essentials")).join() === "Milk,Bread,Eggs"), "the other phone sees it");

  await a.click("#undo");
  assert.ok(await eventually(async () => (await ticked(a)).join() === "Bread"), "undo ticks it again");
  await still(a);
  const home = await bread().boundingBox();
  await dragTo(a, bread(), belowMilk, { hold: true });
  for (let i = 1; i <= 10; i++) { await a.mouse.move(home.x + 60, home.y + home.height / 2); await sleep(20); }
  await sleep(150);
  assert.equal(await a.locator(".ghost.done").count(), 1, "back over the ticked group, it shows ticked");
  await a.mouse.up();
  assert.ok(await eventually(async () => (await a.locator(".item.placeholder, .ghost, .flying").count()) === 0), "nothing is left behind once it lands");
  assert.deepEqual(await ticked(a), ["Bread"], "dropped there, it stays ticked");
  assert.deepEqual(await texts(a, "Essentials"), ["Milk", "Eggs"]);
  await t.close();
});

test("ticked items slide into the ticked group, and taps land meanwhile", async () => {
  const t = await pair();
  const { a } = t;
  for (const w of ["Milk", "Bread", "Eggs"]) await add(a, "ess", w);
  await blur(a);
  await still(a);
  await item(a, "Eggs").locator(".boxcell").click();
  const milk = await item(a, "Milk").locator(".boxcell").boundingBox();
  assert.ok(await eventually(async () => (await a.locator(".flying").count()) === 1, 3000), "Eggs flies to the ticked group");
  await a.mouse.click(milk.x + milk.width / 2, milk.y + milk.height / 2);
  assert.equal(await item(a, "Milk").locator(".chk").isChecked(), true, "a tap during the motion ticks Milk");
  assert.ok(await eventually(async () => (await a.locator(".flying").count()) === 0 && (await ticked(a)).join() === "Eggs"));
  assert.ok(await eventually(async () => (await ticked(a)).join() === "Milk,Eggs", 4000));
  assert.equal(await a.locator("#basket-toggle").innerText(), "2 ticked", "the group's heading says what it holds");
  await t.close();
});

test("a section's colour is chosen from a palette while renaming it", async () => {
  const t = await pair();
  const { a, b } = t;
  await add(a, "ess", "Milk");
  await blur(a);
  const ess = '.sec[data-sec="ess"]';
  const colour = (pg, sel) => pg.evaluate(s => document.querySelector(s).style.getPropertyValue("--sec"), sel);
  assert.equal(await a.locator(".sec-head svg").count(), 0, "sections have no icons");
  assert.equal(await a.locator(ess + " .palette").count(), 0, "the colours show only while renaming");

  await section(a, "Essentials").locator(".sec-name").click();
  assert.equal(await a.locator(ess + " .swatch").count(), 8);
  assert.equal(await a.getAttribute(ess + ' .swatch[aria-pressed="true"]', "aria-label"), "Green");
  await a.locator(ess + ' .swatch[aria-label="Plum"]').click();
  assert.equal(await colour(a, ess), "var(--plum)");
  assert.equal(await colour(a, ess + " .item"), "var(--plum)", "its tick boxes follow");
  assert.equal(await a.evaluate(() => document.activeElement.classList.contains("editing")), true, "the name is still being edited");
  assert.equal(await a.getAttribute(ess + ' .swatch[aria-pressed="true"]', "aria-label"), "Plum");
  await a.keyboard.press("Escape");
  assert.equal(await a.locator(ess + " .palette").count(), 0);
  assert.ok(await eventually(async () => (await colour(b, ess)) === "var(--plum)"), "the other phone sees the colour");

  await a.click("#undo");
  assert.equal(await colour(a, ess), "var(--ess)", "undo restores the colour");
  assert.ok(await eventually(async () => (await colour(b, ess)) === "var(--ess)"));
  await t.close();
});

test("a quantity at the start is shown apart and ignored when matching names", async () => {
  const t = await pair();
  const { a, b } = t;
  await add(a, "ess", "2 milk");
  await add(a, "ess", "500g flour");
  await blur(a);
  assert.deepEqual(await a.locator('.sec[data-sec="ess"] .items .qty').allInnerTexts(), ["2", "500g"], "quantities are shown apart");
  assert.deepEqual(await texts(a, "Essentials"), ["2 milk", "500g flour"]);

  await add(a, "look", "Milk");
  await blur(a);
  assert.deepEqual(await texts(a, "Look out for"), [], "Milk is the same item as 2 milk: nothing is added");
  await add(a, "ess", "3× milk");
  await blur(a);
  assert.ok(await eventually(async () => (await texts(a, "Essentials")).join() === "3× milk,500g flour"), "a quantity typed for an item on the list updates it");
  assert.ok(await eventually(async () => (await texts(b, "Essentials")).join() === "3× milk,500g flour"));

  await item(a, "3× milk").locator(".boxcell").click();
  await sleep(1900);
  await a.fill("#add-look", "2 mil");
  assert.deepEqual(await a.locator("#sug-look .t").allInnerTexts(), ["Milk"], "suggestions match the name, not the quantity, and show the name alone");
  await a.locator("#sug-look .sug-pick").first().click();
  assert.ok(await eventually(async () => (await texts(a, "Look out for")).join() === "2 milk"), "picked, it takes the quantity typed");

  await item(a, "2 milk").locator(".text").click();
  assert.equal((await editing(a)).text, "2 milk", "while editing, the text is plain");
  await a.keyboard.press("Escape");
  assert.equal(await item(a, "2 milk").locator(".qty").innerText(), "2", "and the quantity shows apart again after");
  await t.close();
});

test("Enter adds just what was typed; a suggestion comes back when tapped, without its old quantity", async () => {
  const t = await pair();
  const { a, b } = t;
  await add(a, "ess", "2 litres of milk");
  await add(a, "ess", "500 g flour");
  await add(a, "look", "2 kg de pommes");
  await blur(a);
  assert.deepEqual(await a.locator("#list .items .qty").allInnerTexts(), ["2 litres", "500 g", "2 kg"], "longer units count as quantities too, in French as well");
  for (const x of ["2 litres of milk", "500 g flour", "2 kg de pommes"]) await item(a, x).locator(".boxcell").click();
  await sleep(1900);
  assert.deepEqual(await ticked(a), ["2 kg de pommes", "500 g flour", "2 litres of milk"], "the ticked group still shows what was bought");

  await a.fill("#add-ess", "mil");
  assert.deepEqual(await a.locator("#sug-ess .t").allInnerTexts(), ["Milk"], "suggested by name alone");
  await a.press("#add-ess", "Enter");
  assert.ok(await eventually(async () => (await texts(a, "Essentials")).join() === "mil"), "Enter adds what was typed, not the suggestion");
  assert.deepEqual(await ticked(a), ["2 kg de pommes", "500 g flour", "2 litres of milk"]);

  await add(a, "ess", "Flour");
  assert.ok(await eventually(async () => (await texts(a, "Essentials")).join() === "mil,Flour"), "typed in full, it comes back as typed");
  assert.deepEqual(await ticked(a), ["2 kg de pommes", "2 litres of milk"], "the same item, not a copy");
  assert.equal(await a.getAttribute("#undo", "aria-label"), "Undo adding “Flour”");

  await a.fill("#add-look", "pom");
  assert.deepEqual(await a.locator("#sug-look .t").allInnerTexts(), ["Pommes"]);
  await a.locator("#sug-look .sug-pick").first().click();
  assert.ok(await eventually(async () => (await texts(a, "Look out for")).join() === "Pommes"), "tapped, it comes back without its old quantity");
  assert.ok(await eventually(async () => (await texts(b, "Look out for")).join() === "Pommes"));
  await t.close();
});

test("sections are reordered by dragging their names, folded meanwhile", async () => {
  const t = await pair();
  const { a, b } = t;
  await add(a, "ess", "Milk");
  await add(a, "ess", "Bread");
  await add(a, "long", "Bike lights");
  await blur(a);
  await still(a);
  const box = await section(a, "Long term").locator(".sec-name").boundingBox();
  const x = box.x + 20, y = box.y + box.height / 2;
  await a.mouse.move(x, y);
  await a.mouse.down();
  await a.mouse.move(x, y - 10);
  assert.equal(await a.evaluate(() => document.documentElement.classList.contains("sorting")), true);
  assert.equal(await a.locator('#list .sec[data-sec="ess"] .items').isVisible(), false, "sections fold to their headings");
  const top = await section(a, "Essentials").boundingBox();
  for (let i = 1; i <= 10; i++) { await a.mouse.move(x, y - 10 + (top.y + 4 - (y - 10)) * i / 10); await sleep(20); }
  await sleep(100);
  await a.mouse.up();
  assert.deepEqual(await names(a), ["Long term", "Essentials", "Look out for"]);
  assert.equal(await a.locator('#list .sec[data-sec="ess"] .items').isVisible(), true, "and unfold when let go");
  assert.equal(await a.locator(".sec-name.editing").count(), 0, "letting go doesn't start renaming");
  assert.ok(await eventually(async () => (await names(b)).join() === "Long term,Essentials,Look out for"), "the other phone sees the new order");
  assert.ok(await eventually(async () => (await a.locator(".ghost").count()) === 0), "nothing is left behind");

  await a.click("#undo");
  assert.deepEqual(await names(a), ["Essentials", "Look out for", "Long term"], "undo puts it back");
  await section(a, "Essentials").locator(".sec-name").focus();
  await a.keyboard.press("Alt+ArrowDown");
  assert.deepEqual(await names(a), ["Look out for", "Essentials", "Long term"], "Alt+↓ moves a section down");
  assert.equal(await a.evaluate(() => document.activeElement.textContent), "Essentials", "keeping the focus on its name");
  await t.close();
});

test("settings: appearance, keeping the list, its size, export, and about", async () => {
  const t = await pair();
  const { a } = t;
  await add(a, "ess", "Milk");
  await add(a, "ess", "2 eggs");
  await add(a, "look", "Ripe avocados");
  await blur(a);
  await item(a, "Milk").locator(".boxcell").click();
  await sleep(1900);
  await a.click("#settings-open");
  assert.ok(await a.locator("#settings").isVisible());

  const bg = () => a.evaluate(() => getComputedStyle(document.body).backgroundColor);
  assert.equal(await bg(), "rgb(244, 245, 243)", "light, like this phone");
  await a.locator('#settings .choices label', { hasText: "Dark" }).click();
  assert.equal(await a.evaluate(() => document.documentElement.dataset.theme), "dark");
  assert.equal(await bg(), "rgb(17, 21, 19)", "dark colours when Dark is chosen");
  assert.equal(await a.getAttribute('meta[name="theme-color"][media*="light"]', "content"), "#111513", "the browser's bars follow");
  await a.reload();
  await a.locator("#app").waitFor();
  assert.equal(await a.evaluate(() => document.documentElement.dataset.theme), "dark", "the choice is kept on this phone");
  await a.click("#settings-open");
  assert.ok(await a.locator('input[name="theme"][value="dark"]').isChecked());

  assert.match(await a.locator("#size-text").innerText(), /2 items to get, 1 bought before/);
  assert.ok(await eventually(async () => /browser/.test(await a.locator("#keep-text").innerText())));
  const [dl] = await Promise.all([a.waitForEvent("download"), a.click("#export-btn")]);
  assert.match(dl.suggestedFilename(), /^shopping-list-\d{4}-\d{2}-\d{2}\.txt$/, "named after the list");
  const text = readFileSync(await dl.path(), "utf8");
  assert.match(text, /^Shopping list, /);
  assert.match(text, /\nEssentials\n- \[ \] 2 eggs\n/);
  assert.match(text, /\nLook out for\n- \[ \] Ripe avocados\n/);
  assert.match(text, /\nBought before\n- \[x\] Milk\n/);

  assert.equal(await a.locator("#about-server").innerText(), new URL(BASE).host);
  assert.ok(await eventually(async () => (await a.locator("#about-version").innerText()) !== ""));

  await a.locator('#settings .choices label', { hasText: "Same as phone" }).click();
  assert.equal(await a.evaluate(() => document.documentElement.dataset.theme), undefined);
  await a.evaluate(() => history.back()); // the phone's back gesture
  assert.ok(await eventually(async () => !(await a.locator("#settings").isVisible())), "going back closes Settings");
  assert.ok(await a.locator("#app").isVisible(), "and stays in the app");
  await t.close();
});

test("in French when the phone is in French", async () => {
  const t = await pair({ locale: "fr-FR" });
  const { a, b, A } = t;
  const nb = " ";
  assert.equal(await a.evaluate(() => document.documentElement.lang), "fr");
  assert.deepEqual(await names(a), ["Essentiels", "À l’occasion", "À long terme"]);
  assert.equal(await a.locator("#list-name").innerText(), "Liste de courses");
  assert.equal(await a.getAttribute("#add-ess", "placeholder"), "Ajouter un article");
  assert.equal(await a.getAttribute("#add-sec", "placeholder"), "Ajouter une section");
  await add(a, "ess", "2 lait");
  await blur(a);
  assert.equal(await a.getAttribute("#undo", "aria-label"), `Annuler${nb}: ajouter «${nb}2 lait${nb}»`);

  await a.click("#settings-open");
  assert.equal(await a.locator("#settings-title").innerText(), "Paramètres");
  assert.equal(await a.locator("#size-text").evaluate(el => el.textContent.split(":").pop().trim()), "1 article à acheter, 0 déjà acheté", "French counts 0 as one");
  await a.click("#settings-close");

  assert.ok(await eventually(async () => (await texts(b, "Essentiels")).join() === "2 lait"), "sent before going offline");
  await offline(A, a);
  await add(a, "ess", "Pain");
  await blur(a);
  assert.ok(await eventually(async () => (await a.locator("#status-text").innerText()) === "Hors ligne", 5000));
  await a.click("#status-pill");
  assert.match(await a.locator("#status-detail").innerText(), /1 modification est enregistrée sur ce téléphone, à envoyer dès votre retour en ligne/);

  const shown = await a.evaluate(() => document.body.innerText + " " + [...document.querySelectorAll("[aria-label], [placeholder], [title]")]
    .map(e => ["aria-label", "placeholder", "title"].map(k => e.getAttribute(k) || "").join(" ")).join(" "));
  for (const en of ["Add item", "Add a section", "Settings", "Essentials", "Add someone", " ticked", "Undo", "Close", "Offline", "Edit "]) {
    assert.ok(!shown.includes(en), "“" + en + "” is in French");
  }
  await online(A, a);
  await t.close();
});

const stored = pg => pg.evaluate(() => JSON.parse(localStorage.getItem("panier")));

test("the stored list names each phone once and forgets items deleted over six months ago", async () => {
  const t = await pair();
  let { a } = t;
  await add(a, "ess", "Milk");
  await blur(a);
  assert.ok(await eventually(async () => Object.values((await stored(a)).items).some(f => f.text && f.text[0] === "Milk")), "saved shortly after");
  const st = await stored(a);
  const milk = Object.values(st.items).find(f => f.text && f.text[0] === "Milk");
  assert.equal(typeof milk.text[2], "number", "each field names its phone by number");
  assert.equal(st.devs[milk.text[2]], st.dev);

  // A list as an earlier version stored it, with an item deleted seven months ago and one a
  // month ago, written while the app isn't running, as it would be after an update.
  await a.close();
  a = await t.A.newPage();
  watch(a, t.errors);
  await a.goto(BASE + "/api/lists"); // a plain answer from the server: the app isn't running
  await a.evaluate(() => {
    const s = JSON.parse(localStorage.getItem("panier"));
    for (const f of Object.values(s.items)) for (const v of Object.values(f)) v[2] = s.devs[v[2]];
    delete s.devs;
    const day = 864e5, gone = (text, ago) => {
      const at = Date.now() - ago;
      return { text: [text, at, s.dev], section: ["ess", at, s.dev], pos: [9, at, s.dev], checked: [false, at, s.dev], checkedAt: [0, at, s.dev], deleted: [true, at, s.dev] };
    };
    s.items.oldGone = gone("Old", 210 * day);
    s.items.newGone = gone("Recent", 30 * day);
    localStorage.setItem("panier", JSON.stringify(s));
  });
  await a.goto(BASE + "/");
  await a.locator("#app").waitFor();
  assert.deepEqual(await texts(a, "Essentials"), ["Milk"], "a list stored by the earlier version opens as before");
  await add(a, "ess", "Bread");
  await blur(a);
  assert.ok(await eventually(async () => Array.isArray((await stored(a)).devs)));
  const now = await stored(a);
  assert.equal(now.items.oldGone, undefined, "deleted seven months ago: forgotten");
  assert.ok(now.items.newGone, "deleted a month ago: kept");
  await t.close();
});

test("a phone doesn't download its own changes again", async () => {
  const t = await pair();
  const { a, b } = t;
  await add(a, "ess", "Milk");
  await blur(a);
  assert.ok(await eventually(async () => (await texts(b, "Essentials")).join() === "Milk"));
  await sleep(500);
  const fetched = [];
  a.on("request", r => { if (r.method() === "GET" && r.url().includes("/changes")) fetched.push(r.url()); });
  await item(a, "Milk").locator(".boxcell").click();
  await add(a, "look", "Ripe avocados");
  await blur(a);
  assert.ok(await eventually(async () => (await texts(b, "Look out for")).join() === "Ripe avocados"), "the changes reach the other phone");
  await sleep(800);
  assert.deepEqual(fetched, [], "the sending phone doesn't fetch them back");
  await add(b, "long", "Bike lights");
  await blur(b);
  assert.ok(await eventually(async () => (await texts(a, "Long term")).join() === "Bike lights"), "but still gets the other phone's");
  await t.close();
});
