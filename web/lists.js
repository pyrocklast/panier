// The lists page. Each list lies on it as a sheet of its own paper, the sheets side by
// side: its name, who else has it, the first three things to tick and how many there are,
// as this phone last saw them. Tap one to open it; hold to drag it to another place. A
// list is deleted in its own settings. The blank strip under them starts a new list.

import * as store from "./store.js";
import { t, plural, q, and, lang } from "./i18n.js";
import { fromMarkdown } from "./md.js";
import { readKeep } from "./googlekeep.js";
import { state, nav, draftsKey } from "./state.js";
import { clean, MAX_SECTION, listColorOk, importOps, startOps, listTitle } from "./model.js";
import { $, h, fillText, addRow, emptyField, announce, activeFk, setRows, reduceMotion } from "./dom.js";
import { bindPress, beginDrag } from "./press.js";
import { float, fly, shuffle } from "./motion.js";
import { paintDock } from "./bar.js";
import { confirmSheet, openSheet } from "./sheets.js";
import { keepList } from "./settings.js";
import { editName } from "./list.js";

// Who else has a list, in a few quiet words under its name: two names at most, then a count.
function withOf(e) {
  const w = e.with;
  if (!w || (!w.names.length && !w.nameless)) return "";
  const names = w.names.slice(0, 2), more = w.names.length - names.length + w.nameless;
  const who = names.length ? [...names, ...(more ? [plural(more, "{n} other", "{n} others")] : [])] : [plural(more, "{n} other phone", "{n} other phones")];
  return t("with {x}", { x: and(who) });
}
// Why a list closed, in a word: deleted for everyone, moved to a new key, or, closed by an
// app from before phones said, either.
const goneWord = e => t(e.why === "deleted" ? "Deleted" : e.why === "moved" ? "New key" : "Deleted or moved");
const countOf = e => (e.closed ? goneWord(e) : e.newer ? t("Update Panier to open it") : e.toGet ? plural(e.toGet, "{n} to tick", "{n} to tick") : t("Nothing to tick"));
// Each sheet keeps its element from one drawing to the next, and only what changed is
// written, so a sheet held or focused stays as it is while the lists catch up.
const cards = new Map(); // list id → { li, btn, name, who, first, count, shown }
function cardOf(e) {
  let c = cards.get(e.lid);
  if (!c) {
    const name = h("span", { class: "sheet-name" }), who = h("span", { class: "sheet-with" }), first = h("span", { class: "sheet-first" }), count = h("span", { class: "sheet-count" });
    const btn = h("button", { type: "button", class: "sheet-open", dataset: { fk: "sheet-" + e.lid } },
      h("span", { class: "sheet-in", "aria-hidden": "true" }, name, who, first, count));
    const li = h("li", { class: "sheet-card", "data-lid": e.lid }, btn);
    btn.addEventListener("click", () => { if (state.suppressClick) { state.suppressClick = false; return; } nav.turn(true, () => nav.showList(e.lid), () => btn); });
    btn.addEventListener("keydown", ev => {
      const dir = { ArrowUp: -1, ArrowLeft: -1, ArrowDown: 1, ArrowRight: 1 }[ev.key];
      if (ev.altKey && dir) { ev.preventDefault(); moveSheet(e.lid, dir); }
    });
    bindPress(li, { can: () => true, start: (offY, y, offX, x) => startSheetDrag(li, e.lid, offY, y, offX, x) });
    cards.set(e.lid, (c = { li, btn, name, who, first, count, shown: "" }));
  }
  const nm = listTitle(e.name), cnt = countOf(e), gone = !!(e.closed || e.newer), first = gone ? [] : e.first || [];
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
  setRows($("#sheets"), all.map(cardOf));
  for (const lid of cards.keys()) if (!all.some(e => e.lid === lid)) cards.delete(lid);
  $("#new-list-form").hidden = first;
  $("#setup-form").hidden = !first && !needCode;
  const msg = notice || (needCode ? t("This server asks for its setup code to make a list.")
    : first ? t("Open the link from a phone that already has a list, or start one with your server's setup code.") : "");
  $("#lists-msg").textContent = msg;
  $("#lists-msg").hidden = !msg;
  $("#setup-label").textContent = first ? t("Your server's setup code, to start the first list") : t("Your server's setup code");
  if (fk) { const el = document.querySelector('[data-fk="' + fk + '"]'); if (el && el !== document.activeElement) el.focus({ preventScroll: true }); }
  paintDock();
}
export const say = msg => { notice = msg; renderLists(); announce(msg); };

const SHEETS = "#sheets > .sheet-card";
// Sheets lie side by side, so a dragged one follows the finger both ways, and goes before
// the first sheet it's left of, on its row, or above.
function startSheetDrag(li, lid, offY, y, offX, x) {
  const rect = li.getBoundingClientRect(), ghost = float(li.cloneNode(true), rect, "ghost", y - offY);
  Object.assign(ghost.style, { left: x - offX + "px", height: rect.height + "px" });
  li.classList.add("placeholder");
  document.documentElement.classList.add("dragging-sheet");
  const before = store.lists().map(e => e.lid).join();
  beginDrag({ lid, li, ghost, offY, y, offX, x, before, place: placeSheet, end: endSheetDrag });
}
function placeSheet(y, x) {
  const ul = $("#sheets"), gap = 6; // half the space between sheets
  let before = null;
  for (const c of ul.children) {
    if (c === state.drag.li) continue;
    const r = c.getBoundingClientRect();
    if (y < r.top - gap || (y <= r.bottom + gap && x < r.left + r.width / 2)) { before = c; break; }
  }
  if (state.drag.li.nextElementSibling !== before) shuffle(SHEETS, () => ul.insertBefore(state.drag.li, before)); // the others glide aside
}
function endSheetDrag() {
  const { li, ghost, before } = state.drag;
  const order = [...$("#sheets").children].map(c => c.dataset.lid);
  const from = ghost.getBoundingClientRect();
  li.classList.remove("placeholder"); // the same sheet stays on the page
  document.documentElement.classList.remove("dragging-sheet");
  state.drag = null;
  if (order.join() !== before) store.reorder(order);
  renderLists();
  if (reduceMotion.matches) ghost.remove();
  else fly({ li: ghost, rect: from, part: null }, li.getBoundingClientRect(), li); // it settles into its place
}
function moveSheet(lid, dir) {
  const order = store.lists().map(e => e.lid), i = order.indexOf(lid), j = i + dir;
  if (j < 0 || j >= order.length) return;
  [order[i], order[j]] = [order[j], order[i]];
  shuffle(SHEETS, () => { store.reorder(order); renderLists(); }); // the store redraws the page as it changes
  announce(t(dir < 0 ? "{x} moved earlier" : "{x} moved later", { x: listTitle(store.entryOf(lid).name) }));
  const el = document.querySelector('[data-fk="sheet-' + lid + '"]');
  if (el) el.focus();
}

// A list is deleted in its own settings, and nothing brings it back, so each way asks
// first and says exactly what happens: one question where someone else keeps it and can
// share it again; a button held where nothing can bring it back (sheets.js).

// Who else is on a list, for those words: the names they gave, then the phones without
// one, and a phone with this phone's own name is your other phone; n, how many in all.
// Null when nobody else is.
export function keepers(e) {
  const w = e.with || { names: [], nameless: 0 }, mine = store.myName();
  const own = mine ? w.names.filter(n => n === mine).length : 0, named = w.names.filter(n => !mine || n !== mine);
  const n = named.length + w.nameless + own;
  if (!n) return null;
  const who = and([...named, ...(w.nameless ? [plural(w.nameless, "{n} other phone", "{n} other phones")] : []),
    ...(own ? [plural(own, "your other phone", "your {n} other phones")] : [])]);
  return { who: who.charAt(0).toLocaleUpperCase(lang) + who.slice(1), n };
}
// everyone: Delete for everyone, rather than from this phone.
export function askDelete(lid, everyone = false) {
  const e = store.entryOf(lid);
  if (!e) return;
  const name = listTitle(e.name), k = !e.closed && keepers(e);
  const done = msg => {
    try { localStorage.removeItem(draftsKey(lid)); } catch (_) {} // what was typed in it goes too
    $("#confirm").close();
    announce(msg);
    lostFocus($("#sheets .sheet-open") || (!$("#new-list-form").hidden && $("#new-list")));
  };
  if (everyone) return confirmSheet({
    title: t("Delete {x} for everyone?", { x: q(name) }),
    text: t("It goes from the server, and nobody can change it any more. The others' phones keep what they have, to read or export, until they delete it. Nothing can bring it back."),
    ok: t("Delete for everyone"),
    hold: t("Hold to delete for everyone"),
    run: async () => { await store.deleteForEveryone(lid); done(t("Deleted {x} for everyone", { x: name })); },
  });
  if (k) return confirmSheet({
    title: t("Delete {x} from this phone?", { x: q(name) }),
    text: t(k.n === 1 ? "{x} keeps it, and can share it with you again. On this phone it goes now, with no Undo."
      : "{x} keep it, and can share it with you again. On this phone it goes now, with no Undo.", { x: k.who }),
    ok: t("Delete from this phone"),
    run: () => { store.deleteHere(lid, false); done(t("Deleted {x} from this phone", { x: name })); },
  });
  confirmSheet({
    title: t("Delete {x}?", { x: q(name) }),
    text: e.closed ? t("It's no longer on the server. What's left here goes, and nothing can bring it back.")
      : t("Nobody else has it, so it goes from this phone and from the server. Nothing can bring it back, not even its link."),
    ok: t("Delete"),
    hold: t("Hold to delete"),
    run: () => { store.deleteHere(lid, true); done(t("Deleted {x} for good", { x: name })); },
  });
}
// What had the cursor is gone, or in a sheet now closed: it goes to el, if there's one.
const lostFocus = el => {
  const now = document.activeElement;
  if (el && (!now || now === document.body || now.closest("dialog:not([open]), [hidden]"))) el.focus({ preventScroll: true });
};
// Deleted alone, a list someone had joined meanwhile stays on the server for them (store.js).
export function kept({ name, who }) {
  const named = who.filter(Boolean);
  say(t("{x} stays on the server: {who} had joined it.", { x: q(listTitle(name)), who: named.length ? and(named) : t("someone") }));
}

// A new list starts from a name, typed on the blank strip. The server makes it on the
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
    if (name) create(code => store.createList({ code, ops: startOps(name) }), lid => {
      emptyField($("#new-list"));
      announce(t("Added {x}", { x: name }));
      nav.showList(lid);
      $("#add-ess").focus(); // a new list is for writing on: the keyboard stays up, in its first section
    });
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
  const p = pending || { make: c => store.createList({ code: c, ops: startOps() }), done: lid => { nav.showList(lid); keepList(); editName(); } };
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

// From a file, in Settings: Markdown and plain text come straight in. Notes from Google
// Keep are chosen first, as Takeout brings every note there is. Once files are chosen,
// Settings gives way to the lists page, where they arrive.
$("#import-open").addEventListener("click", () => $("#import-file").click());
$("#import-file").addEventListener("change", async e => {
  const files = [...(e.target.files || [])];
  e.target.value = "";
  if (!files.length) return;
  $("#settings").close();
  const keep = files.filter(f => /\.(zip|json)$/i.test(f.name));
  const lists = [];
  for (const f of files.filter(f => !keep.includes(f))) lists.push(...fromMarkdown(await f.text().catch(() => "")));
  if (keep.length) lists.push(...(await readKeep(keep).catch(() => [])));
  if (!lists.length) return say(t("There's no list to bring in from {x}.", { x: and(files.map(f => f.name)) }));
  if (keep.length) pick(lists);
  else bringIn(lists);
});
function bringIn(lists) {
  const made = lists.map(importOps);
  create(async code => {
    const lids = [];
    for (const m of made) { lids.push(await store.createList({ code, ops: [...startOps(), ...m.ops] })); code = null; }
    return lids;
  }, lids => {
    const n = made.reduce((a, m) => a + m.n, 0);
    announce(lids.length > 1 ? t("Brought in {x}", { x: plural(lids.length, "{n} list", "{n} lists") }) : t("Brought in {x}", { x: plural(n, "{n} item", "{n} items") }));
    if (lids.length === 1) nav.showList(lids[0]);
    else renderLists();
  });
}
// Each note as its sheet will show: its name, what there is to tick and the first three
// of them. All are ticked to come in but those archived, which are mostly done with;
// Bring in waits for one at least.
function pick(lists) {
  const ok = $("#pick-ok");
  const boxes = lists.map(l => h("input", { type: "checkbox", class: "chk", checked: !l.archived }));
  const ready = () => { ok.disabled = !boxes.some(b => b.checked); };
  $("#pick-list").replaceChildren(...lists.map((l, i) => {
    const toGet = l.sections.flatMap(s => s.items).filter(it => !it.checked).map(it => clean(it.text));
    const about = [l.archived && t("Archived"), toGet.length ? plural(toGet.length, "{n} to tick", "{n} to tick") : t("Nothing to tick"), toGet.slice(0, 3).join(", ")];
    boxes[i].addEventListener("change", ready);
    return h("li", null, h("label", null, boxes[i], h("span", { class: "box", "aria-hidden": "true" }),
      h("span", { class: "pick-in" }, h("span", { class: "pick-name" }, listTitle(clean(l.name || "", MAX_SECTION))), h("span", { class: "pick-about" }, about.filter(Boolean).join(" · ")))));
  }));
  ready();
  ok.onclick = () => { $("#pick").close(); bringIn(lists.filter((_, i) => boxes[i].checked)); };
  openSheet($("#pick"));
}
$("#pick-cancel").addEventListener("click", () => $("#pick").close());
// Opening a list clears what was last said here; coming back from one, the cursor returns
// to its sheet.
export const clearNotice = () => { notice = ""; };
export const sheetButton = lid => cards.has(lid) && cards.get(lid).btn;
// Whether something is being typed here, which an update waits for.
export const typing = () => !!($("#new-list").value.trim() || $("#setup-code").value.trim());
