// Settings, the app's, a page of its own over the lists page; and a list's own settings,
// a page over the list. Each opens from Settings at the top right of the page it's about.

import * as store from "./store.js";
import { t, plural, lang } from "./i18n.js";
import { toMarkdown } from "./md.js";
import { clean, MAX_SECTION, LIST_COLORS, sheetOfList } from "./model.js";
import { $, download } from "./dom.js";
import { openSheet } from "./sheets.js";
import { state, nav, readOnly, listName, listColor, tickedDays } from "./state.js";
import { openPair, people } from "./share.js";
import { palette } from "./edit.js";
import * as list from "./list.js";
import { keepers } from "./lists.js";

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
  // The lists, in one line: how many, the room they take here, and whether the browser
  // keeps them. Each list's own is in its settings, with its export.
  const all = store.lists(), room = all.reduce((n, e) => n + store.storedSize(e.lid), 0);
  $("#data-sum").hidden = $("#export-all").hidden = $("#phone-open").hidden = !all.length;
  $("#data-size").textContent = t("{n}, {x} on this phone.", { n: plural(all.length, "{n} list", "{n} lists"), x: size(room) });
  $("#about-server").textContent = location.host;
  const [kept, keys] = await Promise.all([isKept(), caches.keys().catch(() => [])]);
  $("#keep-text").textContent = kept ? t("The browser won't clear your lists to free up space.")
    : t("If this phone runs low on space, the browser may clear your lists; their links bring them back.");
  $("#keep-btn").hidden = kept !== false;
  const k = keys.find(k => k.startsWith("panier-") && !k.startsWith("panier-static-"));
  $("#about-version").textContent = k ? k.slice(7) : "dev";
}
// Each settings is a page of its own: the page turns into it from its button, and back
// from its arrow, or with Escape.
function page(id, paint) {
  const dlg = $("#" + id), from = () => $("#" + id + "-open");
  const close = () => nav.turn(false, () => dlg.close(), from);
  from().addEventListener("click", () => nav.turn(true, () => { paint(); openSheet(dlg); }, from));
  $("#" + id + "-close").addEventListener("click", close);
  dlg.addEventListener("cancel", e => { e.preventDefault(); close(); });
}
page("settings", paintSettings);
// Compact: every row 44 px, with smaller gaps and titles, on this phone only.
$("#compact-layout").addEventListener("change", e => {
  const l = e.target.checked ? "compact" : "";
  try { if (l) localStorage.setItem(LAYOUT_KEY, l); else localStorage.removeItem(LAYOUT_KEY); } catch (_) {}
  window.panierLayout(l);
});
for (const r of document.querySelectorAll('input[name="theme"]')) {
  r.addEventListener("change", () => {
    try { if (r.value) localStorage.setItem(THEME_KEY, r.value); else localStorage.removeItem(THEME_KEY); } catch (_) {}
    window.panierTheme(r.value);
  });
}
$("#my-name").addEventListener("change", e => store.setMyName(clean(e.target.value, MAX_SECTION)));
$("#my-name").addEventListener("keydown", e => { if (e.key === "Enter") e.target.blur(); });
$("#keep-btn").addEventListener("click", async () => { await keepList(); paintSettings(); });
$("#phone-open").addEventListener("click", () => openPair(true)); // over Settings, which it closes back onto

// Every list in one file, from Settings; or the open one, from its settings.
$("#export-all").addEventListener("click", () => download("Panier", toMarkdown(store.lists().map(e => sheetOfList(store.peek(e.lid))))));
$("#export-list").addEventListener("click", () => {
  const sheet = sheetOfList(store.peek(state.lid));
  download(sheet.name, toMarkdown([sheet]));
});

/* ---------- A list's settings ---------- */

// What everyone on the list shares: its name and colour, how long its ticked items stay
// in view, who's on it; then exporting or deleting it. A closed list's can only be read.
// Deleting says what each way does: from this phone, when someone else keeps it, beside
// for everyone; or, when nobody else has it, or it's closed, deleting it for good.
export function paintListSettings() {
  const ro = readOnly(), rename = $("#list-rename");
  $("#list-settings-close").setAttribute("aria-label", listName());
  if (document.activeElement !== rename) rename.value = store.listName() || "";
  rename.disabled = ro;
  // The colours are drawn again only when what they show changes, so what the other
  // phones do meanwhile leaves the cursor on them.
  const colours = $("#list-colours"), drawn = ro ? "" : listName() + "\n" + listColor();
  if (colours.dataset.drawn !== drawn) {
    colours.dataset.drawn = drawn;
    colours.replaceChildren(...(ro ? [] : [palette(listName(), LIST_COLORS, listColor(), list.recolourList)]));
  }
  const days = tickedDays();
  for (const r of document.querySelectorAll('input[name="ticked"]')) { r.checked = +r.value === days; r.disabled = ro; }
  $("#list-people").textContent = people();
  $("#pair-open").hidden = ro; // a closed list's link opens nothing
  $("#list-size").textContent = t("{x} on this phone.", { x: size(store.storedSize(state.lid)) });
  const e = store.entryOf(state.lid), k = e && !e.closed && keepers(e);
  $("#delete-here-name").textContent = k ? t("Delete from this phone") : t("Delete the list");
  $("#delete-here-what").textContent = k ? t(k.n === 1 ? "{x} keeps it, and can share it with you again" : "{x} keep it, and can share it with you again", { x: k.who })
    : e && e.closed ? t("What's left here goes for good") : t("Nobody else has it: it goes for good, from the server too");
  $("#delete-all").hidden = !k;
}
page("list-settings", paintListSettings);
// A name left empty goes back to what it was.
$("#list-rename").addEventListener("change", e => {
  const name = clean(e.target.value, MAX_SECTION);
  if (name) list.renameList(name);
  e.target.value = store.listName() || "";
});
$("#list-rename").addEventListener("keydown", e => { if (e.key === "Enter") e.target.blur(); });
for (const r of document.querySelectorAll('input[name="ticked"]')) r.addEventListener("change", () => list.setTicked(+r.value));
