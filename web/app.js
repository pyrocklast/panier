import * as store from "./store.js";
import { t, plural, q, lang, translatePage } from "./i18n.js";
import { toMarkdown, fromMarkdown, pastedItems } from "./md.js";

// The three sections every list starts with. They can be renamed, recoloured or deleted like any other.
const DEFAULTS = [
  { id: "ess", name: t("Essentials"), en: "Essentials", color: "ess", pos: 1 },
  { id: "look", name: t("Look out for"), en: "Look out for", color: "look", pos: 2 },
  { id: "long", name: t("Long term"), en: "Long term", color: "long", pos: 3 },
];
// Section colours, in palette order; each is a colour in app.css, light and dark. Ink,
// the colour of Essentials and of the app's buttons, comes first; then eight hues.
const COLORS = [["ess", "Ink"], ["green", "Green"], ["teal", "Teal"], ["blue", "Blue"], ["long", "Indigo"], ["plum", "Plum"], ["rose", "Rose"], ["look", "Amber"], ["olive", "Olive"]];
const PALETTE = ["teal", "rose", "green", "blue", "olive", "plum", "look", "long", "ess"]; // new sections take the first unused
const colorOk = (c, fallback) => (COLORS.some(([id]) => id === c) ? c : fallback);
// The list's own colour tints the paper: white, the paper as it is, then the section
// colours but ink.
const LIST_COLORS = [["", "White"], ...COLORS.filter(([id]) => id !== "ess")];
const listColor = () => { const c = store.listColor(); return LIST_COLORS.some(([id]) => id === c) ? c : ""; };
const MAX_ITEM = 120; // three lines on a phone
const MAX_SECTION = 40; // and the list's name
const LIST = "@list"; // where the list's own name is kept, among items and sections
const listName = () => store.listName() || t("Shopping list");
const SETTLE_MS = 1500;
const RECENT_MS = 5 * 24 * 3600 * 1000; // ticked items show in the ticked group for five days
const LONG_PRESS_MS = 450;
const HINT_KEY = "panier-dragged-once";
const draftsKey = () => "panier2-drafts:" + store.current(); // text typed into a list's "Add item" fields, kept until added
const $ = s => document.querySelector(s);
const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)");
const PLAIN = (() => { try { const d = document.createElement("div"); d.contentEditable = "plaintext-only"; return d.contentEditable === "plaintext-only"; } catch (_) { return false; } })();

const fold = s => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
const keyOf = s => fold(s).replace(/\s+/g, " ").trim();
// A quantity at the start of an item, such as "2", "2×", "500 g", "1.5kg", "2 litres of"
// or "3 paquets de", is shown apart from the name and left out when comparing names, so
// "2 litres of milk" is still Milk.
const UNITS = "kg|kilos?|kilogram(?:me)?s?|g|grams?|grammes?|mg|ml|cl|dl|l|lit(?:re|er)s?|lbs?|pounds?|oz|ounces?|" +
  "packs?|packets?|bottles?|cans?|tins?|jars?|bags?|box(?:es)?|cartons?|slices?|bunch(?:es)?|" +
  "paquets?|bouteilles?|bo[iî]tes?|pots?|sachets?|tranches?|briques?|bottes?|canettes?|sacs?";
const QTY = new RegExp("^((?:\\d+(?:[.,]\\d+)?|[½¼¾⅓⅔])\\s*(?:[x×]|(" + UNITS + ")(?![\\p{L}\\d]))?)\\s+(?=\\S)", "iu");
const OF = /^(?:(?:of|de)\s+|d['’]\s*)(?=\S)/i; // after a unit: "2 litres of milk", "1 l d’huile"
function splitQty(text) {
  const m = QTY.exec(text);
  if (!m) return { qty: "", sep: "", name: text };
  let sep = m[0].slice(m[1].length), name = text.slice(m[0].length);
  const of = m[2] && OF.exec(name);
  if (of) { sep += of[0]; name = name.slice(of[0].length); }
  return { qty: m[1], sep, name };
}
// Each text's key is worked out once: names are compared with every past item on every
// keystroke.
const nameKeys = new Map();
function nameKey(s) {
  let k = nameKeys.get(s);
  if (k === undefined) {
    if (nameKeys.size > 5000) nameKeys.clear();
    nameKeys.set(s, (k = keyOf(splitQty(s).name)));
  }
  return k;
}
// An item's name without its quantity, with a capital, as if typed on its own.
function bare(text) {
  const { qty, name } = splitQty(text);
  return qty ? name.charAt(0).toLocaleUpperCase(lang) + name.slice(1) : text;
}
// An item's text after typing typed for it: a quantity typed replaces its quantity.
function retext(old, typed) {
  const n = splitQty(typed);
  return n.qty ? n.qty + n.sep + splitQty(old).name : old;
}
// What an item bought before comes back as from its suggestion: its name, with the
// quantity typed so far, if any. Its old quantity stays behind.
const fromHint = (old, typed) => (splitQty(typed).qty ? retext(old, typed) : bare(old));
// Fills an item's text: the quantity in its own span, the name after it.
function fillText(el, text) {
  const { qty, sep, name } = splitQty(text);
  el.replaceChildren(...(qty ? [h("span", { class: "qty" }, qty.replace(/^([\d.,½¼¾⅓⅔]+\s*)x$/i, "$1×")), sep] : []), name);
}
const clean = (s, max = MAX_ITEM) => s.replace(/\s+/g, " ").trim().slice(0, max);
const buzz = ms => { try { if (navigator.vibrate) navigator.vibrate(ms); } catch (_) {} };

let items = [];
let sections = []; // the sections on screen, in order
let sectionInfo = new Map(); // every section ever seen, for names and colours
const settling = new Set();
let settleTimer = null, flashId = null, drag = null, editingId = null, renderPending = false;
let suppressClick = false, lifted = false;
const ui = { sugSec: null, sug: [], sugIndex: -1, sugCol: 0, basketOpen: true };
let view = null, shownLid = null; // "list", the list shownLid, or "lists", the lists page

/* ---------- DOM helpers ---------- */

function h(tag, attrs, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === "class") e.className = v;
    else if (k === "style") e.style.cssText = v;
    else if (k === "dataset") Object.assign(e.dataset, v);
    else if (k.startsWith("on") && typeof v === "function") e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v === true ? "" : v);
  }
  for (const c of kids.flat()) {
    if (c == null || c === false) continue;
    e.append(c instanceof Node ? c : String(c));
  }
  return e;
}
// Icons are drawn once, in index.html, and placed by name at their size: each is made
// once, then copied, as suggestions place several on every keystroke.
const ICON_SIZES = { plus: 18, back: 16, cross: 16 }, icons = {};
function icon(name) {
  if (!icons[name]) {
    const t = document.createElement("template"), w = ICON_SIZES[name];
    t.innerHTML = `<svg class="icon" width="${w}" height="${w}" aria-hidden="true"><use href="#i-${name}"/></svg>`;
    icons[name] = t.content.firstChild;
  }
  return icons[name].cloneNode(true);
}
// An "add" row: a plus, a field and, once something is typed, a cross. The plus adds what
// was typed, like Enter, and the cross or Escape throws it away. Pressing either doesn't
// leave the field, which would add it. With nothing typed, the plus just opens the field.
function addRow(form, input, { add, clear, escape = clear }) {
  const plus = form.querySelector(".add-plus"), x = form.querySelector(".add-x");
  const typed = () => !!input.value.trim();
  const keep = e => e.preventDefault(), keepIfTyped = e => { if (typed()) e.preventDefault(); };
  for (const ev of ["pointerdown", "mousedown"]) { plus.addEventListener(ev, keepIfTyped); x.addEventListener(ev, keep); }
  plus.addEventListener("click", e => { if (typed()) { e.preventDefault(); add(); } });
  x.addEventListener("click", () => { clear(); input.focus(); });
  form.addEventListener("submit", e => { e.preventDefault(); add(); });
  input.addEventListener("input", () => form.classList.toggle("typing", typed()));
  input.addEventListener("keydown", e => { if (e.key === "Escape") escape(); });
}

const find = id => items.find(i => i.id === id);
const nameOf = id => (sectionInfo.get(id) || { name: t("this section") }).name;
const colorOf = id => (sectionInfo.has(id) ? sectionInfo.get(id).color : "muted");
const isShown = id => sections.some(s => s.id === id);
const inList = i => !i.checked || settling.has(i.id);
const shown = sec => items.filter(i => i.section === sec && inList(i)).sort((a, b) => a.pos - b.pos || (a.id < b.id ? -1 : 1));
const maxPos = sec => shown(sec).reduce((m, i) => Math.max(m, i.pos), 0);
const onScreen = i => inList(i) || i.checkedAt >= Date.now() - RECENT_MS;
function between(a, b) {
  if (a == null && b == null) return 1;
  if (a == null) return b - 1;
  if (b == null) return a + 1;
  return (a + b) / 2;
}
function announce(msg) {
  const l = $("#live");
  l.textContent = "";
  requestAnimationFrame(() => { l.textContent = msg; });
}
const activeFk = () => { const a = document.activeElement; return a && a.dataset ? a.dataset.fk : null; };

// Works out which sections to show. A section stays on screen while it has items to
// get, or text being typed into it, even if someone deleted it meanwhile. layout does
// the same for any list, as Export all lists needs.
function layout(storedSections, its, typing = []) {
  const stored = new Map(storedSections.map(s => [s.id, s]));
  const all = new Map();
  for (const d of DEFAULTS) {
    const st = stored.get(d.id) || {};
    all.set(d.id, { ...d, name: st.name ?? d.name, color: colorOk(st.color, d.color), pos: st.pos ?? d.pos, deleted: !!st.deleted });
  }
  for (const st of stored.values()) {
    if (!all.has(st.id)) all.set(st.id, { id: st.id, name: st.name || t("Untitled"), color: colorOk(st.color, PALETTE[0]), pos: st.pos ?? 100, deleted: st.deleted });
  }
  const used = new Set(its.filter(inList).map(i => i.section));
  for (const id of typing) used.add(id);
  for (const id of used) if (!all.has(id)) all.set(id, { id, name: t("Untitled"), color: PALETTE[0], pos: 100, deleted: false });
  return { all, shown: [...all.values()].filter(s => !s.deleted || used.has(s.id)).sort((a, b) => a.pos - b.pos || (a.id < b.id ? -1 : 1)) };
}
function computeSections() {
  const typing = Object.entries(shells).filter(([, sh]) => sh.input.value.trim()).map(([id]) => id);
  const l = layout(store.sections(), items, typing);
  sectionInfo = l.all;
  sections = l.shown;
}

/* ---------- Changes ---------- */

// A change made while leaving a field by tapping elsewhere redraws once that tap has
// landed, so the thing you tapped is still there to receive it. With a mouse, the field
// is left as the button goes down; with a finger, only after it lifts, just before the
// tap itself.
let pointerIsDown = false, afterTap = [];
addEventListener("pointerdown", () => { pointerIsDown = true; }, true);
const tapEnded = () => {
  pointerIsDown = false;
  const fns = afterTap;
  afterTap = [];
  for (const f of fns) setTimeout(f, 0);
};
addEventListener("pointerup", tapEnded, true);
addEventListener("pointercancel", tapEnded, true);
const whenTapEnds = fn => { if (pointerIsDown) afterTap.push(fn); else setTimeout(fn, 0); };

// act records one undoable step and redraws. With note, the undo button shows that name
// for a few seconds: what a tap on it would bring back.
function act(label, ops, opts = {}) {
  const fk = opts.focusKey || activeFk();
  if (!store.change(label, ops)) return false;
  noteUndo(opts.note);
  items = store.items();
  if (opts.leaving) whenTapEnds(leftPaint);
  else paint(fk, opts.animate, !!opts.focusKey);
  return true;
}
// The redraw after leaving a field shows what was added at once, and leaves alone what
// that tap started: an item being edited isn't touched, and what the cursor went to stays
// put on screen, even when the new item lands above it. A drag is left to finish first.
function leftPaint() {
  if (drag) { renderPending = true; return; }
  const held = document.activeElement !== document.body && document.activeElement;
  const before = held && held.getBoundingClientRect().top;
  paint(null, false);
  if (held && held.isConnected) window.scrollBy(0, held.getBoundingClientRect().top - before);
}
// paint redraws, keeping the cursor where it was: on the redrawn copy of the focused
// element, or on fk when the action asked to move it. If you've moved the cursor
// yourself in the meantime, it stays where you put it.
// With animate, things glide from where they were (see Motion); snap is where they
// were, when the caller has already taken it.
function paint(fk, animate, move = false, snap = null) {
  landAll(); // anything still flying lands first
  const was = document.activeElement;
  if (animate !== false && !reduceMotion.matches && !drag) snap = snap || snapshot();
  render();
  if (fk) {
    const t = document.querySelector('[data-fk="' + fk + '"]');
    const now = document.activeElement;
    const untouched = now === was || !now || now === document.body;
    // A row that changed place lost the cursor on the way; it gets it back.
    if (t && t !== now && untouched && (move || !was || !was.isConnected || was === t)) t.focus({ preventScroll: true });
  }
  if (snap) glide(snap);
}
// Takes in what the store holds now, including the other phone's changes.
function sync() {
  renderPending = false;
  items = store.items();
  for (const id of [...settling]) { const it = find(id); if (!it || !it.checked) settling.delete(id); }
}
// Changes from the other phone wait while you are editing or dragging, and appear
// without motion, so nothing slides away just as you reach for it.
function refreshFromStore() {
  if (view !== "list") return;
  if (editingId || drag) { renderPending = true; return; }
  sync();
  paint(activeFk(), false);
}
// Undo reverses only what is still as you left it: if someone has changed it since, it
// says who, by the name they gave, if any.
function step(fn, done, nothing) {
  const r = fn();
  if (!r) return;
  noteUndo(null);
  announce(r.done ? t(done, { x: r.label }) : t(nothing, { x: (r.by && store.memberName(r.by)) || t("someone else") }));
  refreshFromStore();
  scheduleSettle();
}
const undo = () => (view === "lists" ? undoRemove() : step(store.undo, "Undid {x}", "Nothing to undo: {x} already changed it"));
const redo = () => { if (view === "list") step(store.redo, "Redid {x}", "Nothing to redo: {x} already changed it"); };

// Ticked items stay put briefly, then all move to the ticked group together.
function scheduleSettle() {
  clearTimeout(settleTimer);
  if (!settling.size) return;
  settleTimer = setTimeout(() => {
    if (editingId || drag) return scheduleSettle();
    settling.clear();
    paint(activeFk());
  }, SETTLE_MS);
}

function toggle(id, checked) {
  const it = find(id);
  const fromList = !it.checked;
  const wasSettling = settling.has(id);
  if (checked) {
    if (fromList) settling.add(id);
    buzz(12);
    announce(t("{x} ticked", { x: it.text }));
    act(t("checking {x}", { x: q(it.text) }), [[id, "checked", true], [id, "checkedAt", Date.now()]], { animate: false });
  } else {
    settling.delete(id);
    const ops = [[id, "checked", false], [id, "checkedAt", 0]];
    if (!wasSettling) {
      const sec = isShown(it.section) ? it.section : sections[0].id;
      ops.push([id, "section", sec], [id, "pos", maxPos(sec) + 1]);
    }
    announce(t("{x} back on the list", { x: it.text }));
    act(t("unchecking {x}", { x: q(it.text) }), ops, { animate: !wasSettling });
  }
  scheduleSettle();
}
function loadDrafts() {
  try { return JSON.parse(localStorage.getItem(draftsKey())) || {}; } catch (_) { return {}; }
}
function saveDraft(sec, text) {
  const d = loadDrafts();
  if (text) d[sec] = text; else delete d[sec];
  try { if (Object.keys(d).length) localStorage.setItem(draftsKey(), JSON.stringify(d)); else localStorage.removeItem(draftsKey()); } catch (_) {}
}
function clearAdd(sec) {
  shells[sec].input.value = "";
  shells[sec].form.classList.remove("typing");
  saveDraft(sec, "");
  if (ui.sugSec === sec) closeSug(); // not another field's, typed into just after leaving this one
}
// Puts an item bought before back on the list as text, into sec: picked from its
// suggestion, or, when added, typed in full. When it was ticked doesn't matter once it's
// back, so it isn't written: the change stays under 256 bytes (see store.js).
function revive(id, sec, text, opts = {}, added = false) {
  clearAdd(sec);
  text = clean(text);
  settling.delete(id);
  flashId = id;
  announce(added ? t("Added {x}", { x: text }) : t("{x} back on the list", { x: text }));
  act(added ? t("adding {x}", { x: q(text) }) : t("putting back {x}", { x: q(text) }),
    [[id, "text", text], [id, "section", sec], [id, "pos", maxPos(sec) + 1], [id, "checked", false]], opts);
}
// submitAdd adds what was typed into a section's "Add item" field: on Enter, or, with
// leaving, when you leave the field or reopen the app with text still in it. It adds
// just what was typed: a suggestion comes back only when tapped, or picked with the
// arrow keys.
function submitAdd(sec, leaving = false) {
  const opts = leaving ? { leaving: true } : {};
  const text = clean(shells[sec].input.value);
  const pick = !leaving && ui.sugSec === sec && ui.sugIndex >= 0 && ui.sug[ui.sugIndex];
  if (pick) return ui.sugCol ? forget(pick.id, sec, true) : revive(pick.id, sec, fromHint(pick.text, text));
  if (!text) { clearAdd(sec); return; }
  const same = items.filter(i => nameKey(i.text) === nameKey(text));
  const ex = same.find(inList) || same[0];
  // The same name bought before: that item comes back, as typed, rather than a copy.
  if (ex && ex.checked && !settling.has(ex.id)) return revive(ex.id, sec, text, opts, true);
  clearAdd(sec);
  if (ex) { // already on the list: highlighted, with the quantity just typed, if any
    flashId = ex.id;
    const now = retext(ex.text, text);
    announce(now !== ex.text ? t("{x} is already on the list, now {y}", { x: ex.text, y: now }) : t("{x} is already on the list", { x: ex.text }));
    if (now !== ex.text) act(t("changing {x}", { x: q(ex.text) }), [[ex.id, "text", now]], opts);
    else if (leaving) whenTapEnds(leftPaint);
    else paint(null, false);
    return;
  }
  const id = store.newId();
  flashId = id;
  announce(t("Added {x}", { x: text }));
  // A new item is unticked without saying so; "deleted: false" is what lets undo remove it.
  act(t("adding {x}", { x: q(text) }), [[id, "text", text], [id, "section", sec], [id, "pos", maxPos(sec) + 1], [id, "deleted", false]], opts);
}
// Several lines pasted into an Add item field: one item each, in that section, in one
// step to undo. Names already on the list stay as they are; those bought before come back.
// Lines ticked in Markdown ("- [x]") are kept as bought before, to be suggested.
function addMany(sec, pasted) {
  closeSug(); // what was typed before stays in the field
  const ops = [], seen = new Set(), old = Date.now() - RECENT_MS - 864e5;
  let added = 0, had = 0, pos = maxPos(sec);
  for (const p of pasted) {
    const text = clean(p.text), k = nameKey(text);
    if (!text || seen.has(k)) continue;
    seen.add(k);
    const same = items.filter(i => nameKey(i.text) === k);
    const ex = same.find(inList) || same[0];
    if (ex && (inList(ex) || p.checked)) { had++; continue; }
    const id = ex ? ex.id : store.newId();
    ops.push([id, "text", text], [id, "section", sec], [id, "pos", ++pos], ex ? [id, "checked", false] : [id, "deleted", false]);
    if (p.checked) ops.push([id, "checked", true], [id, "checkedAt", old]);
    added++;
  }
  const already = had ? plural(had, "{n} already on the list", "{n} already on the list") : "";
  if (!added) { announce(already); paint(null, false); return; }
  announce(plural(added, "Added {n} item", "Added {n} items") + (already ? ", " + already : ""));
  act(plural(added, "adding {n} item", "adding {n} items"), ops);
}
function del(id, opts) {
  const it = find(id);
  settling.delete(id);
  announce(t("Deleted {x}", { x: it.text }));
  act(t("deleting {x}", { x: q(it.text) }), [[id, "deleted", true]], { ...opts, note: it.text });
}
function nudge(id, dir) {
  const it = find(id);
  const list = shown(it.section);
  const other = list[list.indexOf(it) + dir];
  if (other) {
    act(t("moving {x}", { x: q(it.text) }), [[id, "pos", other.pos], [other.id, "pos", it.pos]], { focusKey: "chk-" + id });
    return;
  }
  const next = sections[sections.findIndex(s => s.id === it.section) + dir];
  if (!next) return;
  const l = shown(next.id);
  const pos = dir > 0 ? (l.length ? l[0].pos - 1 : 1) : maxPos(next.id) + 1;
  announce(t("{x} moved to {y}", { x: it.text, y: next.name }));
  act(t("moving {x}", { x: q(it.text) }), [[id, "section", next.id], [id, "pos", pos]], { focusKey: "chk-" + id });
}

function addSection(raw) {
  const name = clean(raw, MAX_SECTION);
  if (!name) return;
  $("#add-sec").value = "";
  $("#add-sec-form").classList.remove("typing");
  const id = store.newId(), key = "#" + id;
  const usedColors = new Set(sections.map(s => s.color));
  const color = PALETTE.find(c => !usedColors.has(c)) || PALETTE[sectionInfo.size % PALETTE.length];
  const pos = sections.reduce((m, s) => Math.max(m, s.pos), 0) + 1;
  announce(t("Added section {x}", { x: name }));
  // No animation: the cursor moves to the new section's field at once, so nothing typed straight after lands in the wrong field.
  act(t("adding section {x}", { x: q(name) }), [[key, "name", name], [key, "pos", pos], [key, "color", color], [key, "deleted", false]], { focusKey: "add-" + id, animate: false });
}
function renameSection(id, name) {
  const info = sectionInfo.get(id);
  const fallback = (DEFAULTS.find(d => d.id === id) || {}).name;
  announce(t("Renamed section to {x}", { x: name }));
  act(t("renaming section {x}", { x: q(info.name) }), [["#" + id, "name", name, fallback]], { leaving: true });
}
// A section can only be deleted once it has nothing to get, and the last one stays.
const canDelete = id => sections.length > 1 && !items.some(i => i.section === id && inList(i));
function deleteSection(id) {
  const name = nameOf(id);
  announce(t("Deleted section {x}", { x: name }));
  act(t("deleting section {x}", { x: q(name) }), [["#" + id, "deleted", true, false]], { note: name });
}

/* ---------- Editing in place ---------- */

// How many characters come before a range's start within span.
function offsetIn(span, r) {
  if (!r) return null;
  const head = document.createRange();
  head.selectNodeContents(span);
  head.setEnd(r.startContainer, r.startOffset);
  return head.toString().length;
}
function caretAt(span, x, y) {
  try {
    if (document.caretPositionFromPoint) {
      const p = document.caretPositionFromPoint(x, y);
      if (p && span.contains(p.offsetNode)) {
        const r = document.createRange();
        r.setStart(p.offsetNode, p.offset);
        r.collapse(true);
        return r;
      }
    } else if (document.caretRangeFromPoint) {
      const r = document.caretRangeFromPoint(x, y);
      if (r && span.contains(r.startContainer)) return r;
    }
  } catch (_) {}
  return null;
}
// The text before and after the cursor (or the selection) in a span being edited.
function aroundCursor(span) {
  const sel = getSelection();
  if (!sel.rangeCount) return null;
  const r = sel.getRangeAt(0);
  if (!span.contains(r.startContainer) || !span.contains(r.endContainer)) return null;
  const head = document.createRange(), tail = document.createRange();
  head.selectNodeContents(span);
  head.setEnd(r.startContainer, r.startOffset);
  tail.selectNodeContents(span);
  tail.setStart(r.endContainer, r.endOffset);
  return { head: head.toString(), tail: tail.toString(), collapsed: r.collapsed };
}
// editInPlace turns a text span into an editable field until Enter, Escape or leaving
// it, with the cursor where you tapped, or at caret. While editing, the text is plain;
// fill shows it again afterwards, as an item shows its quantity. With onDelete, a cross appears at the
// end of the row while editing. With onSplit, Enter in the middle of the text splits it
// there; with onJoin, Backspace at its very start joins it to what's above, when canJoin
// allows; with onEmpty, leaving the text empty calls it instead of restoring the old text.
function editInPlace(span, { key, row, orig, max, x, y, caret, fill, onSave, onDelete, deleteLabel, onSplit, canJoin, onJoin, onEmpty, below }) {
  if (editingId || drag) return;
  editingId = key;
  const at = x != null ? offsetIn(span, caretAt(span, x, y)) : caret; // counted before the text turns plain
  const show = () => (fill ? fill(span, orig) : (span.textContent = orig));
  span.textContent = orig;
  span.contentEditable = PLAIN ? "plaintext-only" : "true";
  span.classList.add("editing");
  span.setAttribute("role", "textbox");
  span.focus();
  try {
    const r = document.createRange(), t = span.firstChild;
    if (at != null && t) { r.setStart(t, Math.min(at, t.length)); r.collapse(true); }
    else { r.selectNodeContents(span); r.collapse(false); }
    const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r);
  } catch (_) {}
  let cancelled = false, binned = false, done = false;
  const bin = onDelete && h("button", {
    type: "button", class: "bin", "aria-label": deleteLabel,
    onpointerdown: e => e.preventDefault(), onmousedown: e => e.preventDefault(),
    onclick: () => { cancelled = binned = true; finish(); onDelete(); },
  }, icon("cross"));
  row.classList.add("editing");
  if (bin) row.append(bin);
  if (below) row.after(below); // more tools while editing, such as a section's colours
  const tools = [bin, below].filter(Boolean);
  const inTools = el => !!el && tools.some(t => t.contains(el));
  const enter = () => {
    const c = onSplit && aroundCursor(span);
    const a = c && clean(c.head, max), b = c && clean(c.tail, max);
    // A split between words joins back with a space; one inside a word, without.
    const glue = c && c.collapsed && !/\s$/.test(c.head) && !/^\s/.test(c.tail) ? "" : " ";
    if (a && b) finish(() => onSplit(a, b, glue));
    else span.blur();
  };
  const back = e => {
    const c = onJoin && aroundCursor(span);
    if (!c || !c.collapsed || c.head !== "") return;
    const text = clean(span.textContent, max);
    if (!canJoin(text)) return;
    e.preventDefault();
    finish(() => onJoin(text));
  };
  const onKey = e => {
    if (e.key === "Enter") { e.preventDefault(); enter(); }
    else if (e.key === "Backspace") back(e);
    else if (e.key === "Escape") { e.preventDefault(); cancelled = true; span.blur(); }
  };
  const onBefore = e => {
    if (e.inputType === "insertParagraph" || e.inputType === "insertLineBreak") { e.preventDefault(); enter(); return; }
    if (e.inputType === "deleteContentBackward") { back(e); return; } // phone keyboards may only send this
    // Keep to the length limit while typing or pasting.
    const room = max - span.textContent.length + (getSelection().toString().length || 0);
    if (e.data && e.data.length > room) e.preventDefault();
  };
  const onPaste = e => {
    if (PLAIN) return;
    e.preventDefault();
    document.execCommand("insertText", false, (e.clipboardData && e.clipboardData.getData("text/plain")) || "");
  };
  let away = false; // the whole app lost focus: a notification, another app
  const onSpanBlur = e => {
    if (inTools(e.relatedTarget)) return;
    away = !document.hasFocus();
    finish();
  };
  const onToolsOut = e => { if (e.relatedTarget !== span && !inTools(e.relatedTarget)) finish(); };
  function finish(then) {
    if (done) return;
    done = true;
    span.removeEventListener("keydown", onKey);
    span.removeEventListener("beforeinput", onBefore);
    span.removeEventListener("paste", onPaste);
    span.removeEventListener("blur", onSpanBlur);
    for (const t of tools) { t.removeEventListener("focusout", onToolsOut); t.remove(); }
    if (rows.has(key)) rows.get(key).shown = null; // typed into: rewritten at the next redraw
    span.contentEditable = "false";
    span.classList.remove("editing");
    span.setAttribute("role", "button");
    row.classList.remove("editing");
    editingId = null;
    if (then) return then();
    const text = clean(span.textContent, max);
    if (!text && !cancelled && !away && onEmpty) return onEmpty();
    if (cancelled || !text || text === orig) {
      show();
      if (renderPending && !binned) whenTapEnds(refreshFromStore);
      return;
    }
    if (onSave(text) === false) show();
  }
  span.addEventListener("keydown", onKey);
  span.addEventListener("beforeinput", onBefore);
  span.addEventListener("paste", onPaste);
  span.addEventListener("blur", onSpanBlur);
  for (const t of tools) t.addEventListener("focusout", onToolsOut);
}

function editItem(span, id, x, y, caret) {
  const orig = find(id).text;
  const row = span.closest(".item");
  editInPlace(span, {
    key: id, row, orig, max: MAX_ITEM, x, y, caret, fill: fillText,
    onDelete: () => del(id), deleteLabel: t("Delete {x}", { x: orig }),
    onSplit: (first, second, glue) => splitItem(id, first, second, glue),
    canJoin: text => !!joinTarget(id, text),
    onJoin: text => joinItem(id, text),
    // Hidden at once but redrawn after the tap, so nothing moves under your finger.
    onEmpty: () => { row.style.visibility = "hidden"; del(id, { leaving: true }); },
    onSave: text => {
      const dup = items.find(i => i.id !== id && nameKey(i.text) === nameKey(text));
      if (dup && onScreen(dup)) {
        flashId = dup.id;
        announce(t("{x} is already on the list", { x: dup.text }));
        whenTapEnds(leftPaint);
        return false;
      }
      const ops = [[id, "text", text]];
      if (dup) ops.push([dup.id, "deleted", true]);
      announce(t("Renamed to {x}", { x: text }));
      act(t("renaming {x}", { x: q(orig) }), ops, { leaving: true });
    },
  });
}

// Enter inside an item's text splits it in two: the first part stays, the second becomes
// the next item, ready to edit. As when adding or renaming, a part that's already on the
// list isn't added twice, and one bought before comes back.
let lastSplit = null; // so Backspace can join the two parts back exactly
function splitItem(id, first, second, glue) {
  const it = find(id);
  const dupOf = text => items.find(i => i.id !== id && nameKey(i.text) === nameKey(text));
  const sib = shown(it.section), k = sib.indexOf(it);
  const pos = between(it.pos, k >= 0 && sib[k + 1] ? sib[k + 1].pos : null);
  const ops = [];
  let next = null; // the item to carry on editing
  let msg = t("Split into {x} and {y}", { x: first, y: second });
  const d1 = dupOf(first), kept = !(d1 && onScreen(d1));
  if (!kept) { ops.push([id, "deleted", true]); flashId = d1.id; }
  else { ops.push([id, "text", first]); if (d1) ops.push([d1.id, "deleted", true]); }
  const here = nid => [[nid, "section", it.section], [nid, "pos", pos], [nid, "checked", it.checked], [nid, "checkedAt", it.checkedAt]];
  const d2 = dupOf(second);
  if (nameKey(second) === nameKey(first)) { /* "milk milk": one is enough */ }
  else if (d2 && inList(d2)) { flashId = d2.id; msg = t("{x} is already on the list", { x: d2.text }); }
  else if (d2) { ops.push([d2.id, "text", second], ...here(d2.id)); next = d2.id; } // bought before: back as typed
  else {
    next = store.newId();
    ops.push([next, "text", second], ...here(next), [next, "deleted", false]);
    if (kept) lastSplit = { a: id, b: next, glue };
  }
  if (next && settling.has(id)) settling.add(next);
  announce(msg);
  // Nothing to save when the second part was already on the list: just redraw.
  if (!act(t("splitting {x}", { x: q(it.text) }), ops, { animate: false })) paint(activeFk(), false);
  const span = next && document.getElementById("txt-" + next);
  if (span) editItem(span, next, null, null, 0);
}

// Backspace at the very start of an item joins it onto the item above, the reverse of
// Enter; an empty item is simply deleted. The cursor lands where the two meet.
function joinTarget(id, text) {
  const it = find(id), sib = shown(it.section), k = sib.indexOf(it);
  const prev = k > 0 ? sib[k - 1] : null;
  return prev && prev.text.length + 1 + text.length <= MAX_ITEM ? prev : null;
}
function joinItem(id, text) {
  const it = find(id), prev = joinTarget(id, text);
  const glue = !text ? "" : lastSplit && lastSplit.a === prev.id && lastSplit.b === id ? lastSplit.glue : " ";
  lastSplit = null;
  const joined = prev.text + glue + text;
  announce(text ? t("Joined into {x}", { x: joined }) : t("Deleted {x}", { x: it.text }));
  act(text ? t("joining {x} and {y}", { x: q(prev.text), y: q(text) }) : t("deleting {x}", { x: q(it.text) }),
    [[prev.id, "text", joined], [id, "deleted", true]], { animate: false });
  const span = document.getElementById("txt-" + prev.id);
  if (span) editItem(span, prev.id, null, null, prev.text.length + glue.length);
}

// While a section's name is being edited, its colours show under it: a tap recolours
// the section at once, and the name stays in editing.
// Colours to choose from while a name is edited: a tap recolours at once, and the name
// stays in editing.
function palette(name, colors, current, pick) {
  const keep = e => e.preventDefault();
  const el = h("div", { class: "palette", role: "group", "aria-label": t("Colour of {x}", { x: name }) },
    colors.map(([c, label]) => h("button", {
      type: "button", class: "swatch" + (c ? "" : " plain"), style: c ? "--c:var(--" + c + ")" : null, "aria-label": t(label),
      "aria-pressed": String(current === c), onpointerdown: keep, onmousedown: keep,
      onclick: e => {
        for (const b of el.children) b.setAttribute("aria-pressed", String(b === e.currentTarget));
        pick(c, label);
      },
    })));
  return el;
}
function editSection(span, id, x, y) {
  const orig = nameOf(id);
  editInPlace(span, {
    key: "#" + id, row: span.closest(".sec-head"), orig, max: MAX_SECTION, x, y,
    below: palette(orig, COLORS, colorOf(id), (c, label) => recolour(id, c, label)),
    onDelete: canDelete(id) ? () => deleteSection(id) : null, deleteLabel: t("Delete section {x}", { x: orig }),
    onSave: name => renameSection(id, name),
  });
}
// The list's name, at the top, is renamed the same way as a section's, its colour chosen
// under it.
function editListName(span, x, y) {
  const orig = listName();
  editInPlace(span, {
    key: LIST, row: span.closest(".list-top"), orig, max: MAX_SECTION, x, y,
    below: palette(orig, LIST_COLORS, listColor(), (c, label) => {
      announce(t("{x} is now {y}", { x: listName(), y: t(label).toLowerCase() }));
      act(t("changing the colour of {x}", { x: q(listName()) }), [[LIST, "color", c, ""]], { animate: false });
    }),
    // The cross takes the list off this phone, for the lists page to undo.
    onDelete: () => { const lid = store.current(); leaveList(() => removeList(lid)); },
    deleteLabel: t("Remove {x} from this phone", { x: orig }),
    onSave: name => {
      announce(t("Renamed the list to {x}", { x: name }));
      act(t("renaming the list {x}", { x: q(orig) }), [[LIST, "name", name, t("Shopping list")]], { leaving: true });
    },
  });
}
function recolour(id, color, label) {
  const fallback = (DEFAULTS.find(d => d.id === id) || {}).color;
  announce(t("{x} is now {y}", { x: nameOf(id), y: t(label).toLowerCase() }));
  act(t("changing the colour of {x}", { x: q(nameOf(id)) }), [["#" + id, "color", color, fallback]], { animate: false });
}

/* ---------- Suggestions from everything bought before ---------- */

function suggestions(text) {
  const n = nameKey(text);
  if (n.length < 2) return []; // from two letters
  const scored = [];
  for (const it of items) {
    if (!it.checked || settling.has(it.id)) continue;
    const t = nameKey(it.text);
    const at = t.indexOf(n);
    if (at < 0) continue;
    const wordStart = at === 0 || /[\s(,'-]/.test(t[at - 1]);
    scored.push({ it, score: at === 0 ? 0 : wordStart ? 1 : 2 });
  }
  scored.sort((a, b) => a.score - b.score || b.it.checkedAt - a.it.checkedAt);
  // Shown by name only, so one name is suggested once, even if it was bought twice.
  const seen = new Set(), out = [];
  for (const { it } of scored) {
    const k = nameKey(it.text);
    if (seen.has(k)) continue;
    seen.add(k);
    if (out.push(it) === 5) break;
  }
  return out;
}
function highlight(text, query) {
  const nfc = text.normalize("NFC");
  const f = fold(nfc), nq = fold(query).trim();
  const at = nq ? f.indexOf(nq) : -1;
  if (f.length !== nfc.length || at < 0) return text;
  const frag = document.createDocumentFragment();
  frag.append(nfc.slice(0, at), h("mark", {}, nfc.slice(at, at + nq.length)), nfc.slice(at + nq.length));
  return frag;
}
// Each suggestion is a row of two cells: the item, which brings it back, and a × that
// removes it for good. With the keyboard, arrows move between them and Enter picks.
// Suggestions show the name alone: the quantity bought last time stays behind.
const sugCellId = (sec, i, col) => "sug-" + sec + "-" + i + (col ? "-x" : "");
function paintSug(sec, list) {
  const sh = shells[sec], query = splitQty(sh.input.value).name;
  const active = ui.sugSec === sec ? ui.sugIndex : -1;
  const keep = e => e.preventDefault(); // the cursor stays in the field
  sh.sug.replaceChildren(...list.map((it, i) => h("li", { role: "row", class: "sugopt" + (i === active ? " active" : ""), onpointerdown: keep, onmousedown: keep },
    h("span", {
      role: "gridcell", class: "sug-pick", id: sugCellId(sec, i, 0), "aria-selected": String(i === active && !ui.sugCol),
      onclick: () => revive(it.id, sec, fromHint(it.text, sh.input.value)),
    }, icon("back"), h("span", { class: "t" }, highlight(bare(it.text), query))),
    h("span", { role: "gridcell", class: "sug-x-cell", id: sugCellId(sec, i, 1), "aria-selected": String(i === active && !!ui.sugCol) },
      h("button", { type: "button", class: "sug-x", tabindex: "-1", "aria-label": t("Remove {x} from suggestions", { x: bare(it.text) }), onclick: () => forget(it.id, sec) }, icon("cross"))))));
  sh.sug.hidden = !list.length;
  sh.input.setAttribute("aria-expanded", String(list.length > 0));
  if (list.length && active >= 0) sh.input.setAttribute("aria-activedescendant", sugCellId(sec, active, ui.sugCol));
  else sh.input.removeAttribute("aria-activedescendant");
}
function updateSug(sec) {
  if (ui.sugSec && ui.sugSec !== sec) paintSug(ui.sugSec, []);
  const list = suggestions(shells[sec].input.value);
  ui.sugSec = list.length ? sec : null;
  ui.sug = list;
  ui.sugIndex = -1;
  ui.sugCol = 0;
  paintSug(sec, list);
}
function closeSug() {
  if (ui.sugSec) paintSug(ui.sugSec, []);
  ui.sugSec = null; ui.sug = []; ui.sugIndex = -1; ui.sugCol = 0;
}
// The × on a suggestion deletes that item, so a typo such as "Mlik" stops coming back.
function forget(id, sec, keyboard = false) {
  const it = find(id), was = ui.sugIndex, name = bare(it.text);
  announce(t("Removed {x} from suggestions", { x: name }));
  act(t("removing {x} from suggestions", { x: q(name) }), [[id, "deleted", true]], { animate: false, note: name });
  updateSug(sec);
  if (keyboard && ui.sug.length) {
    ui.sugIndex = Math.min(was, ui.sug.length - 1);
    ui.sugCol = 1;
    paintSug(sec, ui.sug);
  }
}

/* ---------- Sections, kept between renders so a focused field keeps its keyboard ---------- */

const shells = {};
function buildShell(id) {
  const ul = h("ul", { class: "items", "data-sec": id });
  const input = h("input", {
    type: "text", class: "add-input", id: "add-" + id, placeholder: t("Add item"),
    maxlength: String(MAX_ITEM), enterkeyhint: "enter", autocomplete: "off", autocapitalize: "sentences", spellcheck: "false",
    role: "combobox", "aria-autocomplete": "list", "aria-haspopup": "grid", "aria-expanded": "false", "aria-controls": "sug-" + id,
    dataset: { fk: "add-" + id },
  });
  const form = h("form", { class: "add", autocomplete: "off" },
    h("label", { class: "add-plus", for: "add-" + id, "aria-hidden": "true" }, icon("plus")), input,
    h("button", { type: "button", class: "bin add-x", tabindex: "-1", "aria-label": t("Clear") }, icon("cross")));
  // Adding keeps the cursor here for the next item; Escape closes the suggestions first.
  addRow(form, input, {
    add: () => { submitAdd(id); input.focus(); },
    clear: () => clearAdd(id),
    escape: () => (ui.sugSec === id ? closeSug() : clearAdd(id)),
  });
  const sug = h("ul", { class: "sug", id: "sug-" + id, role: "grid", "aria-label": t("Bought before"), hidden: true });
  const name = h("span", { class: "sec-name", id: "h-" + id, role: "button", tabindex: "0", dataset: { fk: "name-" + id } });
  name.addEventListener("click", e => {
    if (suppressClick) { suppressClick = false; return; }
    if (editingId !== "#" + id) editSection(name, id, e.clientX, e.clientY);
  });
  name.addEventListener("keydown", e => {
    if (editingId === "#" + id) return;
    if (e.key === "Enter" || e.key === " " || e.key === "F2") { e.preventDefault(); editSection(name, id); }
    else if (e.altKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) { e.preventDefault(); moveSection(id, e.key === "ArrowUp" ? -1 : 1); }
  });
  const head = h("h2", { class: "sec-head" }, name);
  const el = h("section", { class: "sec", "data-sec": id, "aria-labelledby": "h-" + id }, head, ul, sug, form);
  bindPress(head, { look: el, can: () => sections.length > 1, start: (offY, y) => startSectionDrag(id, y) });
  input.addEventListener("input", () => {
    saveDraft(id, input.value.trim() ? input.value : "");
    updateSug(id);
  });
  input.addEventListener("focus", () => updateSug(id));
  input.addEventListener("paste", e => {
    const pasted = pastedItems(e.clipboardData ? e.clipboardData.getData("text/plain") : "");
    if (!pasted || !pasted.length) return;
    e.preventDefault();
    addMany(id, pasted);
    input.focus();
  });
  input.addEventListener("blur", () => {
    if (ui.sugSec === id) closeSug();
    // Leaving the field adds the item, but not when the whole app loses focus (a
    // notification, another app): the text is kept and you carry on typing.
    setTimeout(() => {
      if (document.hasFocus() && document.activeElement !== input && shells[id] === sh) submitAdd(id, true);
    }, 0);
  });
  input.addEventListener("keydown", e => {
    if (ui.sugSec !== id || !ui.sug.length) return;
    const n = ui.sug.length, i = ui.sugIndex;
    if (e.key === "ArrowDown") ui.sugIndex = (i + 1) % n;
    else if (e.key === "ArrowUp") ui.sugIndex = i <= 0 ? n - 1 : i - 1;
    else if (i >= 0 && (e.key === "ArrowRight" || e.key === "ArrowLeft")) ui.sugCol = e.key === "ArrowRight" ? 1 : 0;
    else if (i >= 0 && e.key === "Delete" && e.shiftKey) { e.preventDefault(); forget(ui.sug[i].id, id, true); return; }
    else return;
    e.preventDefault();
    paintSug(id, ui.sug);
  });
  const sh = { el, ul, input, form, sug, name };
  return sh;
}
function syncShells() {
  const list = $("#list");
  for (const id of Object.keys(shells)) {
    if (!isShown(id)) { shells[id].el.remove(); delete shells[id]; }
  }
  sections.forEach((s, i) => {
    const sh = shells[s.id] || (shells[s.id] = buildShell(s.id));
    sh.el.style.setProperty("--sec", "var(--" + s.color + ")");
    if (sh.el.dataset.color !== s.color) sh.el.dataset.color = s.color;
    if (editingId !== "#" + s.id && sh.name.textContent !== s.name) sh.name.textContent = s.name;
    sh.name.setAttribute("aria-label", t("{x}, rename", { x: s.name }));
    sh.input.setAttribute("aria-label", t("Add item to {x}", { x: s.name }));
    if (list.children[i] !== sh.el) list.insertBefore(sh.el, list.children[i] || null);
  });
}

/* ---------- Items ---------- */

// Each item keeps its row from one redraw to the next: only what changed is written,
// and only rows that changed place are moved, so a tap doesn't rebuild the whole list
// and the cursor stays where it is. A row is built anew only for its tint, which plays
// once, when the row appears.
const rows = new Map(); // item id → { li, chk, text, shown: the text written in it }
function rowOf(it, tint) {
  let r = rows.get(it.id);
  if (r && editingId === it.id) return r.li; // being edited: left just as it is
  if (!r || tint) rows.set(it.id, (r = itemEl(it.id)));
  const cls = "item" + (it.checked ? " done" : "") + (tint ? " flash" : ""), sec = "var(--" + colorOf(it.section) + ")";
  if (r.li.className !== cls) r.li.className = cls; // also clears what a drag or a press left
  if (r.li.style.length !== 1 || r.li.style.getPropertyValue("--sec") !== sec) r.li.style.cssText = "--sec:" + sec;
  if (r.chk.checked !== it.checked) r.chk.checked = it.checked;
  if (r.shown !== it.text) {
    r.shown = it.text;
    fillText(r.text, it.text);
    r.chk.setAttribute("aria-label", it.text);
    r.text.setAttribute("aria-label", t("Edit {x}", { x: it.text }));
  }
  return r.li;
}
// Puts rows into ul in this order: those that left go first, so the rest only move if
// their order changed.
function setRows(ul, list) {
  const want = new Set(list);
  for (const li of [...ul.children]) if (!want.has(li)) li.remove();
  let at = ul.firstElementChild;
  for (const li of list) {
    if (li === at) at = at.nextElementSibling;
    else ul.insertBefore(li, at);
  }
}
// A row's parts and what they do; rowOf fills in the item's text, colour and tick.
function itemEl(id) {
  const li = h("li", { "data-id": id });
  const chk = h("input", { type: "checkbox", class: "chk", id: "chk-" + id, dataset: { fk: "chk-" + id } });
  chk.addEventListener("change", () => toggle(id, chk.checked));
  chk.addEventListener("keydown", e => {
    const it = find(id);
    if (e.altKey && (e.key === "ArrowUp" || e.key === "ArrowDown") && it && inList(it)) { e.preventDefault(); nudge(id, e.key === "ArrowUp" ? -1 : 1); }
    else if (e.key === "Delete") { e.preventDefault(); del(id); }
  });
  const cell = h("label", { class: "boxcell", for: "chk-" + id },
    chk, h("span", { class: "box", "aria-hidden": "true" }), h("span", { class: "grip", "aria-hidden": "true" }));
  cell.addEventListener("click", e => { if (suppressClick) { e.preventDefault(); suppressClick = false; } });
  const text = h("span", { class: "text", id: "txt-" + id, role: "button", tabindex: "0", dataset: { fk: "txt-" + id } });
  text.addEventListener("click", e => {
    if (suppressClick) { suppressClick = false; return; }
    if (editingId !== id) editItem(text, id, e.clientX, e.clientY);
  });
  text.addEventListener("keydown", e => {
    if (editingId === id) return;
    if (e.key === "Enter" || e.key === " " || e.key === "F2") { e.preventDefault(); editItem(text, id); }
    else if (e.key === "Delete") { e.preventDefault(); del(id); }
  });
  li.append(cell, text);
  bindPress(li, { can: () => !!li.closest("#list .items, #basket-list"), start: (offY, y) => startDrag(li, id, offY, y) });
  return { li, chk, text, shown: null };
}

/* Press and hold, then move, to drag; with a mouse, just move. look is what lifts. */
function bindPress(target, { look = target, can, start }) {
  let timer = null, p = null;
  const off = () => {
    clearTimeout(timer); timer = null; p = null; lifted = false;
    look.classList.remove("pressing", "lifted");
    removeEventListener("pointermove", move);
    removeEventListener("pointerup", off);
    removeEventListener("pointercancel", off);
  };
  const lift = () => {
    clearTimeout(timer); timer = null;
    if (!p || p.lifted) return;
    if (!can()) { suppressClick = true; off(); return; }
    p.lifted = true; lifted = true; suppressClick = true;
    look.classList.remove("pressing");
    look.classList.add("lifted");
    buzz(8);
  };
  const move = e => {
    if (!p) return;
    const d = Math.hypot(e.clientX - p.x, e.clientY - p.y);
    if ((p.lifted || p.mouse) && d > 6 && can()) {
      const offY = p.y - look.getBoundingClientRect().top;
      off();
      suppressClick = true;
      start(offY, e.clientY);
    } else if (!p.lifted && !p.mouse && d > 8) off();
  };
  target.addEventListener("pointerdown", e => {
    if (e.button > 0 || editingId || drag) return;
    suppressClick = false;
    p = { x: e.clientX, y: e.clientY, mouse: e.pointerType === "mouse", lifted: false };
    look.classList.add("pressing");
    timer = setTimeout(lift, LONG_PRESS_MS);
    addEventListener("pointermove", move);
    addEventListener("pointerup", off);
    addEventListener("pointercancel", off);
  });
  target.addEventListener("contextmenu", e => {
    if (e.pointerType === "mouse") return;
    e.preventDefault();
    if (p && !p.mouse && !editingId) lift();
  });
}
// A drag in progress: the ghost follows the pointer, d.place puts the slot under it, the
// page scrolls near the edges, and d.end runs when it's let go.
function beginDrag(d) {
  drag = { ...d, raf: 0 };
  addEventListener("pointermove", onDragMove);
  addEventListener("pointerup", stopDrag);
  addEventListener("pointercancel", stopDrag);
  drag.raf = requestAnimationFrame(dragTick);
  drag.place(drag.y);
}
function stopDrag() {
  if (!drag) return;
  cancelAnimationFrame(drag.raf);
  removeEventListener("pointermove", onDragMove);
  removeEventListener("pointerup", stopDrag);
  removeEventListener("pointercancel", stopDrag);
  drag.end();
}
document.addEventListener("touchmove", e => { if (lifted || drag) e.preventDefault(); }, { passive: false });

// A floating copy over the page, at rect: a drag's ghost, or an item flying to its new
// place. It has no ids, so nothing is found twice.
function float(el, rect, cls, top = rect.top) {
  el.classList.remove("placeholder", "away", "lifted", "pressing", "flash", "hint");
  el.classList.add(cls);
  el.querySelectorAll("[id]").forEach(n => n.removeAttribute("id"));
  el.setAttribute("aria-hidden", "true");
  Object.assign(el.style, { left: rect.left + "px", top: top + "px", width: rect.width + "px" });
  document.body.append(el);
  return el;
}
// Letting go: the drag ends, and how the page looked is kept, so things glide from there
// and the ghost from where it was let go.
function letGo() {
  const { ghost } = drag;
  const snap = reduceMotion.matches ? null : snapshot();
  if (snap) snap.ghost = { li: ghost, rect: ghost.getBoundingClientRect(), part: null };
  else ghost.remove();
  document.documentElement.classList.remove("dragging", "drag-ticked", "sorting");
  $("#tick-drop").classList.remove("over");
  drag = null;
  try { localStorage.setItem(HINT_KEY, "1"); } catch (_) {}
  return snap;
}

function startDrag(li, id, offY, y) {
  landAll();
  li.style.opacity = "";
  const ghost = float(li.cloneNode(true), li.getBoundingClientRect(), "ghost", y - offY);
  li.classList.add("placeholder");
  // A ticked item can go back into a section; over the ticked group, it returns to its place there.
  const ticked = li.parentElement.id === "basket-list";
  document.documentElement.classList.add("dragging");
  document.documentElement.classList.toggle("drag-ticked", ticked);
  const home = { ul: li.parentElement, next: li.nextElementSibling, sec: li.style.getPropertyValue("--sec") };
  beginDrag({ id, li, ghost, offY, y, toTick: null, ticked, home, place, end: endDrag });
}
function onDragMove(e) {
  if (!drag) return;
  drag.y = e.clientY;
  drag.ghost.style.top = (e.clientY - drag.offY) + "px";
  drag.place(e.clientY);
}
function dragTick() {
  if (!drag) return;
  const y = drag.y, H = drag.bottom || innerHeight;
  let dy = 0;
  if (y < 64) dy = -Math.ceil((64 - y) / 6);
  else if (y > H - 64) dy = Math.ceil((y - (H - 64)) / 6);
  if (dy) { window.scrollBy(0, dy); drag.place(y); }
  drag.raf = requestAnimationFrame(dragTick);
}
function setSec(sec) {
  drag.li.style.setProperty("--sec", sec);
  drag.ghost.style.setProperty("--sec", sec);
}
function place(y) {
  // Over the ticked group, from its heading down: the item will be ticked, or stay ticked.
  const toTick = y > $("#basket").getBoundingClientRect().top - 8;
  if (toTick !== drag.toTick) {
    if (toTick && drag.toTick === false) buzz(8);
    drag.toTick = toTick;
    drag.ghost.classList.toggle("done", toTick);
    drag.ghost.querySelector(".chk").checked = toTick;
    if (!drag.ticked) {
      drag.li.classList.toggle("away", toTick); // its slot empties, nothing moves
      $("#tick-drop").classList.toggle("over", toTick);
    } else if (toTick) {
      drag.home.ul.insertBefore(drag.li, drag.home.next);
      setSec(drag.home.sec);
    }
  }
  if (toTick) return;
  const secs = [...document.querySelectorAll("#list .sec")];
  let target = secs[secs.length - 1];
  for (const s of secs) { if (y < s.getBoundingClientRect().bottom) { target = s; break; } }
  const ul = target.querySelector("ul.items");
  let before = null;
  for (const n of ul.children) {
    if (n === drag.li) continue;
    const r = n.getBoundingClientRect();
    if (y < r.top + r.height / 2) { before = n; break; }
  }
  if (drag.li.parentElement === ul && drag.li.nextElementSibling === before) return;
  ul.insertBefore(drag.li, before);
  setSec("var(--" + colorOf(ul.dataset.sec) + ")");
}
function endDrag() {
  const { li, id, toTick, ticked } = drag;
  const snap = letGo();
  if (snap) snap.items.set(id, snap.ghost); // the item glides from where it was let go
  const it = find(id);
  if (toTick && !ticked) {
    settling.delete(id);
    buzz(12);
    announce(t("{x} ticked", { x: it.text }));
    store.change(t("checking {x}", { x: q(it.text) }), [[id, "checked", true], [id, "checkedAt", Date.now()]]);
  } else if (!toTick) {
    const ul = li.parentElement, sec = ul.dataset.sec;
    const sibs = [...ul.children], i = sibs.indexOf(li);
    const prev = sibs[i - 1] && find(sibs[i - 1].dataset.id);
    const next = sibs[i + 1] && find(sibs[i + 1].dataset.id);
    const ops = [[id, "section", sec], [id, "pos", between(prev && prev.pos, next && next.pos)]];
    if (it.checked) { // dragged out of the ticked group, or just ticked: back on the list
      settling.delete(id);
      ops.push([id, "checked", false], [id, "checkedAt", 0]);
      announce(t("{x} back on the list", { x: it.text }));
    } else if (it.section !== sec) announce(t("{x} moved to {y}", { x: it.text, y: nameOf(sec) }));
    store.change(t(it.checked ? "unchecking {x}" : "moving {x}", { x: q(it.text) }), ops);
  }
  // Also when nothing changed, such as an item dropped where it started: it comes back into view.
  sync();
  paint(activeFk(), !!snap, false, snap);
  scheduleSettle();
}

/* Reordering sections */

// Sections are reordered folded down to their headings, so even long ones are easy to
// move. Each gets a new position in the new order, all in one step.
const orderOps = order => order.map((id, k) => ["#" + id, "pos", k + 1, (DEFAULTS.find(d => d.id === id) || {}).pos]);
function startSectionDrag(id, y) {
  landAll();
  const el = shells[id].el;
  const before = el.getBoundingClientRect().top;
  document.documentElement.classList.add("sorting");
  window.scrollBy(0, el.getBoundingClientRect().top - before); // its heading stays under your finger
  const r = el.getBoundingClientRect(), offY = Math.min(Math.max(y - r.top, 0), r.height);
  const copy = el.cloneNode(true);
  copy.replaceChildren(copy.querySelector(".sec-head"));
  const ghost = float(copy, r, "ghost", y - offY);
  el.classList.add("placeholder");
  beginDrag({ id, el, ghost, offY, y, place: placeSection, end: endSectionDrag });
}
function placeSection(y) {
  const list = $("#list");
  let before = null;
  for (const c of list.children) {
    if (c === drag.el) continue;
    const r = c.getBoundingClientRect();
    if (y < r.top + r.height / 2) { before = c; break; }
  }
  if (drag.el.nextElementSibling !== before) list.insertBefore(drag.el, before);
}
// Let go, the section stays where it was dropped, as far as the page allows: the sections
// above it unfold at once, upwards, out of the way, and it unfolds downwards with those
// below it.
function endSectionDrag() {
  const { id, el, ghost } = drag;
  const order = [...$("#list").children].map(c => c.dataset.sec);
  const dropped = ghost.getBoundingClientRect().top;
  const snap = letGo(); // folded: the sections unfold from here
  el.classList.remove("placeholder");
  if (store.change(t("moving section {x}", { x: q(nameOf(id)) }), orderOps(order))) announce(t("Section moved: {x}", { x: nameOf(id) }));
  sync();
  render();
  const head = el.querySelector(".sec-head"), page = document.documentElement;
  window.scrollBy(0, head.getBoundingClientRect().top - dropped);
  if (snap) {
    for (const p of snap.parts.keys()) if (p.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) snap.parts.delete(p);
    // The page keeps its full length while the sections below unfold, so it can stay scrolled.
    page.style.minHeight = page.scrollHeight + "px";
    setTimeout(() => { page.style.minHeight = ""; }, MOTION.duration + 100);
    const to = head.getBoundingClientRect(); // where it ends up, measured before anything glides
    glide(snap);
    fly(snap.ghost, to, head);
  }
  scheduleSettle();
}
// With a keyboard: Alt+↑ or Alt+↓ on a section's name.
function moveSection(id, dir) {
  const order = sections.map(s => s.id), i = order.indexOf(id), j = i + dir;
  if (j < 0 || j >= order.length) return;
  [order[i], order[j]] = [order[j], order[i]];
  announce(t(dir < 0 ? "{x} moved up" : "{x} moved down", { x: nameOf(id) }));
  act(t("moving section {x}", { x: q(nameOf(id)) }), orderOps(order), { focusKey: "name-" + id });
}

/* ---------- Motion ---------- */

// After a change, things glide to their new places. Sections and the ticked list
// grow or shrink to their new height, and what follows moves along with them; inside
// each, items and the Add item row slide to their new spot; an item that changes place,
// such as one being ticked, lifts, flies across and lands, taking longer the further it
// goes. New items fade in, removed ones fade out. Each element animates on its own, so
// taps keep working throughout, unlike with the browser's page-wide transitions.
const EASE = "cubic-bezier(0.4, 0, 0.2, 1)"; // gentle start, gentle landing
const LEAVE = "cubic-bezier(0.4, 0, 1, 1)"; // gentle start, then out of view at full speed
const MOTION = { duration: 400, easing: EASE };
const PACE = 0.8; // px per ms: every trip at the same speed, however long the list
const SHORTEST = 420; // ms, so a short hop still reads as a move
const PARTS = "#list > .sec, #basket-list";
const ITEMS = "#list .item[data-id], #basket-list .item[data-id]";
const ADDS = "#list > .sec > .add";
const flights = new Map(); // each flying item's animation, and how it lands
const glides = new Set(); // the glides under way, so a newer change takes over from them
function landAll() {
  for (const [a, land] of [...flights]) { a.cancel(); land(); }
}
const rectsOf = sel => new Map([...document.querySelectorAll(sel)].map(el => [el, el.getBoundingClientRect()]));
function snapshot() {
  landAll(); // one change at a time: anything still flying lands at once
  const its = new Map();
  for (const li of document.querySelectorAll(ITEMS)) its.set(li.dataset.id, { li, rect: li.getBoundingClientRect(), part: li.closest(PARTS) });
  return { parts: rectsOf(PARTS), adds: rectsOf(ADDS), items: its };
}
function glide(snap) {
  const seen = r => r && r.height > 0;
  // Where things are now, without the last change's motion: each glides on from where
  // the snapshot saw it.
  for (const a of glides) a.cancel();
  glides.clear();
  // Measure everything before moving anything.
  const parts = rectsOf(PARTS), adds = rectsOf(ADDS);
  const now = [...document.querySelectorAll(ITEMS)].map(li => ({ li, rect: li.getBoundingClientRect(), part: li.closest(PARTS) }));
  const head = $(".basket-head").getBoundingClientRect();
  // How far something moved within its section, leaving out the section's own movement.
  const inside = (wasRect, nowRect, part) => (wasRect.top - snap.parts.get(part).top) - (nowRect.top - parts.get(part).top);
  const run = (el, frames, opts = MOTION) => {
    const a = el.animate(frames, { ...opts, id: "glide" });
    glides.add(a);
    a.finished.then(() => glides.delete(a), () => {});
  };
  const slide = (el, dy) => { if (Math.abs(dy) > 0.5) run(el, [{ transform: `translateY(${dy}px)` }, { transform: "none" }]); };
  for (const [p, r] of parts) {
    const was = snap.parts.get(p);
    if (was && seen(r) && Math.abs(was.height - r.height) > 0.5) run(p, [{ height: was.height + "px" }, { height: r.height + "px" }]);
  }
  for (const [f, r] of adds) {
    const was = snap.adds.get(f), part = f.closest(PARTS);
    if (seen(was) && snap.parts.has(part)) slide(f, inside(was, r, part));
  }
  // Only items on screen, before or after, move: the rest are simply in their new place,
  // so a long list costs no more than a short one.
  const H = innerHeight, near = r => r.bottom > -100 && r.top < H + 100; // read once: each read can redo the layout
  const kept = new Set();
  for (const n of now) {
    const o = snap.items.get(n.li.dataset.id);
    kept.add(n.li.dataset.id);
    if (!o || !seen(o.rect)) { if (seen(n.rect) && near(n.rect)) n.li.animate([{ opacity: 0 }, { opacity: 1 }], MOTION); }
    else if (!seen(n.rect)) fly(o, head, null); // into the folded ticked group
    else if (!near(o.rect) && !near(n.rect)) continue;
    else if (o.part === n.part) slide(n.li, inside(o.rect, n.rect, n.part));
    else fly(o, n.rect, n.li);
  }
  for (const [id, o] of snap.items) if (!kept.has(id) && seen(o.rect) && near(o.rect)) fly(o, o.rect, null); // deleted
}
// A copy of the item (or the drag ghost) travels from its old place to the new one, over
// everything, and the real item shows when it lands; a deleted item's own row, gone from
// the list, travels itself. With no target, it fades away.
// It only travels as far as the screen shows: a place beyond the edge is reached at the
// edge, where the item slips out of view without slowing down, so a long list doesn't
// make it rush.
function fly(o, to, target) {
  const el = o.li.isConnected && !o.li.classList.contains("ghost") ? o.li.cloneNode(true) : o.li;
  const h = o.rect.height;
  const top = Math.min(Math.max(to.top, -h - 8), innerHeight + 8), leaving = top !== to.top;
  const dx = to.left - o.rect.left, dy = top - o.rect.top;
  const ms = target ? Math.round(Math.max(SHORTEST, Math.hypot(dx, dy) / PACE)) : 320;
  if (el.classList.contains("ghost")) el.classList.add("landing"); // let go after a drag
  else float(el, o.rect, "flying");
  el.style.animationDuration = ms + "ms"; // the lift and landing, in app.css
  if (target) target.style.opacity = "0";
  const move = `translate(${dx}px, ${dy}px)`;
  const a = el.animate([{ transform: "none" }, target ? { transform: move } : { transform: move + " scale(0.94)", opacity: 0 }], { duration: ms, easing: leaving ? LEAVE : EASE, id: "fly" });
  const land = () => {
    if (!flights.delete(a)) return;
    el.remove();
    if (target) target.style.opacity = "";
  };
  flights.set(a, land);
  a.finished.then(land, () => {});
}

/* ---------- Render ---------- */

// Undo floats at the bottom right; redo joins it once something has been undone. On the
// lists page, it brings back a list taken off this phone.
let undoNote = null, noteTimer = 0;
const top = a => (a.length ? a[a.length - 1].label : null);
function noteUndo(name) {
  clearTimeout(noteTimer);
  undoNote = name || null;
  if (undoNote) noteTimer = setTimeout(() => { undoNote = null; paintDock(); }, 5000);
}
function paintDock() {
  const onList = view === "list";
  const u = onList ? store.undoLabel() : top(removed), r = onList ? store.redoLabel() : null;
  $("#dock").hidden = !u && !r;
  setHist($("#undo"), u, "Undo");
  setHist($("#redo"), r, "Redo");
  $("#redo").hidden = !r;
  const named = !!(undoNote && u);
  $("#undo").classList.toggle("named", named);
  $("#undo-what").textContent = named ? undoNote : "";
}
function setHist(btn, label, verb) {
  btn.setAttribute("aria-disabled", String(!label));
  const text = label ? t(verb + " {x}", { x: label }) : t(verb);
  btn.setAttribute("aria-label", text);
  btn.title = text;
}
// The status pill appears only when something is wrong, after a moment, so a quick
// reconnect doesn't flash it. Tapping it says what happens next.
let statusTimer = 0, statusShown = "";
function statusInfo() {
  const { online, full, closed, waiting } = store.status();
  if (closed) return {
    text: t("List closed"), detail: t("Someone closed this list, for everyone. If they gave it a new key, ask them for the new link. What's here stays on this phone."),
    act: { label: t("Remove it from this phone"), run: () => { const lid = store.current(); leaveList(() => removeList(lid)); } },
  };
  if (store.newerFormat()) return { text: t("Update Panier"), detail: t("This list was changed with a newer Panier, which updates itself: close the app and open it again. Nothing is sent from here meanwhile.") };
  if (online && !full) return null;
  const kept = waiting
    ? plural(waiting, "{n} change is saved on this phone", "{n} changes are saved on this phone")
    : t("Changes you make are saved on this phone");
  if (full) return { text: t("List full"), detail: t("The server has no room left for this list. {kept}.", { kept }) };
  if (!navigator.onLine) return { text: t("Offline"), detail: t("No connection. {kept}, to be sent when you're back online.", { kept }) };
  return { text: t("Can't reach the server"), detail: t("The server isn't answering. {kept}, to be sent as soon as it answers.", { kept }) };
}
// On the lists page, only being offline is worth saying: the lists show as last seen.
const listsStatus = () => (!navigator.onLine && store.lists().length
  ? { text: t("Offline"), detail: t("No connection. Your lists show as this phone last saw them.") } : null);
function paintStatus() {
  if (view === "list") $("#pair-open").hidden = store.status().closed || store.newerFormat(); // a closed list's link opens nothing
  const now = () => (view === "lists" ? listsStatus() : view === "list" ? statusInfo() : null);
  const info = now();
  const el = $("#status");
  if (!info) {
    clearTimeout(statusTimer); statusTimer = 0;
    if (statusShown) announce(t("Back online"));
    statusShown = "";
    el.hidden = true;
    $("#status-detail").hidden = true;
    $("#status-pill").setAttribute("aria-expanded", "false");
    return;
  }
  const show = () => {
    statusTimer = 0;
    const s = now();
    if (!s) return;
    if (statusShown !== s.text) announce(s.text + ". " + s.detail);
    statusShown = s.text;
    $("#status-text").textContent = s.text;
    $("#status-detail").replaceChildren(s.detail, ...(s.act ? [" ", h("button", { type: "button", class: "linkbtn inline", onclick: s.act.run }, s.act.label)] : []));
    el.hidden = false;
  };
  if (statusShown) show();
  else if (!statusTimer) statusTimer = setTimeout(show, 2000);
}
$("#status-pill").addEventListener("click", () => {
  const d = $("#status-detail"), open = d.hidden;
  d.hidden = !open;
  $("#status-pill").setAttribute("aria-expanded", String(open));
});
addEventListener("online", paintStatus);
addEventListener("offline", paintStatus);

function render() {
  if (view !== "list" || !store.current()) return; // the lists page shows; the list draws when it's back
  const name = listName(), title = $("#list-name");
  if (editingId !== LIST && title.textContent !== name) title.textContent = name;
  title.setAttribute("aria-label", t("{x}, rename", { x: name }));
  document.title = name;
  if (window.panierList) window.panierList(listColor());
  computeSections();
  syncShells();
  // What the other phone changed is tinted where it is, without scrolling to it.
  const tint = store.takeFresh();
  if (flashId) tint.add(flashId);
  const kept = new Set();
  const fill = (ul, list) => { for (const i of list) kept.add(i.id); setRows(ul, list.map(i => rowOf(i, tint.has(i.id)))); };
  for (const s of sections) fill(shells[s.id].ul, shown(s.id));
  const since = Date.now() - RECENT_MS;
  const basket = items.filter(i => i.checked && !settling.has(i.id) && i.checkedAt >= since).sort((a, b) => b.checkedAt - a.checkedAt);
  $("#basket").classList.toggle("empty", basket.length === 0);
  // "3 ticked": true while shopping and after, unlike a basket; the last five days show, newest first
  $("#basket-count").textContent = plural(basket.length, "{n} ticked", "{n} ticked");
  $("#basket-toggle").setAttribute("aria-expanded", String(ui.basketOpen));
  const bl = $("#basket-list");
  fill(bl, basket);
  for (const id of rows.keys()) if (!kept.has(id)) rows.delete(id);
  bl.hidden = !ui.basketOpen;
  paintDock();
  paintStatus();

  if (flashId) {
    const li = rows.has(flashId) && rows.get(flashId).li;
    flashId = null;
    if (li) {
      const rect = li.getBoundingClientRect();
      if (!pointerIsDown && (rect.top < 0 || rect.bottom > innerHeight - 80)) {
        window.scrollBy({ top: rect.top - innerHeight / 3, behavior: reduceMotion.matches ? "auto" : "smooth" });
      }
    }
  }
}

/* Until someone has dragged once, the first item lifts briefly to show it can move */
function dragHint() {
  try { if (localStorage.getItem(HINT_KEY)) return; } catch (_) {}
  setTimeout(() => {
    const li = document.querySelector("#list .items .item");
    if (!li || drag || editingId) return;
    li.classList.add("hint");
    setTimeout(() => li.classList.remove("hint"), 1800);
  }, 800);
}

/* ---------- Sharing ---------- */

function qrSvg(textToEncode) {
  const qr = window.qrcode(0, "M");
  qr.addData(textToEncode);
  qr.make();
  const n = qr.getModuleCount(), pad = 4;
  let d = "";
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (!qr.isDark(r, c)) continue;
      let w = 1; // a run of dark squares is drawn as one
      while (c + w < n && qr.isDark(r, c + w)) w++;
      d += "M" + (c + pad) + " " + (r + pad) + "h" + w + "v1h-" + w + "z";
      c += w;
    }
  }
  const t = document.createElement("template");
  t.innerHTML = '<svg viewBox="0 0 ' + (n + 2 * pad) + " " + (n + 2 * pad) + '" shape-rendering="crispEdges" aria-hidden="true"><rect width="100%" height="100%" fill="#fff"/><path d="' + d + '" fill="#000"/></svg>';
  return t.content.firstChild;
}
// Sheets (sharing, Settings) open as a step in the browser's history, so the phone's
// back gesture closes them like a page. So does a list opened from the lists page: back
// returns to it. Each opening is its own step, so one left over from before a reload
// doesn't count.
const sheetOf = () => (history.state && history.state.sheet) || null;
function openSheet(dlg) {
  dlg.showModal();
  dlg.focus(); // the sheet itself, not its first button, which would show a focus ring
  dlg.dataset.step = Date.now() + "-" + Math.random();
  history.pushState({ sheet: dlg.dataset.step }, "");
}
for (const dlg of document.querySelectorAll("dialog")) {
  dlg.addEventListener("close", () => { if (dlg.dataset.step && sheetOf() === dlg.dataset.step) history.back(); });
}
addEventListener("popstate", () => {
  for (const dlg of document.querySelectorAll("dialog[open]")) if (sheetOf() !== dlg.dataset.step) dlg.close();
  if (sheetOf()) return;
  const want = history.state && history.state.list;
  if (want) { if (view !== "list" || shownLid !== want) showList(want, { push: false }); }
  else if (view !== "lists") showLists();
});
// fn runs once the step back in history has landed; closeThen closes a sheet first.
function afterBack(fn) {
  let done = false;
  const go = () => { if (done) return; done = true; removeEventListener("popstate", go); setTimeout(fn, 0); };
  addEventListener("popstate", go);
  setTimeout(go, 500);
}
function closeThen(dlg, fn) {
  if (!dlg.open) return fn();
  afterBack(fn);
  dlg.close();
}

// The QR code library is only needed here, so it loads the first time the sheet opens.
let qrLib = null, shared = "";
const loadQr = () => (qrLib ||= new Promise((resolve, reject) => {
  document.head.append(h("script", { src: "vendor/qrcode.js", onload: resolve, onerror: () => { qrLib = null; reject(); } }));
}));
// The sheet shares one list, with who's on it; or, all of this phone's lists at once,
// to set up another phone.
function openPair(all = false) {
  shared = all ? store.allLink() : store.pairingLink();
  $("#pair-title").textContent = all ? t("Set up another phone") : t("Add someone to this list");
  $("#pair-text").textContent = all ? t("Scan this code with the other phone, and it has every list this one has.")
    : t("They scan this code with their phone, or open the link you send them.");
  $("#pair-note").textContent = all ? t("This link holds the keys to all your lists: anyone who has it can open them. Keep it to yourself.")
    : t("This link is the key to your list: anyone who has it can open it. Keep a copy in your password manager to recover the list if you lose your phones.");
  $("#people").hidden = all;
  if (!all) paintPeople();
  $("#qr").replaceChildren();
  $("#share-link").hidden = !navigator.share;
  openSheet($("#pair"));
  loadQr().then(() => $("#qr").replaceChildren(qrSvg(shared)), () => {});
}
// Who has the list: each phone writes itself onto it, with the name its owner gave in
// Settings, if any. The server sees none of it.
function paintPeople() {
  const others = store.members().filter(m => !m.me);
  const named = others.filter(m => m.name).map(m => m.name), nameless = others.length - named.length;
  const who = [t("you"), ...named];
  if (nameless) who.push(plural(nameless, "{n} phone without a name", "{n} phones without a name"));
  $("#members").textContent = others.length ? t("On this list: {x}.", { x: new Intl.ListFormat(lang, { type: "conjunction" }).format(who) }) : t("Only you, so far.");
  $("#rekey-open").hidden = !others.length; // removing someone needs someone to remove
}
$("#pair-open").addEventListener("click", () => openPair());
$("#pair-close").addEventListener("click", () => $("#pair").close());
$("#share-link").addEventListener("click", () => {
  navigator.share({ title: $("#people").hidden ? "Panier" : listName(), url: shared }).catch(() => {});
});
$("#copy-link").addEventListener("click", async e => {
  const b = e.currentTarget;
  try {
    await navigator.clipboard.writeText(shared);
    b.textContent = t("Copied");
  } catch (_) {
    b.textContent = t("Couldn't copy");
  }
  setTimeout(() => { b.textContent = t("Copy link"); }, 2000);
});

// Changing a list's key and deleting it for everyone are the only things that ask first:
// neither can be undone.
function confirmSheet({ title, text, ok, run }) {
  $("#confirm-title").textContent = title;
  $("#confirm-text").textContent = text;
  $("#confirm-ok").textContent = ok;
  $("#confirm-error").hidden = true;
  const btn = $("#confirm-ok");
  btn.disabled = false;
  btn.onclick = async () => {
    btn.disabled = true;
    try {
      await run();
    } catch (err) {
      $("#confirm-error").textContent = err.message === "full" ? t("This server can't make another list from this one.") : t("Couldn't reach the server. Check your connection and try again.");
      $("#confirm-error").hidden = false;
      btn.disabled = false;
    }
  };
  openSheet($("#confirm"));
}
$("#confirm-cancel").addEventListener("click", () => $("#confirm").close());
// Someone shouldn't have the list any more: it moves to a new key, and the old one is
// closed, for everyone. The people who should keep it get the new link.
$("#rekey-open").addEventListener("click", () => closeThen($("#pair"), () => confirmSheet({
  title: t("Remove someone from {x}?", { x: q(listName()) }),
  text: t("The list moves to a new key. Everyone who has it now loses it, on every phone but this one, though they keep what they had. Then send the new link to those who should keep it."),
  ok: t("Give it a new key"),
  run: async () => {
    await store.changeKey();
    announce(t("{x} has a new key", { x: listName() }));
    closeThen($("#confirm"), () => openPair());
  },
})));
$("#delete-open").addEventListener("click", () => closeThen($("#pair"), () => confirmSheet({
  title: t("Delete {x} for everyone?", { x: q(listName()) }),
  text: t("It goes from the server, and from every phone that has it as soon as they open it. This can't be undone."),
  ok: t("Delete"),
  run: async () => {
    const lid = store.current(), name = listName();
    await store.deleteForEveryone(lid);
    closeThen($("#confirm"), () => leaveList(() => announce(t("Deleted {x} for everyone", { x: name }))));
  },
})));

/* ---------- Markdown, out and in ---------- */

// A list as Export writes it: its sections as on screen, each with its items to get,
// then those bought before, latest first.
function sheetOfList({ name, color, sections: stored, items: its }) {
  const { shown } = layout(stored, its);
  const at = new Map(shown.map((s, k) => [s.id, k]));
  const secs = shown.map(s => ({ name: s.name, color: s.color, items: [] }));
  for (const i of its.filter(i => !i.checked).sort((a, b) => a.pos - b.pos)) secs[at.get(i.section) ?? 0].items.push({ text: i.text, checked: false });
  for (const i of its.filter(i => i.checked).sort((a, b) => b.checkedAt - a.checkedAt)) secs[at.get(i.section) ?? 0].items.push({ text: i.text, checked: true });
  return { name: name || t("Shopping list"), color: color || "", sections: secs };
}
function download(name, text) {
  const now = new Date();
  const day = [now.getFullYear(), now.getMonth() + 1, now.getDate()].map(n => String(n).padStart(2, "0")).join("-");
  const file = keyOf(name).replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "") || "panier";
  const url = URL.createObjectURL(new Blob([text], { type: "text/markdown;charset=utf-8" }));
  const a = h("a", { href: url, download: file + "-" + day + ".md", hidden: true });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}
function exportList() {
  download(listName(), toMarkdown([sheetOfList({ name: listName(), color: listColor(), sections: store.sections(), items })]));
}
function exportAll() {
  download("Panier", toMarkdown(store.lists().map(e => sheetOfList(store.peek(e.lid)))));
}
$("#export-btn").addEventListener("click", exportList);
$("#export-all").addEventListener("click", exportAll);

// The changes that make a list as read from Markdown: its sections in order, the three
// a list starts with kept when a section has one of their names, the others deleted;
// each name once; what was bought before kept out of the ticked group, to be suggested.
function importOps(l) {
  const ops = [], used = new Set(), colours = new Set(), seen = new Set();
  const old = Date.now() - RECENT_MS - 864e5;
  let n = 0, k = 0;
  if (l.name) ops.push([LIST, "name", clean(l.name, MAX_SECTION)]);
  if (l.color && LIST_COLORS.some(([c]) => c === l.color)) ops.push([LIST, "color", l.color]);
  l.sections.forEach((sec, i) => {
    const name = sec.name ? clean(sec.name, MAX_SECTION) : "";
    const d = DEFAULTS.find(d => !used.has(d.id) && (name ? [d.name, d.en].some(x => keyOf(x) === keyOf(name)) : true));
    const id = d ? d.id : store.newId(), key = "#" + id;
    const color = colorOk(sec.color, d ? d.color : PALETTE.find(c => !colours.has(c)) || PALETTE[0]);
    used.add(id);
    colours.add(color);
    ops.push([key, "name", name || (d ? d.name : t("Untitled"))], [key, "pos", i + 1], [key, "color", color], [key, "deleted", false]);
    sec.items.forEach((it, j) => {
      const text = clean(it.text), nk = text && nameKey(text);
      if (!text || seen.has(nk)) return;
      seen.add(nk);
      const iid = store.newId();
      ops.push([iid, "text", text], [iid, "section", id], [iid, "pos", j + 1], [iid, "deleted", false]);
      if (it.checked) ops.push([iid, "checked", true], [iid, "checkedAt", old - k++]);
      n++;
    });
  });
  if (l.sections.length) for (const d of DEFAULTS) if (!used.has(d.id)) ops.push(["#" + d.id, "deleted", true]);
  return { ops, n };
}
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
    if (lids.length === 1) showList(lids[0]);
    else renderLists();
  });
});

/* ---------- Settings ---------- */

const THEME_KEY = "panier-theme", LAYOUT_KEY = "panier-layout";
// Asks the browser to keep the lists even when the phone runs low on space. Firefox
// asks you once; Chrome decides for itself. Returns whether they're kept, or null if unknown.
async function keepList() {
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

/* ---------- The lists page ---------- */

// Each list lies on the page as a sheet in its own tint: its name, what's left to get and
// the first two of those, as this phone last saw them. Tap to open it; hold to drag it
// up or down, or onto the zone at the foot that takes it off this phone.
const listColorOk = c => (c && LIST_COLORS.some(([id]) => id === c) ? c : null);
const countOf = e => (e.closed ? t("Closed") : e.newer ? t("Update Panier to open it") : e.toGet ? plural(e.toGet, "{n} to get", "{n} to get") : t("Nothing to get"));
// Each sheet keeps its element from one drawing to the next, and only what changed is
// written, so a sheet held or focused stays as it is while the lists catch up.
const cards = new Map(); // list id → { li, btn, name, count, first, shown }
function cardOf(e) {
  let c = cards.get(e.lid);
  if (!c) {
    const name = h("span", { class: "sheet-name" }), count = h("span", { class: "sheet-count" }), first = h("span", { class: "sheet-first", "aria-hidden": "true" });
    const btn = h("button", { type: "button", class: "sheet-open", dataset: { fk: "sheet-" + e.lid } }, h("span", { class: "sheet-head", "aria-hidden": "true" }, name, count), first);
    const li = h("li", { class: "sheet-card", "data-lid": e.lid }, btn);
    btn.addEventListener("click", () => { if (suppressClick) { suppressClick = false; return; } showList(e.lid); });
    btn.addEventListener("keydown", ev => {
      if (ev.altKey && (ev.key === "ArrowUp" || ev.key === "ArrowDown")) { ev.preventDefault(); moveSheet(e.lid, ev.key === "ArrowUp" ? -1 : 1); }
    });
    bindPress(li, { can: () => true, start: (offY, y) => startSheetDrag(li, e.lid, offY, y) });
    cards.set(e.lid, (c = { li, btn, name, count, first, shown: "" }));
  }
  const nm = e.name || t("Shopping list"), cnt = countOf(e), gone = !!(e.closed || e.newer), first = gone ? [] : e.first || [];
  const shown = JSON.stringify([nm, cnt, first, e.color, gone]);
  if (c.shown !== shown) {
    c.shown = shown;
    c.name.textContent = nm;
    c.count.textContent = cnt;
    c.first.replaceChildren(...first.map(x => { const sp = h("span"); fillText(sp, x); return h("span", { class: "sheet-item" }, sp); }));
    c.btn.setAttribute("aria-label", nm + ", " + cnt);
    const col = listColorOk(e.color);
    if (col) c.li.dataset.color = col; else delete c.li.dataset.color;
    c.li.classList.toggle("gone", gone);
  }
  return c.li;
}
// The page asks for the setup code for the first list, or when the server won't make one
// otherwise; notice says what went wrong last, until the next thing tried.
let needCode = false, notice = "";
function renderLists() {
  if (view !== "lists" || drag) return;
  const fk = activeFk(), all = store.lists(), first = !all.length;
  setRows($("#sheets"), all.map(cardOf));
  for (const lid of cards.keys()) if (!all.some(e => e.lid === lid)) cards.delete(lid);
  $("#new-list-form").hidden = first;
  $("#setup-form").hidden = !first && !needCode;
  const msg = notice || (needCode ? t("This server wants its setup code for this.")
    : first ? t("Open the link from a phone that already has a list, or start one with your server's setup code.") : "");
  $("#lists-msg").textContent = msg;
  $("#lists-msg").hidden = !msg;
  $("#setup-label").textContent = first ? t("Your server's setup code, to start the first list") : t("Your server's setup code");
  if (fk) { const el = document.querySelector('[data-fk="' + fk + '"]'); if (el && el !== document.activeElement) el.focus({ preventScroll: true }); }
  paintDock();
}
const say = msg => { notice = msg; renderLists(); announce(msg); };

function startSheetDrag(li, lid, offY, y) {
  const ghost = float(li.cloneNode(true), li.getBoundingClientRect(), "ghost", y - offY);
  li.classList.add("placeholder");
  document.documentElement.classList.add("dragging-sheet");
  const before = store.lists().map(e => e.lid).join();
  // The page scrolls before the zone at the foot, not over it, so a sheet can go last.
  const bottom = $("#remove-drop").getBoundingClientRect().top - 8;
  beginDrag({ lid, li, ghost, offY, y, toRemove: false, before, bottom, place: placeSheet, end: endSheetDrag });
}
function placeSheet(y) {
  const zone = $("#remove-drop"), over = y > zone.getBoundingClientRect().top - 8;
  if (over !== drag.toRemove) {
    drag.toRemove = over;
    zone.classList.toggle("over", over);
    drag.li.classList.toggle("away", over);
    drag.ghost.classList.toggle("leaving", over);
    if (over) buzz(8);
  }
  if (over) return;
  const ul = $("#sheets");
  let before = null;
  for (const c of ul.children) {
    if (c === drag.li) continue;
    const r = c.getBoundingClientRect();
    if (y < r.top + r.height / 2) { before = c; break; }
  }
  if (drag.li.nextElementSibling !== before) ul.insertBefore(drag.li, before);
}
function endSheetDrag() {
  const { lid, li, toRemove, ghost, before } = drag;
  const order = [...$("#sheets").children].map(c => c.dataset.lid);
  ghost.remove();
  li.classList.remove("placeholder", "away"); // the same sheet stays on the page
  $("#remove-drop").classList.remove("over");
  document.documentElement.classList.remove("dragging-sheet");
  drag = null;
  if (toRemove) return removeList(lid);
  if (order.join() !== before) store.reorder(order);
  renderLists();
}
function moveSheet(lid, dir) {
  const order = store.lists().map(e => e.lid), i = order.indexOf(lid), j = i + dir;
  if (j < 0 || j >= order.length) return;
  [order[i], order[j]] = [order[j], order[i]];
  store.reorder(order);
  const e = store.lists().find(x => x.lid === lid);
  announce(t(dir < 0 ? "{x} moved up" : "{x} moved down", { x: e.name || t("Shopping list") }));
  renderLists();
  const el = document.querySelector('[data-fk="sheet-' + lid + '"]');
  if (el) el.focus();
}

// Taking a list off this phone can be undone, until the app closes; the list stays on
// the server for the others, and its link brings it back.
const removed = [];
function removeList(lid) {
  const e = store.lists().find(x => x.lid === lid);
  if (!e) return;
  const name = e.name || t("Shopping list"), dk = "panier2-drafts:" + lid;
  let drafts = null;
  try { drafts = localStorage.getItem(dk); localStorage.removeItem(dk); } catch (_) {}
  removed.push({ label: t("removing {x}", { x: q(name) }), r: store.remove(lid), drafts, dk });
  noteUndo(name);
  announce(t("Removed {x} from this phone", { x: name }));
  renderLists();
}
function undoRemove() {
  const u = removed.pop();
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
let pending = null;
async function create(make, done) {
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
  }
}
addRow($("#new-list-form"), $("#new-list"), {
  add: () => {
    const name = clean($("#new-list").value, MAX_SECTION);
    if (!name) return;
    $("#new-list").value = "";
    $("#new-list-form").classList.remove("typing");
    create(code => store.createList({ code, name }), lid => { announce(t("Added {x}", { x: name })); showList(lid); });
  },
  clear: () => { $("#new-list").value = ""; $("#new-list-form").classList.remove("typing"); },
});
const MESSAGES = {
  code: t("That setup code didn't work. Check it on the server and try again."),
  link: t("That link is incomplete. Ask for the link again from the phone that has the list."),
  server: t("Couldn't reach the server. Check your connection and try again."),
};
$("#setup-form").addEventListener("submit", async e => {
  e.preventDefault();
  const code = $("#setup-code").value;
  if (!code.trim()) return;
  const p = pending || { make: c => store.createList({ code: c }), done: lid => { showList(lid); openPair(); keepList(); } };
  try {
    const r = await p.make(code);
    pending = null;
    needCode = false;
    notice = "";
    $("#setup-code").value = "";
    p.done(r);
  } catch (err) {
    say(MESSAGES[err.message] || MESSAGES.server);
  }
});

/* ---------- Wiring and start ---------- */

// Adding a section moves the cursor to its Add item field.
addRow($("#add-sec-form"), $("#add-sec"), {
  add: () => addSection($("#add-sec").value),
  clear: () => { $("#add-sec").value = ""; $("#add-sec-form").classList.remove("typing"); },
});
$("#list-name").addEventListener("click", e => { if (editingId !== LIST) editListName(e.currentTarget, e.clientX, e.clientY); });
$("#list-name").addEventListener("keydown", e => {
  if (editingId === LIST) return;
  if (e.key === "Enter" || e.key === " " || e.key === "F2") { e.preventDefault(); editListName(e.currentTarget); }
});
$("#lists-open").addEventListener("click", () => leaveList());
$("#undo").addEventListener("click", undo);
$("#redo").addEventListener("click", redo);
document.addEventListener("keydown", e => {
  const a = document.activeElement;
  if (!(e.ctrlKey || e.metaKey) || (a && (a.type === "text" || a.isContentEditable))) return;
  const k = e.key.toLowerCase();
  if (k === "z" && !e.shiftKey) { e.preventDefault(); undo(); }
  else if ((k === "z" && e.shiftKey) || k === "y") { e.preventDefault(); redo(); }
});
$("#basket-toggle").addEventListener("click", () => {
  ui.basketOpen = !ui.basketOpen;
  store.setFolded(shownLid, !ui.basketOpen);
  paint(null, false);
});
// Back on screen, or back online, the lists page catches up too.
document.addEventListener("visibilitychange", () => {
  if (document.hidden) return;
  if (view === "lists") store.refreshAll();
  else if (view === "list" && !editingId && !drag) paint(activeFk(), false);
});
addEventListener("online", () => { if (view === "lists") store.refreshAll(); });
store.subscribe(kind => {
  if (kind === "lists") renderLists();
  else if (view !== "list") return;
  else if (kind === "remote") {
    refreshFromStore();
    if ($("#pair").open && !$("#people").hidden) paintPeople(); // someone joined, or named themselves
  }
  else if (kind === "status" || kind === "local") paintStatus();
});

// A list is on screen from the lists page, a step on in history, so back returns there.
function resetView() {
  closeSug();
  landAll();
  clearTimeout(settleTimer);
  for (const id of Object.keys(shells)) { shells[id].el.remove(); delete shells[id]; }
  rows.clear();
  settling.clear();
  items = [];
  sections = [];
  sectionInfo = new Map();
  flashId = null;
  lastSplit = null;
  noteUndo(null);
}
function showList(lid, { push = true } = {}) {
  if (!store.open(lid)) {
    history.replaceState({}, "");
    return showLists();
  }
  const switched = shownLid !== lid;
  if (switched) resetView();
  notice = "";
  shownLid = lid;
  view = "list";
  if (push) history.pushState({ list: lid }, "");
  $("#lists").hidden = true;
  $("#app").hidden = false;
  if (window.panierView) window.panierView("");
  const e = store.lists().find(x => x.lid === lid);
  ui.basketOpen = !(e && e.folded);
  items = store.items();
  render();
  if (switched) window.scrollTo(0, 0);
  // Text left in an "Add item" field when the app was closed becomes an item now.
  for (const [sec, text] of Object.entries(loadDrafts())) {
    const target = shells[sec] ? sec : sections[0].id;
    shells[target].input.value = text;
    submitAdd(target, true);
  }
  try { localStorage.removeItem(draftsKey()); } catch (_) {}
  dragHint();
}
function showLists() {
  if (view === "list") { closeSug(); store.leave(); }
  view = "lists";
  $("#app").hidden = true;
  $("#lists").hidden = false;
  if (window.panierView) window.panierView("lists");
  document.title = "Panier";
  store.refreshAll();
  renderLists();
  paintStatus();
  window.scrollTo(0, 0);
}
// Back to the lists page, as the back gesture does; then runs fn.
function leaveList(fn) {
  if (history.state && history.state.list) {
    afterBack(() => { if (view !== "lists") showLists(); if (fn) fn(); });
    history.back();
  } else {
    history.replaceState({}, "");
    showLists();
    if (fn) fn();
  }
}

// The app opens on the list last used, or the lists page when there's none. A link adds
// the lists it holds: with one, that list opens.
async function init() {
  const params = new URLSearchParams(location.hash.slice(1));
  if (location.hash) history.replaceState(null, "", location.pathname); // keep keys out of history
  const keys = store.keysIn(params.get("k"));
  if (params.has("k") && !keys.length) say(MESSAGES.link);
  if (keys.length) {
    const lids = store.addKeys(keys);
    keepList();
    return begin(lids.length === 1 ? lids[0] : null, lids.length > 1);
  }
  if (params.get("setup") && !store.lists().length) {
    try {
      const lid = await store.createList({ code: params.get("setup") });
      begin(lid);
      openPair();
      keepList();
      return;
    } catch (err) {
      say(MESSAGES[err.message] || MESSAGES.server);
    }
  }
  const st = history.state;
  if (st && st.list && store.lists().some(e => e.lid === st.list)) { showList(st.list, { push: false }); store.refreshAll(); return; }
  begin(null);
}
function begin(lid, toLists = false) {
  history.replaceState({}, "");
  const open = lid || (!toLists && store.openId());
  if (open && store.lists().some(e => e.lid === open)) {
    showList(open);
    store.refreshAll(); // the others send what they have waiting
  } else showLists();
}
translatePage();
init();
// A pairing or setup link opened in this tab, with the app already open: it starts afresh
// from the link, as when opened anew.
addEventListener("hashchange", () => { if (/^#(k|setup)=/.test(location.hash)) location.reload(); });

/* ---------- Updates ---------- */

// A new version installs in the background. When it takes over, the app reloads into it,
// waiting first for anything in progress: editing, typing, dragging or the pairing sheet.
function busy() {
  return !!(editingId || drag || lifted || pointerIsDown || document.querySelector("dialog[open]") ||
    $("#add-sec").value.trim() || $("#new-list").value.trim() || $("#setup-code").value.trim() || Object.values(shells).some(sh => sh.input.value.trim()));
}
function reloadWhenIdle() {
  if (busy()) setTimeout(reloadWhenIdle, 1000);
  else location.reload();
}
if ("serviceWorker" in navigator) {
  // The first takeover on a first visit only installs the version this page already runs;
  // every takeover after that is a new version.
  let controlled = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (controlled) reloadWhenIdle();
    controlled = true;
  });
  navigator.serviceWorker.register("sw.js").then(reg => {
    // Phones keep apps open for days; look for a new version whenever Panier comes back.
    document.addEventListener("visibilitychange", () => { if (!document.hidden) reg.update().catch(() => {}); });
  }).catch(() => {});
}
