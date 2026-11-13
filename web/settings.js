// Settings, a page of its own over the lists page.

import * as store from "./store.js";
import { t, lang } from "./i18n.js";
import { toMarkdown } from "./md.js";
import { clean, MAX_SECTION, sheetOfList } from "./model.js";
import { $, h, download } from "./dom.js";
import { openSheet, closeThen } from "./sheets.js";
import { openPair } from "./share.js";

const THEME_KEY = "panier-theme", LAYOUT_KEY = "panier-layout";
// Asks the browser to keep the lists even when the phone runs low on space. Firefox
// asks you once; Chrome decides for itself. Returns whether they're kept, or null if unknown.
export async function keepList() {
  try { return await navigator.storage.persist(); } catch (_) { return null; }
}
async function isKept() {
  try { return await navigator.storage.persisted(); } catch (_) { return null; }
}
const size = n => (n < 1024 ? t("{n} bytes", { n }) : n < 1048576 ? t("{n} KB", { n: Math.round(n / 1024) })
  : t("{n} MB", { n: (n / 1048576).toLocaleString(lang, { maximumFractionDigits: 1 }) }));
// Fills in what's known at once, then what the browser has to look up.
async function paintSettings() {
  const theme = (() => { try { return localStorage.getItem(THEME_KEY) || ""; } catch (_) { return ""; } })();
  for (const r of document.querySelectorAll('input[name="theme"]')) r.checked = r.value === theme;
  $("#compact-layout").checked = document.documentElement.dataset.layout === "compact";
  $("#my-name").value = store.myName();
  const all = store.lists();
  $("#sizes").replaceChildren(...all.map(e => h("li", {}, h("span", {}, e.name || t("Shopping list")), h("span", {}, size(store.storedSize(e.lid))))));
  $("#export-all").hidden = $("#phone-open").hidden = !all.length;
  $("#about-server").textContent = location.host;
  const [kept, keys] = await Promise.all([isKept(), caches.keys().catch(() => [])]);
  $("#keep-text").textContent = kept
    ? t("Kept on this phone: the browser won't clear your lists to free up space.")
    : t("If this phone runs low on space, the browser may clear your lists; their links bring them back.");
  $("#keep-btn").hidden = kept !== false;
  const k = keys.find(k => k.startsWith("panier-") && !k.startsWith("panier-static-"));
  $("#about-version").textContent = k ? k.slice(7) : "dev";
}
$("#settings-open").addEventListener("click", () => { paintSettings(); openSheet($("#settings")); });
$("#settings-close").addEventListener("click", () => $("#settings").close());
// Compact: every row 44 px, with smaller gaps and titles, on this phone only.
$("#compact-layout").addEventListener("change", e => {
  const l = e.target.checked ? "compact" : "";
  try { if (l) localStorage.setItem(LAYOUT_KEY, l); else localStorage.removeItem(LAYOUT_KEY); } catch (_) {}
  if (window.panierLayout) window.panierLayout(l);
});
for (const r of document.querySelectorAll('input[name="theme"]')) {
  r.addEventListener("change", () => {
    try { if (r.value) localStorage.setItem(THEME_KEY, r.value); else localStorage.removeItem(THEME_KEY); } catch (_) {}
    if (window.panierTheme) window.panierTheme(r.value);
  });
}
$("#my-name").addEventListener("change", e => store.setMyName(clean(e.target.value, MAX_SECTION)));
$("#my-name").addEventListener("keydown", e => { if (e.key === "Enter") e.target.blur(); });
$("#keep-btn").addEventListener("click", async () => { await keepList(); paintSettings(); });
$("#phone-open").addEventListener("click", () => closeThen($("#settings"), () => openPair(true)));

function exportAll() {
  download("Panier", toMarkdown(store.lists().map(e => sheetOfList(store.peek(e.lid)))));
}

$("#export-all").addEventListener("click", exportAll);
