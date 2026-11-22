// Efficiency: what Panier costs a phone and a server, in bytes, time, wake-ups and
// storage, measured the same way each time. docs/efficiency.md says what each number
// means, its budget, and how to bring it down.
//
//   node test/efficiency.mjs
//
// builds the Go server from this copy, as a release would be, and measures it.
//
//   BASE=http://127.0.0.1:8787 SETUP=TEST-CODE-1234 node test/efficiency.mjs
//
// measures a server already running, such as the Worker (wrangler dev). Never point it
// at a server people use: it makes lists there.
//
// OUT=after.json saves the results; BEFORE=before.json shows an earlier run beside them.
// IDLE sets how long each wait with nothing to do lasts, in seconds (60); ITEMS and TICKED
// how long the long list is (300 to tick, 1000 ticked). Needs Playwright with Chromium,
// and Go without BASE.

import { createRequire } from "node:module";
import { execFileSync, spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { brotliCompressSync, constants, gzipSync } from "node:zlib";
import net from "node:net";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const IDLE = Number(process.env.IDLE || 60), ITEMS = Number(process.env.ITEMS || 300), TICKED = Number(process.env.TICKED || 1000);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const median = xs => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

// A slow phone: four times slower than this computer, on a slow 4G connection.
const CPU = 4, NET = { offline: false, latency: 150, downloadThroughput: 1.6e6 / 8, uploadThroughput: 750e3 / 8 };

// What each number may be at most. Over budget, the report says so; it's for a person to
// judge, not a test that fails.
// Timings vary from run to run by a third or so: one just over is worth a second run.
const BUDGET = {
  appGzip: 100, appBrotli: 85, staticGzip: 75,
  firstReady: 3000, firstDown: 300,
  openLong: 1500, longTasks: 3,
  tick: 150, type: 150, // a real phone feels 200 ms; this one keeps a margin
  tickUp: 2, listsPageRequests: 9,
  storageLong: 400,
  idleRequests: 0, idleWakeups: 30, idleCpu: 100, // 100 ms a minute is a sixth of a percent of one core
  hiddenRequests: 0, hiddenWakeups: 0, hiddenCpu: 10,
};

const results = [];
const note = (area, key, label, value, unit) => results.push({ area, key, label, value: Math.round(value * 10) / 10, unit });

/* ---------- The files a phone downloads ---------- */

function files() {
  const sw = readFileSync(join(ROOT, "web/sw.js"), "utf8");
  const list = name => JSON.parse(sw.match(new RegExp("const " + name + " = (\\[[^\\]]*\\])"))[1]);
  const size = fs => {
    let raw = 0, gz = 0, br = 0;
    for (const f of fs) {
      const data = readFileSync(join(ROOT, "web", f === "./" ? "index.html" : f));
      raw += data.length;
      gz += gzipSync(data, { level: 9 }).length;
      br += brotliCompressSync(data, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } }).length;
    }
    return { raw: raw / 1024, gz: gz / 1024, br: br / 1024 };
  };
  const app = size(list("FILES")), stat = size(list("STATIC_FILES"));
  note("Download", "appRaw", "The app's files, as written", app.raw, "KB");
  note("Download", "appGzip", "The app's files, gzipped: what an update downloads", app.gz, "KB");
  note("Download", "appBrotli", "The same, with Brotli, as Cloudflare sends them", app.br, "KB");
  note("Download", "staticGzip", "Fonts, icons and the QR code library, kept across updates", stat.gz, "KB");
}

/* ---------- The code ---------- */

function code() {
  const count = (dir, re) => {
    let lines = 0, n = 0;
    for (const f of readdirSync(join(ROOT, dir))) {
      if (!re.test(f) || /_test\.go$/.test(f)) continue;
      n++;
      lines += readFileSync(join(ROOT, dir, f), "utf8").split("\n").length;
    }
    return { lines, n };
  };
  const web = count("web", /\.(js|css|html)$/), go = count(".", /\.go$/), worker = count("worker", /\.js$/);
  note("Code", "webLines", `The app: ${web.n} files`, web.lines, "lines");
  note("Code", "goLines", "The Go server", go.lines, "lines");
  note("Code", "workerLines", "The Worker", worker.lines, "lines");
}

/* ---------- A server, and what goes over the wire to it ---------- */

// The Go server, built from a copy of this one with its version stamped, so the service
// worker caches the app as it does for a release.
async function goServer() {
  const dir = mkdtempSync(join(tmpdir(), "panier-efficiency-"));
  const tracked = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], { cwd: ROOT }).toString().trim().split("\n");
  for (const f of tracked) {
    if (!existsSync(join(ROOT, f))) continue;
    mkdirSync(dirname(join(dir, f)), { recursive: true });
    copyFileSync(join(ROOT, f), join(dir, f));
  }
  const sw = join(dir, "web/sw.js");
  writeFileSync(sw, readFileSync(sw, "utf8").replace(/^const VERSION = ".*";/m, 'const VERSION = "efficiency";'));
  execFileSync("go", ["build", "-o", join(dir, "panier"), "."], { cwd: dir });
  const data = join(dir, "data");
  const setup = execFileSync(join(dir, "panier"), ["-data", data, "-setup-code"]).toString().trim();
  const port = await freePort(), proc = spawn(join(dir, "panier"), ["-data", data, "-addr", "127.0.0.1:" + port], { stdio: "ignore" });
  const base = "http://127.0.0.1:" + port;
  for (let i = 0; i < 50; i++) { try { await fetch(base); break; } catch (_) { await sleep(100); } }
  return { base, setup, data, stop: () => { proc.kill(); rmSync(dir, { recursive: true, force: true }); } };
}
const freePort = () => new Promise(r => { const s = net.createServer().listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => r(p)); }); });

// Everything the phone sends and receives passes through here and is counted, as it goes
// over the wire: pages, the service worker's downloads, the API and the live connection.
async function counter(base) {
  const target = new URL(base);
  const seen = { up: 0, down: 0, requests: [] };
  const server = net.createServer(c => {
    const s = net.connect(Number(target.port) || 80, target.hostname);
    c.on("data", d => {
      seen.up += d.length;
      for (const m of d.toString("latin1").matchAll(/^(GET|POST|PUT|DELETE|HEAD) (\S+) HTTP\/1\.1/gm)) seen.requests.push(m[1] + " " + m[2].split("?")[0]);
      s.write(d);
    });
    s.on("data", d => { seen.down += d.length; c.write(d); });
    const end = () => { c.destroy(); s.destroy(); };
    c.on("close", end); s.on("close", end); c.on("error", end); s.on("error", end);
  });
  const port = await new Promise(r => server.listen(0, "127.0.0.1", () => r(server.address().port)));
  return {
    base: "http://127.0.0.1:" + port,
    mark: () => ({ up: seen.up, down: seen.down, n: seen.requests.length }),
    since: m => ({ up: (seen.up - m.up) / 1024, down: (seen.down - m.down) / 1024, requests: seen.requests.slice(m.n) }),
    // Waits until nothing has gone over the wire for a while.
    quiet: async (ms = 1500) => { let last = -1; while (last !== seen.up + seen.down) { last = seen.up + seen.down; await sleep(ms); } },
    stop: () => server.close(),
  };
}
const dirSize = d => existsSync(d) ? readdirSync(d, { withFileTypes: true }).reduce((n, e) => n + (e.isDirectory() ? dirSize(join(d, e.name)) : statSync(join(d, e.name)).size), 0) : 0;

/* ---------- A phone ---------- */

// Counts every timer and frame that runs, and each long task: what the app does, seen
// from inside.
function watch() {
  const w = (window.__wake = { timers: 0, frames: 0, long: 0 });
  const st = window.setTimeout, si = window.setInterval, raf = window.requestAnimationFrame;
  window.setTimeout = (f, ...a) => st((...x) => { w.timers++; if (typeof f === "function") f(...x); }, ...a);
  window.setInterval = (f, ...a) => si((...x) => { w.timers++; f(...x); }, ...a);
  window.requestAnimationFrame = f => raf(t => { w.frames++; f(t); });
  try { new PerformanceObserver(l => { w.long += l.getEntries().length; }).observe({ type: "longtask", buffered: true }); } catch (_) {}
}
async function phone(browser) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: "en-GB" });
  await ctx.addInitScript(watch);
  const page = await ctx.newPage();
  const cdp = await ctx.newCDPSession(page);
  await cdp.send("Network.enable");
  await cdp.send("Performance.enable");
  const errors = [];
  page.on("pageerror", e => errors.push(e.message));
  return {
    ctx, page, errors,
    slow: async on => {
      await cdp.send("Emulation.setCPUThrottlingRate", { rate: on ? CPU : 1 });
      await cdp.send("Network.emulateNetworkConditions", on ? NET : { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
    },
    // The time the page spent running, in ms.
    busy: async () => { const { metrics } = await cdp.send("Performance.getMetrics"); return 1000 * metrics.find(m => m.name === "TaskDuration").value; },
  };
}
// Until the phone has sent everything it has waiting.
async function synced(page) {
  for (let i = 0; i < 600; i++) {
    if (await page.evaluate(async () => (await import("/store.js")).status().waiting === 0)) return;
    await sleep(200);
  }
  throw new Error("the phone never finished sending");
}

/* ---------- The measures ---------- */

async function measure(server) {
  const wire = await counter(server.base);
  const browser = await chromium.launch();
  const p = await phone(browser), { page } = p;
  try {
    // A first visit, from the setup link to naming the list, on a slow phone; then all
    // it downloads, the service worker's copy of the app included.
    await p.slow(true);
    let m = wire.mark();
    await page.goto(wire.base + "/#setup=" + server.setup);
    await page.locator("#list-name.editing").waitFor({ timeout: 60000 });
    note("First visit", "firstReady", "From the link to naming the list, on a slow phone", await page.evaluate(() => performance.now()), "ms");
    await page.evaluate(() => navigator.serviceWorker.ready);
    await wire.quiet();
    let w = wire.since(m);
    note("First visit", "firstDown", "Everything it downloads, the service worker's copy included", w.down, "KB");
    note("First visit", "firstRequests", "Requests", w.requests.length, "");

    // A long list: ITEMS to tick in six sections, and TICKED ticked, kept in view always.
    await p.slow(false);
    await page.keyboard.type("Groceries");
    await page.keyboard.press("Enter");
    await page.evaluate(async ({ ITEMS, TICKED }) => {
      const store = await import("/store.js"), { PALETTE } = await import("/model.js"), list = await import("/list.js");
      const words = ["Milk", "Bread", "Apples", "Oat milk", "Washing-up liquid", "2 kg potatoes", "Greek yoghurt", "Bin bags", "Coffee", "Leeks"];
      const ops = [["@list", "ticked", 0]], secs = [];
      for (const [i, name] of ["Fruit & veg", "Dairy", "Bakery", "Cleaning", "Frozen", "Drinks"].entries()) {
        const id = store.newId();
        secs.push(id);
        ops.push(["#" + id, "name", name], ["#" + id, "pos", i + 1], ["#" + id, "color", PALETTE[i]], ["#" + id, "deleted", false]);
      }
      const now = Date.now();
      for (let k = 0; k < ITEMS + TICKED; k++) {
        const id = store.newId(), ticked = k >= ITEMS;
        ops.push([id, "text", words[k % words.length] + " " + k], [id, "section", secs[k % secs.length]], [id, "pos", k + 1], [id, "deleted", false]);
        if (ticked) ops.push([id, "checked", true], [id, "checkedAt", now - (k - ITEMS) * 3600e3]);
      }
      store.change(null, ops);
      list.repaint();
    }, { ITEMS, TICKED });
    await synced(page);
    await wire.quiet();
    note("Storage", "storageLong", `The long list on the phone (${ITEMS} to tick, ${TICKED} ticked)`, await page.evaluate(() => {
      let n = 0;
      for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k.startsWith("panier")) n += k.length + localStorage.getItem(k).length; }
      return n / 1024;
    }), "KB");
    if (server.data) note("Storage", "storageServer", "The same on the server, with the other list's start", dirSize(server.data) / 1024, "KB");

    // Opening the app again on the long list, on a slow phone.
    await p.slow(true);
    m = wire.mark();
    await page.reload();
    await page.locator("#list .item").first().waitFor({ timeout: 60000 });
    note("Opening", "openLong", "Opening the app on the long list, on a slow phone", await page.evaluate(() => performance.now()), "ms");
    note("Opening", "longTasks", "Tasks over 50 ms meanwhile", await page.evaluate(() => window.__wake.long), "");
    await wire.quiet();
    w = wire.since(m);
    note("Opening", "openDown", "What it downloads", w.down, "KB");
    note("Opening", "openRequests", "Requests", w.requests.filter(r => !/\/live$/.test(r)).length, "");

    // Ticking and adding, on the long list, on a slow phone: from the tap to the next frame,
    // as the person would see it; the median of five.
    const ticks = await page.evaluate(async () => {
      const out = [];
      for (let i = 0; i < 5; i++) {
        const box = document.querySelector("#list .item:not(.done) .chk");
        const t0 = performance.now();
        box.click();
        await new Promise(r => requestAnimationFrame(() => setTimeout(r, 0)));
        out.push(performance.now() - t0);
        await new Promise(r => setTimeout(r, 2500)); // into the ticked group before the next
      }
      return out;
    });
    note("On the long list", "tick", "Ticking an item, to the next frame, on a slow phone", median(ticks), "ms");
    const types = await page.evaluate(async () => {
      const out = [], input = document.querySelector("#list .add-input");
      for (let i = 0; i < 5; i++) {
        input.value = "Oat milk " + i;
        input.dispatchEvent(new Event("input"));
        const t0 = performance.now();
        input.form.requestSubmit();
        await new Promise(r => requestAnimationFrame(() => setTimeout(r, 0)));
        out.push(performance.now() - t0);
        await new Promise(r => setTimeout(r, 800));
      }
      return out;
    });
    note("On the long list", "type", "Adding an item, to the next frame, on a slow phone", median(types), "ms");
    await synced(page);
    await wire.quiet();
    await p.slow(false);

    // What one tick sends.
    m = wire.mark();
    await page.locator("#list .item:not(.done) .boxcell").first().click();
    await synced(page);
    await wire.quiet();
    w = wire.since(m);
    note("On the long list", "tickUp", "What one tick sends", w.up, "KB");

    // The lists page, with eight lists.
    for (const name of ["Hardware", "Pharmacy", "Gifts", "Camping", "Market", "Garden", "Books"]) {
      await page.click("#lists-open");
      await page.fill("#new-list", name);
      await page.press("#new-list", "Enter");
      await page.locator("#app:not([hidden])").waitFor();
      for (const x of ["One", "Two", "Three"]) { await page.keyboard.type(x); await page.keyboard.press("Enter"); }
      await synced(page);
    }
    await page.locator("#list .item").first().waitFor();
    await wire.quiet();
    m = wire.mark();
    await page.click("#lists-open");
    await wire.quiet();
    w = wire.since(m);
    note("Lists page", "listsPageRequests", "Opening the lists page, with eight lists: requests", w.requests.length, "");
    note("Lists page", "listsPageDown", "and what they download", w.down, "KB");

    // Nothing to do, on the long list: on screen, then put away.
    await page.locator("#sheets .sheet-open").filter({ hasText: "Groceries" }).click();
    await page.locator("#list .item").first().waitFor();
    await wire.quiet();
    await sleep(5000); // what opening it left to do is done
    for (const [hidden, label] of [[false, "on screen"], [true, "put away"]]) {
      if (hidden) {
        await page.evaluate(() => {
          Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
          Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
          document.dispatchEvent(new Event("visibilitychange"));
        });
        await sleep(5000); // what putting it away does, such as saving, is done
      }
      const area = hidden ? "Put away" : "On screen, untouched";
      const key = hidden ? "hidden" : "idle";
      await page.evaluate(() => { window.__wake.timers = 0; window.__wake.frames = 0; });
      const cpu = await p.busy();
      m = wire.mark();
      await sleep(IDLE * 1000);
      w = wire.since(m);
      const wake = await page.evaluate(() => ({ ...window.__wake, moving: document.getAnimations().filter(a => a.playState === "running").length }));
      const perMin = x => (x * 60) / IDLE;
      note(area, key + "Requests", `Requests a minute, ${label}`, perMin(w.requests.filter(r => !/\/live$/.test(r)).length), "");
      note(area, key + "Wire", `Bytes a minute over the wire, the live connection's pings included`, perMin(w.up + w.down) * 1024, "B");
      note(area, key + "Wakeups", "Timers and frames a minute", perMin(wake.timers + wake.frames), "");
      note(area, key + "Cpu", "Time spent running, a minute", perMin((await p.busy()) - cpu), "ms");
      note(area, key + "Moving", "Animations still running", wake.moving, "");
    }
    if (p.errors.length) console.log("Errors in the page:\n" + p.errors.join("\n"));
  } finally {
    await browser.close();
    wire.stop();
  }
}

/* ---------- The report ---------- */

function report(dev) {
  const before = process.env.BEFORE ? Object.fromEntries(JSON.parse(readFileSync(process.env.BEFORE, "utf8")).results.map(r => [r.key, r.value])) : null;
  let area = "";
  const fmt = (v, unit) => (unit === "KB" || unit === "ms" || unit === "B" ? v.toLocaleString("en-GB", { maximumFractionDigits: 1 }) + " " + unit : v.toLocaleString("en-GB", { maximumFractionDigits: 1 }) + (unit ? " " + unit : ""));
  let over = 0;
  for (const r of results) {
    if (r.area !== area) { area = r.area; console.log("\n" + area); }
    const b = BUDGET[r.key], was = before && r.key in before ? before[r.key] : null;
    const flag = b !== undefined && r.value > b ? `  OVER BUDGET (${fmt(b, r.unit)})` : b !== undefined ? `  budget ${fmt(b, r.unit)}` : "";
    if (flag.includes("OVER")) over++;
    const diff = was === null ? "" : `  was ${fmt(was, r.unit)}`;
    console.log(`  ${r.label.padEnd(66)} ${fmt(r.value, r.unit).padStart(12)}${diff}${flag}`);
  }
  if (dev) console.log("\nThis server runs a copy stamped \"dev\", which fetches the app's files afresh each time:\nopening the app again counts them, unlike a release.");
  console.log(over ? `\n${over} over budget.` : "\nEverything within budget.");
  if (process.env.OUT) {
    let commit = "";
    try { commit = execFileSync("git", ["describe", "--always", "--dirty"], { cwd: ROOT }).toString().trim(); } catch (_) {}
    writeFileSync(process.env.OUT, JSON.stringify({ date: new Date().toISOString(), commit, idle: IDLE, items: ITEMS, ticked: TICKED, results }, null, 1) + "\n");
  }
}

files();
code();
const server = process.env.BASE ? { base: process.env.BASE, setup: process.env.SETUP } : await goServer();
if (!server.setup) throw new Error("set SETUP to the server's setup code");
let dev = false;
try {
  dev = /^const VERSION = "dev";/m.test(await (await fetch(server.base + "/sw.js")).text());
  await measure(server);
} finally { if (server.stop) server.stop(); }
report(dev);
