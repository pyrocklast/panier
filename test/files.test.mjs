// The app's scripts are plain modules with no build step, so nothing gathers them: the
// service worker must list each one to keep it offline, and the page asks for each ahead
// of time. Run with: node --test test/files.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";

const web = new URL("../web/", import.meta.url);
const read = f => readFileSync(new URL(f, web), "utf8");
const scripts = readdirSync(web).filter(f => f.endsWith(".js") && f !== "sw.js").sort();
const modules = scripts.filter(f => f !== "theme.js"); // theme.js is a plain script, in the page's head

test("the service worker keeps every script", () => {
  const files = JSON.parse(/^const FILES = (\[.*\]);$/m.exec(read("sw.js"))[1]);
  assert.deepEqual(files.filter(f => f.endsWith(".js")).sort(), scripts);
});

test("the page asks for every module at once", () => {
  const html = read("index.html");
  const asked = [...html.matchAll(/<link rel="modulepreload" href="([^"]+)">/g)].map(m => m[1]);
  assert.deepEqual([...asked, "app.js"].sort(), modules);
});

test("every module imports only what the others export", () => {
  const exported = f => new Set([...read(f).matchAll(/^export (?:async )?(?:function|const|let|class) ([\w$]+)/gm)].map(m => m[1]));
  for (const f of modules) {
    const src = read(f).replace(/\/\/.*$/gm, ""); // comments name files too
    for (const m of src.matchAll(/^import (?:\{([^}]+)\}|\* as (\w+)) from "\.\/([\w.]+)";$/gm)) {
      assert.ok(modules.includes(m[3]), f + " imports " + m[3]);
      const names = m[1] ? m[1].split(",").map(s => s.trim()).filter(Boolean) : [...src.matchAll(new RegExp("(?<![/\\w])" + m[2] + "\\.(\\w+)", "g"))].map(u => u[1]);
      for (const name of names) assert.ok(exported(m[3]).has(name), f + " uses " + name + " from " + m[3]);
    }
  }
});
