// Browser tests: two simulated phones using the app against a running server, Go or
// Cloudflare Worker.
//
//   BASE=http://127.0.0.1:8080 SETUP=ABCD-EFGH-JKMN STORE=./data node --test test/browser.test.mjs
//
// STORE, optional, is the server's data directory; the tests then check that no item
// name was ever written to it. BROWSER picks Playwright's chromium (the default) or
// firefox. LAYOUT=compact runs every test in the compact layout, as chosen in Settings;
// the test of Settings itself then stands aside.

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

const LAYOUT = process.env.LAYOUT || "";
async function phone(errors, options = {}) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, ...options });
  if (LAYOUT) await ctx.addInitScript(l => { try { localStorage.setItem("panier-layout", l); } catch (_) {} }, LAYOUT);
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

// What a phone stores: its index of lists, and the list on screen, or last on screen.
const index = pg => pg.evaluate(() => JSON.parse(localStorage.getItem("panier2")));
const stored = pg => pg.evaluate(() => JSON.parse(localStorage.getItem("panier2:" + JSON.parse(localStorage.getItem("panier2")).open)));
const openKey = pg => pg.evaluate(() => { const ix = JSON.parse(localStorage.getItem("panier2")); return ix.lists.find(e => e.lid === ix.open).key; });

// Two phones sharing a new list: A creates it, B joins with the pairing link.
async function pair(options) {
  const errors = [];
  const A = await phone(errors, options), B = await phone(errors, options);
  await A.page.goto(BASE + "/#setup=" + SETUP.toLowerCase());
  await A.page.locator("#pair").waitFor();
  await A.page.click("#pair-close");
  const key = await openKey(A.page);
  await B.page.goto(BASE + "/#k=" + key);
  await B.page.locator("#app").waitFor();
  // Each phone writes itself onto the list as it joins: sent before a test begins.
  for (const pg of [A.page, B.page]) assert.ok(await eventually(() => pg.evaluate(async () => (await import("/store.js")).status().waiting === 0)), "joined");
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
// Ticked rows off screen aren't laid out (see app.css), so their text is read as written.
const ticked = async pg => (await pg.locator("#basket-list .text").allTextContents()).map(x => x.trim());
// An item by its whole text, including a quantity shown apart from the name.
const exactly = text => new RegExp("^\\s*" + text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s*$");
const item = (pg, text) => pg.locator("#list .item").filter({ has: pg.locator(".text", { hasText: exactly(text) }) });
const blur = pg => pg.evaluate(() => document.activeElement.blur());
// A colour as the screen shows it, [r, g, b], whatever notation the browser keeps it in;
// the page's paper; and a colour as the browser's bars are given it.
const shown = (pg, css) => pg.evaluate(css => { const c = document.createElement("canvas").getContext("2d"); c.fillStyle = css; c.fillRect(0, 0, 1, 1); return [...c.getImageData(0, 0, 1, 1).data].slice(0, 3); }, css);
const paperOf = async pg => shown(pg, await pg.evaluate(() => getComputedStyle(document.body).backgroundColor));
const rgbText = c => `rgb(${c.join(",")})`;
const spread = c => Math.max(...c) - Math.min(...c); // how coloured, rather than grey
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

test("a link opened in a tab where the app is already open is followed", async () => {
  const errors = [];
  const { ctx, page: a } = await phone(errors);
  await a.goto(BASE + "/");
  await a.locator("#lists").waitFor();
  assert.ok(await a.locator("#setup-form").isVisible(), "the first time, the lists page asks for the setup code");
  await a.evaluate(c => { location.hash = "setup=" + c.toLowerCase(); }, SETUP); // pasted into the address bar
  await a.locator("#pair").waitFor();
  assert.ok(await a.locator("#app").isVisible(), "a setup link starts the list");
  await a.click("#pair-close");
  await ctx.close();
  assert.deepEqual(errors, []);
});

test("a link to another list adds it beside this one, and keeps what this one hasn't sent", async () => {
  const t = await pair();
  const { a, A } = t;
  await add(a, "ess", "Milk");
  await blur(a);
  const other = await browser.newContext(), o = await other.newPage();
  await o.goto(BASE + "/#setup=" + SETUP.toLowerCase());
  await o.locator("#pair").waitFor();
  await o.click("#pair-close");
  await add(o, "ess", "Garden hose");
  await blur(o);
  assert.ok(await eventually(async () => { const st = await stored(o); return st && !st.outbox.length && Object.values(st.items).some(f => f.text && f.text[0] === "Garden hose"); }), "sent before that phone closes");
  const key2 = await openKey(o);
  await other.close();

  await a.goto("about:blank");
  await a.goto(BASE + "/#k=" + t.key);
  await a.locator("#app").waitFor();
  assert.equal((await index(a)).lists.length, 1, "its own link opens the list, and adds nothing");

  await offline(A, a);
  await add(a, "ess", "Bread");
  await blur(a);
  await a.goto("about:blank"); // a link opened from another app loads the page afresh
  await a.goto(BASE + "/#k=" + key2);
  await a.locator("#app").waitFor();
  await online(A, a);
  assert.ok(await eventually(async () => (await texts(a, "Essentials")).join() === "Garden hose", 10000), "the other list opens");
  assert.equal(await openKey(a), key2);
  assert.equal((await index(a)).lists.length, 2, "beside the first");
  await a.click("#lists-open");
  await a.locator("#lists").waitFor();
  assert.ok(await eventually(async () => (await a.locator(".sheet-name").allInnerTexts()).length === 2));
  await a.locator(".sheet-open").first().click();
  assert.ok(await eventually(async () => (await texts(a, "Essentials")).join() === "Milk,Bread", 10000), "and the first still has what it hadn't sent");
  assert.ok(await eventually(async () => (await texts(t.b, "Essentials")).join() === "Milk,Bread", 10000), "which it now sends");
  await t.close();
});

test("an added item, a tick and a put-back each fit in one 256-byte block", async () => {
  const t = await pair();
  const { a, A } = t;
  await offline(A, a);
  await add(a, "ess", "Wholemeal bread");
  await item(a, "Wholemeal bread").locator(".boxcell").click();
  await sleep(1900);
  await add(a, "ess", "Wholemeal bread");
  await blur(a);
  assert.ok(await eventually(async () => (await stored(a)).outbox.length === 3));
  const sizes = (await stored(a)).outbox.map(c => new TextEncoder().encode(JSON.stringify(c)).length);
  assert.ok(sizes.every(n => n < 256), "sizes: " + sizes.join(", "));
  assert.deepEqual(await texts(a, "Essentials"), ["Wholemeal bread"]);
  await online(A, a);
  await a.click("#undo");
  assert.deepEqual(await ticked(a), ["Wholemeal bread"], "undoing the put-back ticks it again");
  await a.click("#undo");
  await a.click("#undo");
  assert.ok(await eventually(async () => (await texts(a, "Essentials")).length === 0 && (await ticked(a)).length === 0), "and undoing the add removes it");
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
  assert.match(await a.locator("#live").innerText(), /Nothing to undo: someone else already changed it/);
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

  await a.fill("#add-sec", "Drinks");
  await a.click("#add-sec-form .add-plus");
  assert.ok((await names(a)).includes("Drinks"), "the plus adds a section, like Enter");
  assert.equal(await a.evaluate(() => document.activeElement.getAttribute("aria-label")), "Add item to Drinks", "and moves the cursor to it");
  await a.click("#add-sec");
  await a.keyboard.type("Oops");
  await a.click("#add-sec-form .add-x");
  assert.equal(await a.inputValue("#add-sec"), "", "the cross clears a section name being typed");
  assert.equal(await a.evaluate(() => document.activeElement.id), "add-sec", "keeping the cursor there");
  assert.ok(!(await names(a)).includes("Oops"));

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
  assert.equal(font, LAYOUT === "compact" ? "20px" : "26px", "the size of a page title");

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

test("the list's colour, chosen under its name, tints the paper on both phones", async () => {
  const t = await pair();
  const { a, b } = t;
  await add(a, "ess", "Milk");
  await blur(a);
  const page = async pg => [await pg.evaluate(() => document.documentElement.dataset.list || "white"), await paperOf(pg)];
  const [first, plain] = await page(a);
  assert.equal(first, "white", "white to start with");
  assert.ok(Math.min(...plain) > 240 && spread(plain) < 10, "plain paper, barely warm: " + plain);
  await a.click("#list-name");
  const swatches = a.locator(".list-top + .palette .swatch");
  assert.deepEqual(await swatches.evaluateAll(s => s.map(x => x.getAttribute("aria-label"))), ["White", "Green", "Teal", "Blue", "Indigo", "Plum", "Rose", "Amber", "Olive"], "white, then the section colours but ink");
  assert.equal(await swatches.first().getAttribute("aria-pressed"), "true");
  await swatches.nth(2).click();
  const [list, bg] = await page(a);
  assert.equal(list, "teal");
  assert.ok(spread(bg) > 10 && bg[2] > bg[0], "the paper is dyed with it at once: " + bg);
  assert.equal(await a.locator(".list-name.editing").count(), 1, "while the name stays in editing");
  assert.equal(await a.getAttribute('meta[name="theme-color"]', "content"), rgbText(bg), "the browser's bars take the paper's colour");
  await a.keyboard.press("Enter");
  assert.ok(await eventually(async () => (await page(b))[0] === "teal"), "the other phone's paper too");
  assert.equal(await a.getAttribute("#undo", "aria-label"), "Undo changing the colour of “Shopping list”");
  await a.click("#undo");
  assert.ok(await eventually(async () => (await page(b))[0] === "white"), "undo brings white back, on both phones");
  await a.click("#redo");
  assert.ok(await eventually(async () => (await page(b))[0] === "teal"));

  // Opening the app again, the paper is tinted before anything is drawn.
  await t.A.addInitScript(() => document.addEventListener("DOMContentLoaded", () => { window.firstList = document.documentElement.dataset.list; }));
  await a.reload();
  await a.locator("#app").waitFor();
  assert.equal(await a.evaluate(() => window.firstList), "teal");
  await a.click("#lists-open");
  await a.fill("#new-list", "Market");
  await a.press("#new-list", "Enter");
  await a.locator("#app").waitFor();
  await a.reload();
  await a.locator("#app").waitFor();
  assert.equal(await a.evaluate(() => window.firstList), undefined, "a white list opened after a coloured one starts white");
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

test("items hold 120 characters, three lines on a phone", async () => {
  const t = await pair();
  const long = "Organic free-range eggs from the market stall near the church, the brown ones in the cardboard box of twelve, not the six-pack";
  await add(t.a, "ess", long + " and more");
  const text = item(t.a, long.slice(0, 120).trim()).locator(".text");
  assert.equal((await text.innerText()).length, 120);
  const lines = await text.evaluate(el => { const c = getComputedStyle(el); return Math.round((el.getBoundingClientRect().height - parseFloat(c.paddingTop) - parseFloat(c.paddingBottom)) / parseFloat(c.lineHeight)); });
  assert.equal(lines, 3, "three lines at most");
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

test("tapping an item to edit it while typing a new one shows the new one at once, and the tapped item stays put", async () => {
  const t = await pair();
  const { a } = t;
  await add(a, "ess", "Milk");
  await add(a, "look", "Ripe avocados");
  for (const w of ["Bike lights", "Picture frame", "Doormat", "Light bulbs", "Batteries", "Hose", "Paint", "Rope"]) await add(a, "long", w);
  await blur(a);
  await still(a);
  await a.fill("#add-ess", "Lemons"); // a page longer than the screen, so it can scroll to keep things in place
  const avocados = section(a, "Look out for").locator(".items .text");
  const was = (await avocados.boundingBox()).y;
  await avocados.click();
  assert.ok(await eventually(async () => (await texts(a, "Essentials")).join() === "Milk,Lemons", 1000), "Lemons shows right away");
  assert.equal(await a.locator(".text.editing").innerText(), "Ripe avocados", "while Ripe avocados is being edited");
  assert.ok(Math.abs((await avocados.boundingBox()).y - was) < 1, "which stays where it was tapped, though Lemons landed above it");
  await a.keyboard.press("End");
  await a.keyboard.type(" (soft)");
  await a.keyboard.press("Enter");
  assert.deepEqual(await texts(a, "Look out for"), ["Ripe avocados (soft)"], "and the edit carries on as usual");
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
  assert.ok((await a.locator("#add-ess").boundingBox()).width > 200, "and the field keeps its width");
  const end = await a.locator('.sec[data-sec="ess"] .add').evaluate(el => el.getBoundingClientRect().right - parseFloat(getComputedStyle(el).paddingRight)), xb = await x.boundingBox();
  assert.ok(xb.height >= 44 && Math.abs(xb.x + xb.width - end) < 1, "at the end of the row, big enough to tap");
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
  assert.match(await a.evaluate(() => localStorage.getItem("panier2-drafts:" + JSON.parse(localStorage.getItem("panier2")).open)), /Coffee filters/, "kept for this list");
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

  await a.fill("#add-ess", "m");
  assert.equal(await a.locator("#sug-ess").isHidden(), true, "one letter suggests nothing");
  await a.fill("#add-ess", "mi");
  assert.deepEqual(await a.locator("#sug-ess .t").allInnerTexts(), ["Mild cheese", "Milk"], "two letters do");
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

test("a tick redraws only that item, which keeps the cursor all the way to the ticked group and back", async () => {
  const t = await pair();
  const { a } = t;
  for (const w of ["Milk", "Bread"]) await add(a, "ess", w);
  await blur(a);
  await still(a);
  // Each row is marked, to tell whether it's still the same one afterwards.
  await a.evaluate(() => document.querySelectorAll("#list .item").forEach(li => { li.mark = li.textContent; }));
  const marks = () => a.evaluate(() => [...document.querySelectorAll("#list .item, #basket-list .item")].map(li => li.mark || "new"));
  const cursor = () => a.evaluate(() => { const li = document.activeElement.closest(".item"); return li && li.mark + (li.closest("#basket-list") ? ", ticked" : ""); });
  await item(a, "Milk").locator(".chk").focus();
  await a.keyboard.press("Space");
  assert.deepEqual(await marks(), ["Milk", "Bread"], "ticked, Milk stays put for a moment, and no row is redrawn");
  assert.equal(await cursor(), "Milk", "the cursor stays on Milk");
  assert.ok(await eventually(async () => (await ticked(a)).join() === "Milk"));
  await still(a);
  assert.equal(await a.locator(".flying").count(), 0, "the copy that flew is gone");
  assert.deepEqual(await marks(), ["Bread", "Milk"], "Milk's own row moved to the ticked group");
  assert.equal(await cursor(), "Milk, ticked", "and took the cursor with it");
  await a.keyboard.press("Space");
  assert.ok(await eventually(async () => (await texts(a, "Essentials")).join() === "Bread,Milk"));
  await still(a);
  assert.deepEqual(await marks(), ["Bread", "Milk"], "unticked, it comes back, still the same row");
  assert.equal(await cursor(), "Milk", "with the cursor");
  await t.close();
});

test("opening the app, or coming back to it, with nothing new writes nothing", async () => {
  const t = await pair();
  const { a, b } = t;
  await add(a, "ess", "Milk");
  await blur(a);
  assert.ok(await eventually(async () => (await texts(b, "Essentials")).join() === "Milk"));
  await sleep(800); // sent, and saved
  await t.A.addInitScript(() => {
    window.writes = 0;
    const set = Storage.prototype.setItem;
    Storage.prototype.setItem = function (k, v) { if (k.startsWith("panier2")) window.writes++; return set.call(this, k, v); };
  });
  const caughtUp = () => a.waitForResponse(r => r.url().includes("/changes?since="));
  let pulled = caughtUp();
  await a.reload();
  await pulled;
  await sleep(800);
  assert.equal(await a.evaluate(() => window.writes), 0, "opened: it checked for news, found none, wrote nothing");
  pulled = caughtUp();
  await a.evaluate(() => document.dispatchEvent(new Event("visibilitychange"))); // back from another app
  await pulled;
  await sleep(800);
  assert.equal(await a.evaluate(() => window.writes), 0, "the same when coming back to it");
  await add(b, "ess", "Bread");
  await blur(b);
  assert.ok(await eventually(async () => (await texts(a, "Essentials")).join() === "Milk,Bread"));
  assert.ok(await eventually(() => a.evaluate(() => window.writes > 0)), "news is written down");
  await t.close();
});

test("out of sight, the app stops listening; back on screen, it catches up and listens again", async () => {
  const t = await pair();
  const { a, b } = t;
  await add(b, "ess", "Milk");
  await blur(b);
  assert.ok(await eventually(async () => (await texts(a, "Essentials")).join() === "Milk"), "live while on screen");
  const sockets = [];
  a.on("websocket", ws => sockets.push(ws));
  const show = visible => a.evaluate(v => {
    Object.defineProperty(document, "hidden", { configurable: true, get: () => !v });
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => (v ? "visible" : "hidden") });
    document.dispatchEvent(new Event("visibilitychange"));
  }, visible);
  await show(false); // another app, or the screen locked
  await add(b, "ess", "Bread");
  await blur(b);
  await sleep(2500);
  assert.deepEqual(await texts(a, "Essentials"), ["Milk"], "nothing comes in while it's put away");
  assert.equal(sockets.length, 0, "nor does it reconnect");
  await show(true);
  assert.ok(await eventually(async () => (await texts(a, "Essentials")).join() === "Milk,Bread", 3000), "back, it catches up");
  assert.ok(await eventually(async () => sockets.length === 1), "and listens again");
  await add(b, "ess", "Eggs");
  await blur(b);
  assert.ok(await eventually(async () => (await texts(a, "Essentials")).join() === "Milk,Bread,Eggs"), "live again");
  assert.equal(await a.locator("#status").isHidden(), true, "never said to be offline");
  await t.close();
});

test("a ticked item travels at the same pace however long the list, and only as far as the screen", async () => {
  const t = await pair();
  const { a } = t;
  // The trip of the item now flying to the ticked group: its length, duration and end.
  const trip = async () => {
    assert.ok(await eventually(() => a.evaluate(() => document.getAnimations().some(x => x.id === "fly")), 4000));
    const r = await a.evaluate(() => {
      const x = document.getAnimations().find(x => x.id === "fly");
      const [, dx, dy] = /translate\((-?[\d.]+)px, (-?[\d.]+)px\)/.exec(x.effect.getKeyframes()[1].transform);
      return { ms: x.effect.getTiming().duration, d: Math.hypot(+dx, +dy), end: parseFloat(x.effect.target.style.top) + +dy, screen: innerHeight, easing: x.effect.getTiming().easing };
    });
    assert.ok(await eventually(() => a.evaluate(() => !document.getAnimations().some(x => x.id === "fly")), 4000));
    return r;
  };
  for (const x of ["Milk", "Bread", "Eggs", "Butter"]) await add(a, "ess", x);
  await blur(a);
  await still(a);
  await item(a, "Milk").locator(".boxcell").click();
  const short = await trip();
  for (let i = 1; i <= 20; i++) await add(a, "long", "Thing " + i);
  await blur(a);
  await a.evaluate(() => scrollTo(0, 0));
  await still(a);
  await item(a, "Bread").locator(".boxcell").click();
  const long = await trip();
  assert.ok(long.end <= long.screen + 8, "in a long list, it goes no further than the screen's edge");
  assert.equal(long.easing, "cubic-bezier(0.4, 0, 1, 1)", "and leaves the screen without slowing down");
  assert.equal(short.easing, "cubic-bezier(0.4, 0, 0.2, 1)", "while one landing on screen slows into place");
  assert.ok(Math.abs(long.d / long.ms - short.d / short.ms) < 0.05, `the same pace: ${(short.d / short.ms).toFixed(2)} and ${(long.d / long.ms).toFixed(2)} px/ms`);
  await t.close();
});

test("an item on the move stays in line with the list", async () => {
  const t = await pair();
  const { a } = t;
  for (const x of ["Milk", "Bread"]) await add(a, "ess", x);
  await blur(a);
  await still(a);
  const left = sel => a.evaluate(s => document.querySelector(s).getBoundingClientRect().left, sel);
  const near = (x, y, msg) => assert.ok(Math.abs(x - y) < 3, `${msg}: ${x.toFixed(1)} and ${y.toFixed(1)}`); // a 12 px shift was the trouble
  const at = await item(a, "Milk").locator(".text").evaluate(e => e.getBoundingClientRect().left);
  await item(a, "Milk").locator(".boxcell").click();
  await a.waitForSelector(".flying");
  near(await left(".flying .text"), at, "a ticked item flies in line");
  await still(a);
  await dragTo(a, item(a, "Bread"), async () => (await a.locator("#list .item").first().boundingBox()).y, { hold: true });
  near(await left(".ghost .text"), at, "so does a dragged one");
  await a.mouse.up();
  await still(a);
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
  assert.equal(await a.locator(ess + " .swatch").count(), 9, "ink and eight hues");
  assert.equal(await a.getAttribute(ess + ' .swatch[aria-pressed="true"]', "aria-label"), "Ink");
  const tops = await a.locator(ess + " .swatch").evaluateAll(els => new Set(els.map(e => Math.round(e.getBoundingClientRect().top))).size);
  assert.equal(tops, 1, "on one row");
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

test("a section let go stays where it was dropped, and unfolds from there", async () => {
  const t = await pair();
  const { a } = t;
  for (const w of ["Milk", "Bread", "Eggs", "Butter", "Coffee"]) await add(a, "ess", w);
  for (const w of ["Ripe avocados", "Strawberries", "Asparagus", "Figs", "Mangoes", "Chestnuts"]) await add(a, "look", w);
  for (const w of ["Bike lights", "Picture frame", "Doormat", "Light bulbs"]) await add(a, "long", w);
  await blur(a);
  await still(a);
  const name = () => section(a, "Long term").locator(".sec-name");
  await a.evaluate(() => scrollBy(0, 400));
  const box = await name().boundingBox();
  const x = box.x + 20, y = box.y + box.height / 2;
  await a.mouse.move(x, y);
  await a.mouse.down();
  await a.mouse.move(x, y - 10);
  const ess = await section(a, "Essentials").boundingBox(); // folded
  const to = ess.y + ess.height + 8; // just under Essentials
  for (let i = 1; i <= 10; i++) { await a.mouse.move(x, y - 10 + (to - (y - 10)) * i / 10); await sleep(20); }
  await sleep(150);
  const dropped = (await a.locator(".sec.ghost").boundingBox()).y;
  await a.mouse.up();
  assert.deepEqual(await names(a), ["Essentials", "Long term", "Look out for"]);
  const at = async () => (await section(a, "Long term").boundingBox()).y;
  assert.ok(Math.abs((await at()) - dropped) < 2, "it stays where it was let go, though Essentials unfolds above it");
  await still(a);
  assert.ok(Math.abs((await at()) - dropped) < 2, "and is still there once everything has unfolded");
  assert.ok(await eventually(async () => (await a.locator(".ghost").count()) === 0));
  await t.close();
});

test("settings: appearance, keeping the list, its size, export, and about", { skip: !!LAYOUT }, async () => {
  const t = await pair();
  const { a } = t;
  await add(a, "ess", "Milk");
  await add(a, "ess", "2 eggs");
  await add(a, "look", "Ripe avocados");
  await blur(a);
  await item(a, "Milk").locator(".boxcell").click();
  await sleep(1900);
  const [dl] = await Promise.all([a.waitForEvent("download"), a.click("#export-btn")]);
  assert.match(dl.suggestedFilename(), /^shopping-list-\d{4}-\d{2}-\d{2}\.md$/, "the list exports from its foot, named after it");
  assert.equal(readFileSync(await dl.path(), "utf8"), [
    "# Shopping list", "", "## Essentials <!-- ink -->", "- [ ] 2 eggs", "- [x] Milk", "", "## Look out for <!-- amber -->", "- [ ] Ripe avocados", "", "## Long term <!-- indigo -->", "",
  ].join("\n"));
  assert.equal(await a.locator("#settings-open").isVisible(), false, "Settings is on the lists page only");
  await a.click("#lists-open");
  await a.click("#settings-open");
  assert.ok(await a.locator("#settings").isVisible());

  const desk = await paperOf(a);
  assert.ok(Math.min(...desk) > 200 && Math.max(...desk) < 240, "the lists page's desk, a light warm grey, in this phone's light theme: " + desk);
  await a.locator('#settings .choices label', { hasText: "Dark" }).click();
  assert.equal(await a.evaluate(() => document.documentElement.dataset.theme), "dark");
  const night = await paperOf(a);
  assert.ok(Math.max(...night) < 30, "dark colours when Dark is chosen: " + night);
  assert.equal(await a.getAttribute('meta[name="theme-color"][media*="light"]', "content"), rgbText(night), "the browser's bars follow");
  await a.click("#settings-close");
  await a.locator(".sheet-open").first().click();
  await a.locator("#app").waitFor();
  const dark = await paperOf(a);
  assert.ok(Math.max(...dark) < 45 && dark.join() !== night.join(), "and the list is dark paper, lighter than the desk: " + dark);
  await a.reload();
  await a.locator("#app").waitFor();
  assert.equal(await a.evaluate(() => document.documentElement.dataset.theme), "dark", "the choice is kept on this phone");
  await a.click("#lists-open");
  await a.click("#settings-open");
  assert.ok(await a.locator('input[name="theme"][value="dark"]').isChecked());

  const sheet = () => a.evaluate(() => Math.round(document.querySelector(".sheet-open").getBoundingClientRect().height));
  const roomy = await sheet();
  await a.locator("#settings .switch").click();
  assert.ok(await sheet() < roomy - 40, "the compact layout: each list in one line");
  await a.click("#settings-close");
  await a.locator(".sheet-open").first().click();
  const row = () => a.evaluate(() => Math.round(document.querySelector("#list .item").getBoundingClientRect().height));
  assert.equal(await row(), 44, "and rows of 44 px");
  await a.reload();
  await a.locator("#app").waitFor();
  assert.equal(await row(), 44, "kept on this phone");
  await a.click("#lists-open");
  await a.click("#settings-open");
  assert.ok(await a.locator("#compact-layout").isChecked());
  await a.locator("#settings .switch").click();
  await a.locator('#settings .choices label', { hasText: "Light" }).click();
  assert.equal(await a.getAttribute('meta[name="theme-color"][media*="light"]', "content"), rgbText(desk), "and back");

  assert.deepEqual(await a.locator("#sizes li span:first-child").allInnerTexts(), ["Shopping list"], "the space each list takes");
  assert.match(await a.locator("#sizes li span:last-child").innerText(), /\d+ (bytes|KB)/);
  assert.ok(await eventually(async () => /browser/.test(await a.locator("#keep-text").innerText())));
  const [all] = await Promise.all([a.waitForEvent("download"), a.click("#export-all")]);
  assert.match(all.suggestedFilename(), /^panier-\d{4}-\d{2}-\d{2}\.md$/, "every list in one file");
  assert.match(readFileSync(await all.path(), "utf8"), /^# Shopping list\n/);

  assert.equal(await a.locator("#about-server").innerText(), new URL(BASE).host);
  assert.ok(await eventually(async () => (await a.locator("#about-version").innerText()) !== ""));

  await a.locator('#settings .choices label', { hasText: "Same as phone" }).click();
  assert.equal(await a.evaluate(() => document.documentElement.dataset.theme), undefined);
  await a.evaluate(() => history.back()); // the phone's back gesture
  assert.ok(await eventually(async () => !(await a.locator("#settings").isVisible())), "going back closes Settings");
  assert.ok(await a.locator("#lists").isVisible(), "and stays on the lists page");
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

  await a.click("#lists-open");
  assert.equal(await a.locator(".sheet-count").innerText(), "1 à acheter");
  await a.click("#settings-open");
  assert.equal(await a.locator("#settings-title").innerText(), "Paramètres");
  await a.click("#settings-close");
  await a.locator(".sheet-open").click();
  await a.locator("#app").waitFor();

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

test("the ticked group shows the last five days, the latest first; older items are still suggested", async () => {
  const t = await pair();
  let { a } = t;
  const ages = { Plums: 6, Figs: 4, Dates: 0.6, Pears: 0 }; // days since ticked
  for (const w of Object.keys(ages)) await add(a, "ess", w);
  for (const w of Object.keys(ages)) await item(a, w).locator(".boxcell").click();
  await blur(a);
  assert.ok(await eventually(async () => (await ticked(a)).length === 4, 4000));
  await sleep(800); // saved
  // Ticked days ago, as if: set while the app isn't running.
  await a.close();
  a = await t.A.newPage();
  watch(a, t.errors);
  await a.goto(BASE + "/api/lists");
  await a.evaluate(ages => {
    const k = "panier2:" + JSON.parse(localStorage.getItem("panier2")).open, s = JSON.parse(localStorage.getItem(k));
    for (const f of Object.values(s.items)) if (f.text && f.text[0] in ages) f.checkedAt[0] = Date.now() - ages[f.text[0]] * 864e5 - 1000;
    localStorage.setItem(k, JSON.stringify(s));
  }, ages);
  await a.goto(BASE + "/");
  await a.locator("#app").waitFor();
  assert.deepEqual(await ticked(a), ["Pears", "Dates", "Figs"], "ticked today, 14 hours ago and 4 days ago; not 6 days ago");
  assert.equal(await a.locator("#basket-toggle").innerText(), "3 ticked");
  await a.fill("#add-ess", "pl");
  assert.deepEqual(await a.locator("#sug-ess .t").allInnerTexts(), ["Plums"], "the one from 6 days ago is still suggested");
  await t.close();
});

test("the stored list names each phone once and forgets items deleted over six months ago", async () => {
  const t = await pair();
  let { a } = t;
  await add(a, "ess", "Milk");
  await blur(a);
  assert.ok(await eventually(async () => Object.values((await stored(a)).items).some(f => f.text && f.text[0] === "Milk")), "saved shortly after");
  const st = await stored(a);
  const milk = Object.values(st.items).find(f => f.text && f.text[0] === "Milk");
  assert.equal(typeof milk.text[2], "number", "each field names its phone by number");
  assert.equal(st.devs[milk.text[2]], (await index(a)).dev);

  // An item deleted seven months ago and one a month ago, written while the app isn't running.
  await a.close();
  a = await t.A.newPage();
  watch(a, t.errors);
  await a.goto(BASE + "/api/lists"); // a plain answer from the server: the app isn't running
  await a.evaluate(() => {
    const k = "panier2:" + JSON.parse(localStorage.getItem("panier2")).open, s = JSON.parse(localStorage.getItem(k));
    const day = 864e5, gone = (text, ago) => {
      const at = Date.now() - ago;
      return { text: [text, at, 0], section: ["ess", at, 0], pos: [9, at, 0], checked: [false, at, 0], checkedAt: [0, at, 0], deleted: [true, at, 0] };
    };
    s.items.oldGone = gone("Old", 210 * day);
    s.items.newGone = gone("Recent", 30 * day);
    localStorage.setItem(k, JSON.stringify(s));
  });
  await a.goto(BASE + "/");
  await a.locator("#app").waitFor();
  assert.deepEqual(await texts(a, "Essentials"), ["Milk"]);
  await add(a, "ess", "Bread");
  await blur(a);
  assert.ok(await eventually(async () => Object.values((await stored(a)).items).some(f => f.text && f.text[0] === "Bread")));
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

/* ---------- Several lists, Markdown, people, removal ---------- */

// A phone alone, with a list started from the setup code.
async function alone(options) {
  const errors = [];
  const P = await phone(errors, options);
  await P.page.goto(BASE + "/#setup=" + SETUP.toLowerCase());
  await P.page.locator("#pair").waitFor();
  await P.page.click("#pair-close");
  return { ...P, errors, async close() { await P.ctx.close(); assert.deepEqual(errors, [], "no errors in the page"); } };
}
const sheets = pg => pg.locator(".sheet-name").evaluateAll(els => els.map(e => (e.firstChild ? e.firstChild.textContent : ""))); // the name, without who else has it
const counts = pg => pg.locator(".sheet-count").allInnerTexts();
async function toLists(pg) {
  await pg.click("#lists-open");
  await pg.locator("#lists").waitFor();
}
async function newList(pg, name) {
  await pg.fill("#new-list", name);
  await pg.press("#new-list", "Enter");
  await pg.locator("#app").waitFor();
}
const live = pg => pg.locator("#live").innerText();
async function paste(pg, text) {
  await pg.evaluate(text => {
    const dt = new DataTransfer();
    dt.setData("text/plain", text);
    // Firefox leaves out the clipboard of a paste made by a script; a real paste carries it.
    const e = new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true });
    if (!e.clipboardData || !e.clipboardData.getData("text/plain")) Object.defineProperty(e, "clipboardData", { value: dt });
    document.activeElement.dispatchEvent(e);
  }, text);
}

test("several lists: each a sheet on the lists page, made from a name, each syncing on its own", async () => {
  const t = await pair();
  const { a, b } = t;
  await add(a, "ess", "2 milk");
  await add(a, "ess", "Bread");
  await add(a, "look", "Ripe avocados");
  await blur(a);
  await toLists(a);
  assert.deepEqual(await sheets(a), ["Shopping list"]);
  assert.deepEqual(await counts(a), ["3 to get"]);
  assert.deepEqual(await a.locator(".sheet-item").allInnerTexts(), ["2 milk", "Bread", "Ripe avocados"], "and the first three of them");
  assert.equal(await a.locator(".sheet-open").getAttribute("aria-label"), "Shopping list, with 1 other phone, 3 to get");
  assert.equal(await a.locator(".sheet-with").innerText(), "with 1 other phone", "who else has it, quietly");

  await newList(a, "Hardware store");
  assert.equal(await a.locator("#list-name").innerText(), "Hardware store", "a new list opens, named");
  assert.deepEqual(await names(a), ["Essentials", "Look out for", "Long term"]);
  await add(a, "ess", "Screws");
  await blur(a);
  await a.goBack(); // the phone's back gesture
  await a.locator("#lists").waitFor();
  assert.ok(await eventually(async () => (await sheets(a)).join() === "Shopping list,Hardware store"));
  assert.deepEqual(await counts(a), ["3 to get", "1 to get"]);
  const [one, two] = await a.locator(".sheet-card").evaluateAll(els => els.map(el => el.getBoundingClientRect()));
  assert.ok(Math.abs(one.top - two.top) < 1 && two.left > one.right && Math.abs(one.height - two.height) < 1, "side by side, the same size");

  await sleep(500);
  assert.equal((await index(b)).lists.length, 1, "the other phone has only the list shared with it");
  assert.deepEqual(await texts(b, "Essentials"), ["2 milk", "Bread"]);
  await add(b, "ess", "Eggs");
  await blur(b);
  assert.ok(await eventually(async () => { const st = await stored(b); return !st.outbox.length && Object.values(st.items).some(f => f.text && f.text[0] === "Eggs"); }), "sent, and saved");
  await a.locator(".sheet-open").nth(1).click();
  await a.locator("#app").waitFor();
  await a.goBack();
  assert.ok(await eventually(async () => (await counts(a))[0] === "4 to get"), "a list not on screen catches up as the lists page shows");

  await offline(t.A, a);
  assert.ok(await eventually(async () => (await a.locator("#status").isVisible()) && (await a.locator("#status-text").innerText()) === "Offline", 4000), "offline, the lists page says so");
  await a.fill("#new-list", "Garden");
  await a.press("#new-list", "Enter");
  assert.ok(await eventually(async () => /Couldn't reach the server/.test(await a.locator("#lists-msg").innerText())), "a list can't be made offline");
  assert.equal(await a.inputValue("#new-list"), "Garden", "and its name stays in the field, to try again");
  await a.fill("#new-list", "");
  await online(t.A, a);
  assert.ok(await eventually(async () => !(await a.locator("#status").isVisible())));

  await a.locator(".sheet-open").nth(1).click();
  await a.reload();
  await a.locator("#app").waitFor();
  assert.equal(await a.locator("#list-name").innerText(), "Hardware store", "the app opens on the list last used");
  await a.goBack();
  await a.locator("#lists").waitFor();
  assert.deepEqual(await sheets(a), ["Shopping list", "Hardware store"], "with the lists page under it");

  // The same phone, in another tab: a list deleted in one leaves the other too.
  const tab = await t.A.newPage();
  await tab.goto(BASE + "/");
  await toLists(tab);
  await a.locator(".sheet-open").nth(1).click();
  await a.locator("#app").waitFor();
  await tab.locator(".sheet-open").nth(1).focus();
  await tab.keyboard.press("Delete");
  await tab.click("#confirm-ok");
  await a.locator("#lists").waitFor();
  assert.deepEqual(await sheets(a), ["Shopping list"], "deleted in another tab, the list on screen gives way to the lists page");
  assert.equal(await a.evaluate(() => Object.keys(localStorage).filter(k => k.startsWith("panier2:")).length), 1, "and isn't written back");
  await t.close();
});

test("lists are reordered by dragging, and deleted only from the lists page, once asked; undo brings them back", async () => {
  const p = await alone();
  const a = p.page;
  await toLists(a);
  for (const n of ["Hardware store", "Market"]) { await newList(a, n); await toLists(a); }
  assert.deepEqual(await sheets(a), ["Shopping list", "Hardware store", "Market"]);

  await a.locator(".sheet-open").nth(2).focus();
  await a.keyboard.press("Alt+ArrowUp");
  assert.deepEqual(await sheets(a), ["Shopping list", "Market", "Hardware store"], "Alt+↑ moves a list up");
  assert.equal(await a.evaluate(() => document.activeElement.innerText.split("\n")[0]), "Market", "and keeps the cursor on it");

  const top = (await a.locator(".sheet-card").first().boundingBox()).y;
  await dragTo(a, a.locator(".sheet-card").nth(2), top + 5);
  assert.deepEqual(await sheets(a), ["Hardware store", "Shopping list", "Market"], "dragged to the top");
  assert.deepEqual((await index(a)).lists.map(e => e.name || "Shopping list"), ["Hardware store", "Shopping list", "Market"], "and kept in that order");

  const toZone = async () => (await a.locator("#remove-drop").boundingBox()).y + 20;
  await dragTo(a, a.locator(".sheet-card").nth(1), toZone);
  await a.locator("#confirm").waitFor();
  assert.equal(await a.locator("#confirm-title").innerText(), "Delete “Shopping list”?", "dropped at the foot, it asks first");
  assert.equal(await a.locator("#confirm-text").innerText(), "It goes from this phone. Its link brings it back, if you kept one.");
  await a.click("#confirm-cancel");
  assert.deepEqual(await sheets(a), ["Hardware store", "Shopping list", "Market"], "and nothing goes until it's answered");
  await dragTo(a, a.locator(".sheet-card").nth(1), toZone);
  await a.click("#confirm-ok");
  assert.deepEqual(await sheets(a), ["Hardware store", "Market"], "deleted from this phone");
  assert.equal(await a.locator("#undo-what").innerText(), "Shopping list", "undo names what it would bring back");
  await a.click("#undo");
  assert.deepEqual(await sheets(a), ["Hardware store", "Shopping list", "Market"], "back where it was");

  await a.locator(".sheet-open").nth(2).click();
  await a.click("#pair-open");
  assert.equal(await a.locator("#members").innerText(), "Only you, so far.");
  assert.equal(await a.locator("#rekey-open").isVisible(), false, "no one to remove");
  assert.equal(await a.locator("#pair button").filter({ hasText: /Delete/ }).count(), 0, "the share sheet deletes nothing");
  await a.click("#pair-close");
  await a.click("#list-name");
  assert.equal(await a.locator(".list-top .bin").count(), 0, "nor does the list's name");
  await a.keyboard.press("Escape");
  await toLists(a);
  await a.locator(".sheet-open").nth(2).focus();
  await a.keyboard.press("Delete");
  assert.equal(await a.locator("#confirm-title").innerText(), "Delete “Market”?", "the Delete key asks too");
  await a.click("#confirm-ok");
  assert.deepEqual(await sheets(a), ["Hardware store", "Shopping list"]);
  await a.click("#undo");
  assert.deepEqual(await sheets(a), ["Hardware store", "Shopping list", "Market"]);
  await p.close();
});

test("lists come in from Markdown, from the earlier text export too, and from several pasted lines", async () => {
  const errors = [];
  const { ctx, page: a } = await phone(errors);
  await a.goto(BASE + "/");
  await a.locator("#lists").waitFor();
  const md = "# Hardware store <!-- olive -->\n\n## Garden <!-- teal -->\n- [ ] Hose\n- [x] Seeds\n\n## Essentials\n- [ ] 2 bulbs\n";
  await a.setInputFiles("#import-file", { name: "hardware.md", mimeType: "text/markdown", buffer: Buffer.from(md) });
  await a.fill("#setup-code", SETUP); // the first list on a server needs its setup code
  await a.click("#setup-form button[type=submit]");
  await a.locator("#app").waitFor();
  assert.equal(await a.locator("#list-name").innerText(), "Hardware store");
  assert.equal(await a.evaluate(() => document.documentElement.dataset.list), "olive");
  assert.deepEqual(await names(a), ["Garden", "Essentials"], "its sections, and no others");
  assert.deepEqual(await texts(a, "Garden"), ["Hose"]);
  assert.deepEqual(await texts(a, "Essentials"), ["2 bulbs"]);
  assert.deepEqual(await ticked(a), [], "what was bought before isn't shown as ticked");
  await section(a, "Garden").locator(".add-input").fill("se");
  assert.deepEqual(await section(a, "Garden").locator(".sug .t").allInnerTexts(), ["Seeds"], "but suggested");
  await section(a, "Garden").locator(".add-input").fill("");
  await blur(a);
  const [dl] = await Promise.all([a.waitForEvent("download"), a.click("#export-btn")]);
  assert.equal(readFileSync(await dl.path(), "utf8"), md.replace("## Essentials\n", "## Essentials <!-- ink -->\n"), "and exports as it came in");

  await toLists(a);
  const txt = "Shopping list, 12 November 2026\n\nEssentials\n- [ ] 2 eggs\n\nLook out for\n- [ ] Ripe avocados\n\nBought before\n- [x] Milk\n";
  await a.setInputFiles("#import-file", { name: "shopping-list-2026-11-12.txt", mimeType: "text/plain", buffer: Buffer.from(txt) });
  await a.locator("#app").waitFor();
  assert.equal(await a.locator("#list-name").innerText(), "Shopping list", "no setup code the second time");
  assert.deepEqual(await names(a), ["Essentials", "Look out for"]);
  assert.deepEqual(await texts(a, "Essentials"), ["2 eggs"]);
  await a.fill("#add-ess", "mi");
  assert.deepEqual(await a.locator("#sug-ess .t").allInnerTexts(), ["Milk"]);

  await a.fill("#add-ess", "Jam");
  await a.focus("#add-ess");
  await paste(a, "- [ ] Butter\n- [ ] 2 eggs\nCheese\n");
  assert.deepEqual(await texts(a, "Essentials"), ["2 eggs", "Butter", "Cheese"], "one item a line");
  assert.equal(await a.inputValue("#add-ess"), "Jam", "and what was typed stays");
  await a.fill("#add-ess", "");
  assert.ok(await eventually(async () => (await live(a)) === "Added 2 items, 1 already on the list"));
  await blur(a);
  await a.click("#undo");
  assert.deepEqual(await texts(a, "Essentials"), ["2 eggs"], "in one step to undo");
  await ctx.close();
  assert.deepEqual(errors, []);
});

test("the people on a list: names on the share sheet, undo says who; three phones end up the same", async () => {
  const t = await pair();
  const { a, b, A, B } = t;
  await toLists(b);
  await b.click("#settings-open");
  await b.fill("#my-name", "Alex");
  await b.press("#my-name", "Enter");
  await b.click("#settings-close");
  await b.locator(".sheet-open").click();
  await a.click("#pair-open");
  assert.ok(await eventually(async () => (await a.locator("#members").innerText()) === "On this list: you and Alex."));
  assert.ok(await a.locator("#pair-name").isVisible(), "a phone without a name is asked for one where names matter");
  await a.fill("#pair-name-input", "Sam");
  await a.press("#pair-name-input", "Enter");
  await a.click("#pair-close");
  await b.click("#pair-open");
  assert.equal(await b.locator("#pair-name").isVisible(), false, "and not once it has one");
  assert.ok(await eventually(async () => (await b.locator("#members").innerText()) === "On this list: you and Sam."), "the others see it");
  await b.click("#pair-close");

  const C = await phone(t.errors), c = C.page;
  await c.goto(BASE + "/#k=" + t.key);
  await c.locator("#app").waitFor();
  await a.click("#pair-open");
  assert.ok(await eventually(async () => (await a.locator("#members").innerText()) === "On this list: you, Alex, and 1 phone without a name."));
  await a.click("#pair-close");
  await toLists(a);
  assert.equal(await a.locator(".sheet-with").innerText(), "with Alex and 1 other", "the lists page says who else has a list, quietly");
  assert.match(await a.locator(".sheet-open").getAttribute("aria-label"), /^Shopping list, with Alex and 1 other, /);
  await a.locator(".sheet-open").click();
  await a.locator("#app").waitFor();

  await add(a, "ess", "Bread");
  await blur(a);
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
  assert.ok(await eventually(async () => /Nothing to undo: Alex already changed it/.test(await live(a))), "undo says who changed it since");

  const phones = [[A, a], [B, b], [C.ctx, c]];
  for (const [ctx, pg] of phones) await offline(ctx, pg);
  await add(a, "ess", "Apples");
  await add(b, "ess", "Pears");
  await add(c, "look", "Figs");
  await item(c, "Sourdough").locator(".boxcell").click();
  for (const [, pg] of phones) await blur(pg);
  await sleep(1900);
  for (const [ctx, pg] of phones) await online(ctx, pg);
  const seen = async pg => [(await texts(pg, "Essentials")).slice().sort().join(), (await texts(pg, "Look out for")).join(), (await ticked(pg)).join()].join("|");
  assert.ok(await eventually(async () => {
    const all = await Promise.all(phones.map(([, pg]) => seen(pg)));
    return all.every(x => x === "Apples,Pears|Figs|Sourdough");
  }, 15000), "edited offline on three phones, the same list on each");
  await C.ctx.close();
  await t.close();
});

test("changing a list's key leaves everyone else with it closed, until they open the new link; deleting closes it for all", async () => {
  const t = await pair();
  const { a, b } = t;
  await add(a, "ess", "Milk");
  await blur(a);
  assert.ok(await eventually(async () => (await texts(b, "Essentials")).join() === "Milk"));
  await a.click("#pair-open");
  await a.click("#rekey-open");
  await a.locator("#confirm").waitFor();
  assert.equal(await a.locator("#confirm-title").innerText(), "Remove someone from “Shopping list”?");
  await a.click("#confirm-ok");
  await a.locator("#pair").waitFor(); // then the new link, to share with those who keep it
  const fresh = await openKey(a);
  assert.notEqual(fresh, t.key);
  await a.click("#pair-close");
  assert.deepEqual(await texts(a, "Essentials"), ["Milk"], "this phone carries on with the list");
  assert.ok(await eventually(async () => (await b.locator("#status").isVisible()) && (await b.locator("#status-text").innerText()) === "List closed", 8000), "the other phone is told");
  await add(a, "ess", "Bread");
  await blur(a);
  await sleep(800);
  assert.deepEqual(await texts(b, "Essentials"), ["Milk"], "and gets nothing more, though it keeps what it had");
  assert.equal(await b.locator("#add-ess").isVisible(), false, "a closed list is only read: nothing to add");
  assert.ok(await item(b, "Milk").locator(".chk").isDisabled(), "nor to tick");
  await item(b, "Milk").locator(".text").click();
  assert.equal(await b.locator(".text.editing").count(), 0, "nor to edit");
  assert.equal(await b.locator("#dock").isVisible(), false, "nor to undo");

  await b.goto("about:blank");
  await b.goto(BASE + "/#k=" + fresh);
  await b.locator("#app").waitFor();
  assert.ok(await eventually(async () => (await texts(b, "Essentials")).join() === "Milk,Bread"), "the new link brings the list back");
  await toLists(b);
  assert.ok(await eventually(async () => (await counts(b)).join() === "Closed,2 to get"), "beside the closed one");

  assert.ok(await eventually(async () => (await b.locator(".sheet-card").nth(1).locator(".sheet-with").innerText()) === "with 1 other phone"));
  await dragTo(b, b.locator(".sheet-card").nth(1), async () => (await b.locator("#remove-drop").boundingBox()).y + 20);
  await b.locator("#confirm").waitFor();
  assert.equal(await b.locator("#confirm-text").innerText(), "It goes from this phone only: the others keep it.");
  await b.click("#confirm-more");
  assert.equal(await b.locator("#confirm-title").innerText(), "Delete “Shopping list” for everyone?", "for everyone, it asks again");
  await b.click("#confirm-ok");
  assert.ok(await eventually(async () => (await counts(b)).join() === "Closed"), "deleting it takes it off this phone");
  assert.ok(await eventually(async () => (await a.locator("#status-text").innerText()) === "List closed", 8000), "and closes it for everyone");
  assert.equal(await a.locator("#pair-open").isVisible(), false, "a closed list isn't offered for sharing");
  await a.click("#status-pill");
  assert.equal(await a.locator("#status-detail button").count(), 0, "nor deleted from the list itself");
  await toLists(a);
  await a.locator(".sheet-open").focus();
  await a.keyboard.press("Delete");
  assert.equal(await a.locator("#confirm-text").innerText(), "It's closed already: this takes what's left of it off this phone.");
  assert.equal(await a.locator("#confirm-more").isVisible(), false, "there's no one left to delete it for");
  await a.click("#confirm-ok");
  assert.ok(await eventually(async () => (await sheets(a)).length === 0), "the closed list is deleted from this phone");
  await t.close();
});

test("one link sets up another phone with every list", async () => {
  const p = await alone();
  const a = p.page;
  await add(a, "ess", "Milk");
  await toLists(a);
  await newList(a, "Hardware store");
  await add(a, "ess", "Screws");
  await blur(a);
  await toLists(a);
  await a.click("#settings-open");
  await a.click("#phone-open");
  await a.locator("#pair").waitFor();
  assert.equal(await a.locator("#pair-title").innerText(), "Set up another phone");
  assert.equal(await a.locator("#people").isVisible(), false, "no people: it's for this phone's owner");
  await a.click("#pair-close");
  const keys = (await index(a)).lists.map(e => e.key);
  const other = await phone(p.errors), o = other.page;
  await o.goto(BASE + "/#k=" + keys.join("."));
  await o.locator("#lists").waitFor();
  assert.ok(await eventually(async () => (await sheets(o)).join() === "Shopping list,Hardware store" && (await counts(o)).join() === "1 to get,1 to get"));
  await other.ctx.close();
  await p.close();
});

test("a list changed with a newer Panier is left alone", async () => {
  const t = await pair();
  const { a, b } = t;
  // A newer Panier on a third phone asks for format 99: its change, encrypted with the list's key.
  await b.evaluate(async key => {
    const enc = new TextEncoder(), raw = Uint8Array.from(atob(key.replace(/-/g, "+").replace(/_/g, "/")), c => c.charCodeAt(0));
    const base = await crypto.subtle.importKey("raw", raw, "HKDF", false, ["deriveBits", "deriveKey"]);
    const p = info => ({ name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: enc.encode(info) });
    const bytes = b => String.fromCharCode(...new Uint8Array(b));
    const id = [...new Uint8Array(await crypto.subtle.deriveBits(p("panier list id"), base, 128))].map(x => x.toString(16).padStart(2, "0")).join("");
    const auth = btoa(bytes(await crypto.subtle.deriveBits(p("panier auth"), base, 256))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    const k = await crypto.subtle.deriveKey(p("panier encryption"), base, { name: "AES-GCM", length: 256 }, false, ["encrypt"]);
    const padded = new Uint8Array(256).fill(0x20);
    padded.set(enc.encode(JSON.stringify({ d: "newer", o: [["@list", "format", 99, Date.now() + 1000]] })));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: enc.encode(id) }, k, padded));
    const out = new Uint8Array(12 + ct.length);
    out.set(iv);
    out.set(ct, 12);
    await fetch("/api/lists/" + id + "/changes", { method: "POST", headers: { Authorization: "Bearer " + auth, "Content-Type": "application/json" }, body: JSON.stringify({ changes: [btoa(bytes(out))] }) });
  }, t.key);
  assert.ok(await eventually(async () => (await a.locator("#status").isVisible()) && (await a.locator("#status-text").innerText()) === "Update Panier", 8000));
  assert.ok(await eventually(async () => !(await a.locator("#add-ess").isVisible())), "it is only read: nothing to add");
  assert.equal((await stored(a)).outbox.length, 0, "and nothing to send");
  await toLists(a);
  assert.deepEqual(await counts(a), ["Update Panier to open it"]);
  await t.close();
});

test("opening a list leaves it still, and from the keyboard the cursor follows between the lists page and the list", async () => {
  const p = await alone();
  const a = p.page;
  for (const x of ["Milk", "Bread"]) await add(a, "ess", x);
  await blur(a);
  await toLists(a);
  const lid = (await index(a)).open;
  await a.locator(".sheet-open").focus();
  await a.keyboard.press("Enter");
  await a.locator("#app").waitFor();
  assert.equal(await a.evaluate(() => document.activeElement.id), "list-name", "the cursor moves to the list's name");
  await sleep(1500);
  assert.equal(await a.evaluate(() => [...document.querySelectorAll("#list .item")].filter(el => /lifted|pressing/.test(el.className) || el.getAnimations().length).length), 0, "nothing lifts or moves by itself");
  await a.focus("#lists-open");
  await a.keyboard.press("Enter");
  await a.locator("#lists").waitFor();
  assert.equal(await a.evaluate(() => document.activeElement.dataset.fk), "sheet-" + lid, "back on the lists page, it returns to that list's sheet");
  await a.keyboard.press("Enter");
  await a.locator("#app").waitFor();
  await a.focus("#lists-open");
  await a.keyboard.press("Enter");
  await a.locator("#lists").waitFor();
  await a.keyboard.press("Delete");
  await a.locator("#confirm").waitFor();
  await a.focus("#confirm-ok");
  await a.keyboard.press("Enter");
  assert.ok(await eventually(() => a.evaluate(() => document.activeElement.id === "undo")), "a list deleted from the phone leaves the cursor on undo");
  await p.close();
});

test("on a slow phone, a step back in history that lands late undoes nothing that came after it", async () => {
  const p = await alone();
  const a = p.page;
  await add(a, "ess", "Milk");
  await blur(a);
  // Each step back lands most of a second late, as on a busy phone.
  await a.evaluate(() => { const back = history.back.bind(history); history.back = () => setTimeout(back, 800); });
  await a.click("#lists-open");
  await a.locator(".sheet-open").click();
  await sleep(1500);
  assert.equal(await a.locator("#app").isVisible(), true, "the list opened at once stays open");
  await a.goBack();
  await a.locator("#lists").waitFor();
  await a.click("#settings-open");
  await a.click("#phone-open");
  await sleep(1500);
  assert.equal(await a.locator("#pair").isVisible(), true, "a sheet opened from another stays open");
  await a.goBack();
  assert.ok(await eventually(async () => !(await a.locator("#pair").isVisible()) && (await a.locator("#lists").isVisible())), "back closes it, onto the lists page");
  await a.locator(".sheet-open").click();
  await a.click("#pair-open");
  await a.click("#pair-close");
  await a.click("#lists-open");
  await sleep(1500);
  assert.equal(await a.locator("#lists").isVisible(), true, "two steps back, one after the other, land on the lists page");
  assert.ok(await eventually(() => a.evaluate(() => JSON.stringify(history.state) === "{}")), "and history follows, one step after the other");
  await p.close();
});
