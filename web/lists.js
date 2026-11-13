// The lists page. Each list lies on it as a sheet of its own paper, the sheets side by
// side: its name, who else has it, the first three things to get and how many there are,
// as this phone last saw them. Tap one to open it; hold to drag it to another place, or
// onto the zone at the foot to delete it. The blank sheet at the end starts a new list.

import * as store from "./store.js";
import { t, plural, q, lang } from "./i18n.js";
import { fromMarkdown } from "./md.js";
import { state, nav, draftsKey } from "./state.js";
import { clean, MAX_SECTION, listColorOk, importOps } from "./model.js";
import { $, h, fillText, addRow, emptyField, announce, activeFk, buzz, setRows } from "./dom.js";
import { bindPress, beginDrag } from "./press.js";
import { float } from "./motion.js";
import { noteUndo, paintDock } from "./bar.js";
import { confirmSheet } from "./sheets.js";
import { openPair } from "./share.js";
import { keepList } from "./settings.js";

// Who else has a list, in a few quiet words under its name: two names at most, then a count.
function withOf(e) {
  const w = e.with;
  if (!w || (!w.names.length && !w.nameless)) return "";
  const names = w.names.slice(0, 2), more = w.names.length - names.length + w.nameless;
  const who = names.length ? [...names, ...(more ? [plural(more, "{n} other", "{n} others")] : [])] : [plural(more, "{n} other phone", "{n} other phones")];
  return t("with {x}", { x: new Intl.ListFormat(lang, { type: "conjunction" }).format(who) });
}
const countOf = e => (e.closed ? t("Closed") : e.newer ? t("Update Panier to open it") : e.toGet ? plural(e.toGet, "{n} to get", "{n} to get") : t("Nothing to get"));
// Each sheet keeps its element from one drawing to the next, and only what changed is
// written, so a sheet held or focused stays as it is while the lists catch up.
const cards = new Map(); // list id → { li, btn, name, who, first, count, shown }
const newSheet = $("#new-sheet"); // the blank sheet, always last
function cardOf(e) {
  let c = cards.get(e.lid);
  if (!c) {
    const name = h("span", { class: "sheet-name" }), who = h("span", { class: "sheet-with" }), first = h("span", { class: "sheet-first" }), count = h("span", { class: "sheet-count" });
    const btn = h("button", { type: "button", class: "sheet-open", dataset: { fk: "sheet-" + e.lid } },
      h("span", { class: "sheet-in", "aria-hidden": "true" }, name, who, first, count));
    const li = h("li", { class: "sheet-card", "data-lid": e.lid }, btn);
    btn.addEventListener("click", () => { if (state.suppressClick) { state.suppressClick = false; return; } nav.showList(e.lid); });
    btn.addEventListener("keydown", ev => {
      const dir = { ArrowUp: -1, ArrowLeft: -1, ArrowDown: 1, ArrowRight: 1 }[ev.key];
      if (ev.altKey && dir) { ev.preventDefault(); moveSheet(e.lid, dir); }
      else if (ev.key === "Delete" || ev.key === "Backspace") { ev.preventDefault(); askDelete(e.lid); }
    });
    bindPress(li, { can: () => true, start: (offY, y, offX, x) => startSheetDrag(li, e.lid, offY, y, offX, x) });
    cards.set(e.lid, (c = { li, btn, name, who, first, count, shown: "" }));
  }
  const nm = e.name || t("Shopping list"), cnt = countOf(e), gone = !!(e.closed || e.newer), first = gone ? [] : e.first || [];
  const w = gone ? "" : withOf(e);
  const shown = JSON.stringify([nm, cnt, first, e.color, gone, w]);
  if (c.shown !== shown) {
    c.shown = shown;
    c.name.textContent = nm;
    c.who.textContent = w;
    c.who.hidden = !w;
    c.count.textContent = cnt;
    c.first.replaceChildren(...first.map(x => { const sp = h("span"); fillText(sp, x); return h("span", { class: "sheet-item" }, sp); }));
    c.btn.setAttribute("aria-label", [nm, w, cnt].filter(Boolean).join(", "));
    const col = listColorOk(e.color);
    if (col) c.li.dataset.color = col; else delete c.li.dataset.color;
    c.li.classList.toggle("gone", gone);
  }
  return c.li;
}
// The page asks for the setup code for the first list, or when the server won't make one
// otherwise; notice says what went wrong last, until the next thing tried.
let needCode = false, notice = "";
export function renderLists() {
  if (state.view !== "lists" || state.drag) return;
  const fk = activeFk(), all = store.lists(), first = !all.length;
  setRows($("#sheets"), [...all.map(cardOf), newSheet]);
  for (const lid of cards.keys()) if (!all.some(e => e.lid === lid)) cards.delete(lid);
  $("#sheets").hidden = first;
  $("#setup-form").hidden = !first && !needCode;
  const msg = notice || (needCode ? t("This server wants its setup code for this.")
    : first ? t("Open the link from a phone that already has a list, or start one with your server's setup code.") : "");
  $("#lists-msg").textContent = msg;
  $("#lists-msg").hidden = !msg;
  $("#setup-label").textContent = first ? t("Your server's setup code, to start the first list") : t("Your server's setup code");
  if (fk) { const el = document.querySelector('[data-fk="' + fk + '"]'); if (el && el !== document.activeElement) el.focus({ preventScroll: true }); }
  paintDock();
}
export const say = msg => { notice = msg; renderLists(); announce(msg); };

// Sheets lie side by side, so a dragged one follows the finger both ways, and goes before
// the first sheet it's left of, on its row, or above.
function startSheetDrag(li, lid, offY, y, offX, x) {
  const rect = li.getBoundingClientRect(), ghost = float(li.cloneNode(true), rect, "ghost", y - offY);
  Object.assign(ghost.style, { left: x - offX + "px", height: rect.height + "px" });
  li.classList.add("placeholder");
  document.documentElement.classList.add("dragging-sheet");
  const before = store.lists().map(e => e.lid).join();
  // The page scrolls before the zone at the foot, not over it, so a sheet can go last.
  const bottom = $("#remove-drop").getBoundingClientRect().top - 8;
  beginDrag({ lid, li, ghost, offY, y, offX, x, toRemove: false, before, bottom, place: placeSheet, end: endSheetDrag });
}
function placeSheet(y, x) {
  const zone = $("#remove-drop"), over = y > zone.getBoundingClientRect().top - 8;
  if (over !== state.drag.toRemove) {
    state.drag.toRemove = over;
    zone.classList.toggle("over", over);
    state.drag.li.classList.toggle("away", over);
    state.drag.ghost.classList.toggle("leaving", over);
    if (over) buzz(8);
  }
  if (over) return;
  const ul = $("#sheets"), gap = 6; // half the space between sheets
  let before = newSheet;
  for (const c of ul.children) {
    if (c === state.drag.li || c === newSheet) continue;
    const r = c.getBoundingClientRect();
    if (y < r.top - gap || (y <= r.bottom + gap && x < r.left + r.width / 2)) { before = c; break; }
  }
  if (state.drag.li.nextElementSibling !== before) ul.insertBefore(state.drag.li, before);
}
function endSheetDrag() {
  const { lid, li, toRemove, ghost, before } = state.drag;
  const order = [...$("#sheets").children].map(c => c.dataset.lid).filter(Boolean);
  ghost.remove();
  li.classList.remove("placeholder", "away"); // the same sheet stays on the page
  $("#remove-drop").classList.remove("over");
  document.documentElement.classList.remove("dragging-sheet");
  state.drag = null;
  if (!toRemove && order.join() !== before) store.reorder(order);
  renderLists();
  if (toRemove) askDelete(lid);
}
function moveSheet(lid, dir) {
  const order = store.lists().map(e => e.lid), i = order.indexOf(lid), j = i + dir;
  if (j < 0 || j >= order.length) return;
  [order[i], order[j]] = [order[j], order[i]];
  store.reorder(order);
  const e = store.lists().find(x => x.lid === lid);
  announce(t(dir < 0 ? "{x} moved earlier" : "{x} moved later", { x: e.name || t("Shopping list") }));
  renderLists();
  const el = document.querySelector('[data-fk="sheet-' + lid + '"]');
  if (el) el.focus();
}

// A list is deleted only here, on the lists page, dropped on the zone at the foot or with
// the Delete key, and only once asked. From this phone, the others keep it and its link
// brings it back, and undo does too, until the app closes. For everyone, it asks again,
// as nothing brings it back.
function askDelete(lid) {
  const e = store.lists().find(x => x.lid === lid);
  if (!e) return;
  const name = e.name || t("Shopping list"), w = e.with, others = !!(w && (w.names.length || w.nameless));
  confirmSheet({
    title: t("Delete {x}?", { x: q(name) }),
    text: e.closed ? t("It's closed already: this takes what's left of it off this phone.")
      : others ? t("It goes from this phone only: the others keep it.")
      : t("It goes from this phone. Its link brings it back, if you kept one."),
    ok: t("Delete"),
    run: () => { $("#confirm").close(); removeList(lid); },
    more: e.closed ? null : { label: t("Delete for everyone"), run: () => confirmSheet({
      title: t("Delete {x} for everyone?", { x: q(name) }),
      text: t("It goes from the server, and from every phone that has it as soon as they open it. This can't be undone."),
      ok: t("Delete for everyone"),
      run: async () => {
        await store.deleteForEveryone(lid);
        $("#confirm").close();
        announce(t("Deleted {x} for everyone", { x: name }));
        lostFocus($("#sheets .sheet-open") || $("#new-list"));
      },
    }) },
  });
}
// The sheet that had the cursor is gone: it goes to el.
const lostFocus = el => { if (!document.activeElement || document.activeElement === document.body) el.focus({ preventScroll: true }); };
function removeList(lid) {
  const e = store.lists().find(x => x.lid === lid);
  if (!e) return;
  const name = e.name || t("Shopping list"), dk = draftsKey(lid);
  let drafts = null;
  try { drafts = localStorage.getItem(dk); localStorage.removeItem(dk); } catch (_) {}
  state.removed.push({ label: t("deleting {x}", { x: q(name) }), r: store.remove(lid), drafts, dk });
  noteUndo(name);
  announce(t("Deleted {x} from this phone", { x: name }));
  renderLists();
  lostFocus($("#undo")); // which would bring it back
}
export function undoRemove() {
  const u = state.removed.pop();
  if (!u) return;
  store.restore(u.r);
  try { if (u.drafts) localStorage.setItem(u.dk, u.drafts); } catch (_) {}
  noteUndo(null);
  announce(t("Undid {x}", { x: u.label }));
  renderLists();
}

// A new list starts from a name, typed on the blank sheet. The server makes it on the
// strength of a list this phone already has there; the first needs the setup code, and
// so does any other the server won't make that way. create keeps what was asked for
// while the code is typed.
let pending = null, creating = false;
async function create(make, done) {
  if (creating) return; // Enter twice makes one list
  creating = true;
  notice = "";
  try {
    const r = await make(null);
    pending = null;
    done(r);
  } catch (err) {
    if (err.message !== "code") return say(MESSAGES.server);
    pending = { make, done };
    needCode = store.lists().length > 0;
    renderLists();
    $("#setup-code").focus();
  } finally {
    creating = false;
  }
}
// The name stays in the field until the list is made: the server may not answer.
addRow($("#new-list-form"), $("#new-list"), {
  add: () => {
    const name = clean($("#new-list").value, MAX_SECTION);
    if (name) create(code => store.createList({ code, name }), lid => { emptyField($("#new-list")); announce(t("Added {x}", { x: name })); nav.showList(lid); });
  },
});
export const MESSAGES = {
  code: t("That setup code didn't work. Check it on the server and try again."),
  link: t("That link is incomplete. Ask for the link again from the phone that has the list."),
  server: t("Couldn't reach the server. Check your connection and try again."),
};
$("#setup-form").addEventListener("submit", async e => {
  e.preventDefault();
  const code = $("#setup-code").value;
  if (!code.trim() || creating) return;
  creating = true;
  const p = pending || { make: c => store.createList({ code: c }), done: lid => { nav.showList(lid); openPair(); keepList(); } };
  try {
    const r = await p.make(code);
    pending = null;
    needCode = false;
    notice = "";
    $("#setup-code").value = "";
    p.done(r);
  } catch (err) {
    say(MESSAGES[err.message] || MESSAGES.server);
  } finally {
    creating = false;
  }
});

$("#import-open").addEventListener("click", () => $("#import-file").click());
$("#import-file").addEventListener("change", async e => {
  const f = e.target.files && e.target.files[0];
  e.target.value = "";
  if (!f) return;
  let text = "";
  try { text = await f.text(); } catch (_) {}
  const { lists } = fromMarkdown(text);
  if (!lists.length) return say(t("There's no list to bring in from {x}.", { x: f.name }));
  const made = lists.map(importOps);
  create(async code => {
    const lids = [];
    for (const m of made) { lids.push(await store.createFrom(m.ops, { code })); code = null; }
    return lids;
  }, lids => {
    const n = made.reduce((a, m) => a + m.n, 0);
    announce(lids.length > 1 ? t("Brought in {x}", { x: plural(lids.length, "{n} list", "{n} lists") }) : t("Brought in {x}", { x: plural(n, "{n} item", "{n} items") }));
    if (lids.length === 1) nav.showList(lids[0]);
    else renderLists();
  });
});
// Opening a list clears what was last said here; coming back from one, the cursor returns
// to its sheet.
export const clearNotice = () => { notice = ""; };
export const sheetButton = lid => cards.has(lid) && cards.get(lid).btn;
// Whether something is being typed here, which an update waits for.
export const typing = () => !!($("#new-list").value.trim() || $("#setup-code").value.trim());
