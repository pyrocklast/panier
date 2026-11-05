// Updating: two builds of the Go server, with the service worker stamped "old" and "new",
// swapped while a phone has the app open, as a deploy would.
//
//   PANIER_OLD=./panier-old PANIER_NEW=./panier-new node --test test/update.test.mjs
//
// Build them with VERSION in web/sw.js set to "old" and "new". Needs Playwright with Chromium.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const OLD = process.env.PANIER_OLD, NEW = process.env.PANIER_NEW;
const ADDR = "127.0.0.1:8099", BASE = "http://" + ADDR;

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function eventually(fn, ms = 6000) {
  const end = Date.now() + ms;
  for (;;) {
    try { if (await fn()) return true; } catch (_) {}
    if (Date.now() > end) return false;
    await sleep(100);
  }
}
async function serve(bin, data) {
  const p = spawn(bin, ["-data", data, "-addr", ADDR], { stdio: "ignore" });
  assert.ok(await eventually(async () => (await fetch(BASE + "/")).ok), "the server starts");
  return p;
}
async function stop(p) {
  p.kill();
  await new Promise(r => p.once("exit", r));
}

test("a new version takes over in the same launch, once you've stopped typing", { skip: !OLD || !NEW }, async () => {
  const { chromium } = require("playwright");
  const data = mkdtempSync(join(tmpdir(), "panier-update-"));
  const code = execFileSync(OLD, ["-data", data, "-setup-code"]).toString().trim();
  let server = await serve(OLD, data);
  const browser = await chromium.launch();
  const errors = [];
  try {
    const page = await (await browser.newContext({ viewport: { width: 390, height: 844 } })).newPage();
    page.on("pageerror", e => errors.push(String(e)));
    await page.goto(BASE + "/#setup=" + code);
    await page.locator("#pair").waitFor();
    await page.click("#pair-close");
    await page.fill("#add-ess", "Milk");
    await page.press("#add-ess", "Enter");
    assert.ok(await eventually(async () => (await page.evaluate(() => caches.keys())).includes("panier-old")));

    // Deploy: the new build replaces the old one while the app stays open.
    await stop(server);
    server = await serve(NEW, data);
    await page.evaluate(() => { window.stillThisPage = true; });
    await page.fill("#add-ess", "Half-typ");
    await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange"))); // coming back to the app
    assert.ok(await eventually(async () => {
      const keys = await page.evaluate(() => caches.keys());
      return keys.includes("panier-new") && !keys.includes("panier-old");
    }), "the new version installs");
    await sleep(1500);
    assert.equal(await page.evaluate(() => window.stillThisPage), true, "no reload while typing");

    await page.press("#add-ess", "Enter");
    await page.evaluate(() => document.activeElement.blur());
    assert.ok(await eventually(() => page.evaluate(() => window.stillThisPage === undefined), 5000), "reloads into the new version");
    await page.locator("#app").waitFor();
    assert.deepEqual(await page.locator('.sec[data-sec="ess"] .items .text').allInnerTexts(), ["Milk", "Half-typ"], "the list is intact");
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
    await stop(server);
  }
});
