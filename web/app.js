import * as store from "./store.js";
import { t, plural, q, lang, translatePage } from "./i18n.js";

// The three sections every list starts with. They can be renamed, recoloured or deleted like any other.
const DEFAULTS = [
  { id: "ess", name: t("Essentials"), color: "ess", pos: 1 },
  { id: "look", name: t("Look out for"), color: "look", pos: 2 },
  { id: "long", name: t("Long term"), color: "long", pos: 3 },
];
// Section colours, in palette order; each is a colour in app.css, light and dark.
const COLORS = [["ess", "Green"], ["teal", "Teal"], ["blue", "Blue"], ["long", "Indigo"], ["plum", "Plum"], ["rose", "Rose"], ["look", "Amber"], ["olive", "Olive"]];
const PALETTE = ["teal", "rose", "blue", "olive", "plum", "ess", "look", "long"]; // new sections take the first unused
const colorOk = (c, fallback) => (COLORS.some(([id]) => id === c) ? c : fallback);
const MAX_ITEM = 120; // four lines on a phone
const MAX_SECTION = 40; // and the list's name
const LIST = "@list"; // where the list's own name is kept, among items and sections
const listName = () => store.listName() || t("Shopping list");
const SETTLE_MS = 1500;
const TRIP_MS = 12 * 3600 * 1000;
const LONG_PRESS_MS = 450;
const HINT_KEY = "panier-dragged-once";
const DRAFTS_KEY = "panier-drafts"; // text typed into "Add item" fields, kept until added
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
const nameKey = s => keyOf(splitQty(s).name);
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
try { ui.basketOpen = localStorage.getItem("panier-basket-open") !== "0"; } catch (_) {}

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
const SVG = (w, body, extra = "") => '<svg viewBox="0 0 20 20" width="' + w + '" height="' + w + '" aria-hidden="true"' + extra + '>' + body + "</svg>";
const STROKE = 'fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"';
const ICONS = {
  plus: SVG(18, '<path d="M10 4v12M4 10h12" ' + STROKE + ' stroke-width="1.95"/>'),
  back: SVG(16, '<path d="M7.5 4.4L3.1 8.75l4.4 4.35M3.75 8.75h8.75a4.4 4.4 0 0 1 0 8.75H10" ' + STROKE + ' stroke-width="2.2"/>'),
  cross: SVG(16, '<path d="M5.5 5.5l9 9M14.5 5.5l-9 9" ' + STROKE + ' stroke-width="2.2"/>'),
};
function icon(name) {
  const t = document.createElement("template");
  t.innerHTML = ICONS[name];
  return t.content.firstChild;
}

const find = id => items.find(i => i.id === id);
const nameOf = id => (sectionInfo.get(id) || { name: t("this section") }).name;
const colorOf = id => (sectionInfo.has(id) ? sectionInfo.get(id).color : "muted");
const isShown = id => sections.some(s => s.id === id);
const inList = i => !i.checked || settling.has(i.id);
const shown = sec => items.filter(i => i.section === sec && inList(i)).sort((a, b) => a.pos - b.pos || (a.id < b.id ? -1 : 1));
const maxPos = sec => shown(sec).reduce((m, i) => Math.max(m, i.pos), 0);
const onScreen = i => inList(i) || i.checkedAt >= Date.now() - TRIP_MS;
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
// get, or text being typed into it, even if the other phone deleted it meanwhile.
function computeSections() {
  const stored = new Map(store.sections().map(s => [s.id, s]));
  const all = new Map();
  for (const d of DEFAULTS) {
    const st = stored.get(d.id) || {};
    all.set(d.id, { ...d, name: st.name ?? d.name, color: colorOk(st.color, d.color), pos: st.pos ?? d.pos, deleted: !!st.deleted });
  }
  for (const st of stored.values()) {
    if (!all.has(st.id)) all.set(st.id, { id: st.id, name: st.name || t("Untitled"), color: colorOk(st.color, PALETTE[0]), pos: st.pos ?? 100, deleted: st.deleted });
  }
  const used = new Set(items.filter(inList).map(i => i.section));
  for (const [id, sh] of Object.entries(shells)) if (sh.input.value.trim()) used.add(id);
  for (const id of used) if (!all.has(id)) all.set(id, { id, name: t("Untitled"), color: PALETTE[0], pos: 100, deleted: false });
  sectionInfo = all;
  sections = [...all.values()].filter(s => !s.deleted || used.has(s.id)).sort((a, b) => a.pos - b.pos || (a.id < b.id ? -1 : 1));
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

// act records one undoable step and redraws.
function act(label, ops, opts = {}) {
  const fk = opts.focusKey || activeFk();
  if (!store.change(label, ops)) return false;
  items = store.items();
  if (opts.leaving) whenTapEnds(leftPaint);
  else paint(fk, opts.animate, !!opts.focusKey);
  return true;
}
// The redraw after leaving a field waits for anything that tap started, such as editing
// another item, so the item being edited isn't redrawn under the cursor.
function leftPaint() {
  if (editingId || drag) renderPending = true;
  else paint(null, false);
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
    if (t && t !== now && untouched && (move || !was || !was.isConnected)) t.focus({ preventScroll: true });
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
  if (editingId || drag) { renderPending = true; return; }
  sync();
  paint(activeFk(), false);
}
function step(fn, done, nothing) {
  const r = fn();
  if (!r) return;
  announce(r.done ? t(done, { x: r.label }) : t(nothing));
  refreshFromStore();
  scheduleSettle();
}
const undo = () => step(store.undo, "Undid {x}", "Nothing to undo: the other phone already changed it");
const redo = () => step(store.redo, "Redid {x}", "Nothing to redo: the other phone already changed it");

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
  try { return JSON.parse(localStorage.getItem(DRAFTS_KEY)) || {}; } catch (_) { return {}; }
}
function saveDraft(sec, text) {
  const d = loadDrafts();
  if (text) d[sec] = text; else delete d[sec];
  try { localStorage.setItem(DRAFTS_KEY, JSON.stringify(d)); } catch (_) {}
}
function clearAdd(sec) {
  shells[sec].input.value = "";
  shells[sec].form.classList.remove("typing");
  saveDraft(sec, "");
  if (ui.sugSec === sec) closeSug(); // not another field's, typed into just after leaving this one
}
// Puts an item bought before back on the list as text, into sec: picked from its
// suggestion, or, when added, typed in full.
function revive(id, sec, text, opts = {}, added = false) {
  clearAdd(sec);
  text = clean(text);
  settling.delete(id);
  flashId = id;
  announce(added ? t("Added {x}", { x: text }) : t("{x} back on the list", { x: text }));
  act(added ? t("adding {x}", { x: q(text) }) : t("putting back {x}", { x: q(text) }),
    [[id, "text", text], [id, "section", sec], [id, "pos", maxPos(sec) + 1], [id, "checked", false], [id, "checkedAt", 0]], opts);
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
  act(t("adding {x}", { x: q(text) }), [[id, "text", text], [id, "section", sec], [id, "pos", maxPos(sec) + 1],
    [id, "checked", false], [id, "checkedAt", 0], [id, "deleted", false]], opts);
}
function del(id, opts) {
  const it = find(id);
  settling.delete(id);
  announce(t("Deleted {x}", { x: it.text }));
  act(t("deleting {x}", { x: q(it.text) }), [[id, "deleted", true]], opts);
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
  act(t("deleting section {x}", { x: q(name) }), [["#" + id, "deleted", true, false]]);
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
function editSection(span, id, x, y) {
  const orig = nameOf(id);
  const keep = e => e.preventDefault();
  const palette = h("div", { class: "palette", role: "group", "aria-label": t("Colour of {x}", { x: orig }) },
    COLORS.map(([c, label]) => h("button", {
      type: "button", class: "swatch", style: "--c:var(--" + c + ")", "aria-label": t(label),
      "aria-pressed": String(colorOf(id) === c), onpointerdown: keep, onmousedown: keep,
      onclick: e => {
        for (const b of palette.children) b.setAttribute("aria-pressed", String(b === e.currentTarget));
        recolour(id, c, label);
      },
    })));
  editInPlace(span, {
    key: "#" + id, row: span.closest(".sec-head"), orig, max: MAX_SECTION, x, y, below: palette,
    onDelete: canDelete(id) ? () => deleteSection(id) : null, deleteLabel: t("Delete section {x}", { x: orig }),
    onSave: name => renameSection(id, name),
  });
}
// The list's name, at the top, is renamed the same way as a section's.
function editListName(span, x, y) {
  const orig = listName();
  editInPlace(span, {
    key: LIST, row: span.parentNode, orig, max: MAX_SECTION, x, y,
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
  if (n.length < 3) return [];
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
  act(t("removing {x} from suggestions", { x: q(name) }), [[id, "deleted", true]], { animate: false });
  updateSug(sec);
  if (keyboard && ui.sug.length) {
    ui.sugIndex = Math.min(was, ui.sug.length - 1);
    ui.sugCol = 1;
    paintSug(sec, ui.sug);
  }
}

/* ---------- Section cards, kept between renders so a focused field keeps its keyboard ---------- */

const shells = {};
function buildShell(id) {
  const ul = h("ul", { class: "items", "data-sec": id });
  const input = h("input", {
    type: "text", class: "add-input", id: "add-" + id, placeholder: t("Add item"),
    maxlength: String(MAX_ITEM), enterkeyhint: "enter", autocomplete: "off", autocapitalize: "sentences", spellcheck: "false",
    role: "combobox", "aria-autocomplete": "list", "aria-haspopup": "grid", "aria-expanded": "false", "aria-controls": "sug-" + id,
    dataset: { fk: "add-" + id },
  });
  // Once something is typed, a cross at the end of the row throws it away, as one deletes
  // an item being edited. The cursor stays in the field, ready for the next one.
  const keep = e => e.preventDefault(); // pressing the cross doesn't leave the field, which would add the item
  const clear = h("button", {
    type: "button", class: "bin add-x", tabindex: "-1", "aria-label": t("Clear"),
    onpointerdown: keep, onmousedown: keep, onclick: () => { clearAdd(id); input.focus(); },
  }, icon("cross"));
  const form = h("form", { class: "add", autocomplete: "off", onsubmit: e => { e.preventDefault(); submitAdd(id); } },
    h("label", { class: "add-plus", for: "add-" + id, "aria-hidden": "true" }, icon("plus")), input, clear);
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
    form.classList.toggle("typing", !!input.value.trim());
    saveDraft(id, input.value.trim() ? input.value : "");
    updateSug(id);
  });
  input.addEventListener("focus", () => updateSug(id));
  input.addEventListener("blur", () => {
    if (ui.sugSec === id) closeSug();
    // Leaving the field adds the item, but not when the whole app loses focus (a
    // notification, another app): the text is kept and you carry on typing.
    setTimeout(() => {
      if (document.hasFocus() && document.activeElement !== input && shells[id] === sh) submitAdd(id, true);
    }, 0);
  });
  input.addEventListener("keydown", e => {
    if (e.key === "Escape") { // first the suggestions, then what was typed
      if (ui.sugSec === id) closeSug(); else clearAdd(id);
      return;
    }
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
    if (editingId !== "#" + s.id && sh.name.textContent !== s.name) sh.name.textContent = s.name;
    sh.name.setAttribute("aria-label", t("{x}, rename", { x: s.name }));
    sh.input.setAttribute("aria-label", t("Add item to {x}", { x: s.name }));
    if (list.children[i] !== sh.el) list.insertBefore(sh.el, list.children[i] || null);
  });
}

/* ---------- Items ---------- */

function itemEl(it) {
  const li = h("li", {
    class: "item" + (it.checked ? " done" : ""), "data-id": it.id,
    style: "--sec:var(--" + colorOf(it.section) + ")",
  });
  const chk = h("input", { type: "checkbox", class: "chk", id: "chk-" + it.id, "aria-label": it.text, dataset: { fk: "chk-" + it.id } });
  chk.checked = it.checked;
  chk.addEventListener("change", () => toggle(it.id, chk.checked));
  chk.addEventListener("keydown", e => {
    if (e.altKey && (e.key === "ArrowUp" || e.key === "ArrowDown") && inList(it)) { e.preventDefault(); nudge(it.id, e.key === "ArrowUp" ? -1 : 1); }
    else if (e.key === "Delete") { e.preventDefault(); del(it.id); }
  });
  const cell = h("label", { class: "boxcell", for: "chk-" + it.id },
    chk, h("span", { class: "box", "aria-hidden": "true" }), h("span", { class: "grip", "aria-hidden": "true" }));
  cell.addEventListener("click", e => { if (suppressClick) { e.preventDefault(); suppressClick = false; } });
  const text = h("span", { class: "text", id: "txt-" + it.id, role: "button", tabindex: "0", "aria-label": t("Edit {x}", { x: it.text }), dataset: { fk: "txt-" + it.id } });
  fillText(text, it.text);
  text.addEventListener("click", e => {
    if (suppressClick) { suppressClick = false; return; }
    if (editingId !== it.id) editItem(text, it.id, e.clientX, e.clientY);
  });
  text.addEventListener("keydown", e => {
    if (editingId === it.id) return;
    if (e.key === "Enter" || e.key === " " || e.key === "F2") { e.preventDefault(); editItem(text, it.id); }
    else if (e.key === "Delete") { e.preventDefault(); del(it.id); }
  });
  li.append(cell, text);
  bindPress(li, { can: () => !!li.closest("#list .items, #basket-list"), start: (offY, y) => startDrag(li, it.id, offY, y) });
  return li;
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
  const y = drag.y, H = innerHeight;
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
function endSectionDrag() {
  const { id, el } = drag;
  const order = [...$("#list").children].map(c => c.dataset.sec);
  const snap = letGo(); // folded: the cards unfold from here
  el.classList.remove("placeholder");
  if (store.change(t("moving section {x}", { x: q(nameOf(id)) }), orderOps(order))) announce(t("Section moved: {x}", { x: nameOf(id) }));
  sync();
  render();
  const head = el.querySelector(".sec-head");
  if (snap) {
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

// After a change, things glide to their new places. Section cards and the ticked list
// grow or shrink to their new height, and what follows moves along with them; inside
// each, items and the Add item row slide to their new spot; an item that changes place,
// such as one being ticked, lifts, flies across and lands, taking longer the further it
// goes. New items fade in, removed ones fade out. Each element animates on its own, so
// taps keep working throughout, unlike with the browser's page-wide transitions.
const EASE = "cubic-bezier(0.4, 0, 0.2, 1)"; // gentle start, gentle landing
const MOTION = { duration: 400, easing: EASE };
const PARTS = "#list > .sec, #basket-list";
const ITEMS = "#list .item[data-id], #basket-list .item[data-id]";
const ADDS = "#list > .sec > .add";
const flights = new Map(); // each flying item's animation, and how it lands
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
  // Measure everything before moving anything.
  const parts = rectsOf(PARTS), adds = rectsOf(ADDS);
  const now = [...document.querySelectorAll(ITEMS)].map(li => ({ li, rect: li.getBoundingClientRect(), part: li.closest(PARTS) }));
  const head = $(".basket-head").getBoundingClientRect();
  // How far something moved within its card, leaving out the card's own movement.
  const inside = (wasRect, nowRect, part) => (wasRect.top - snap.parts.get(part).top) - (nowRect.top - parts.get(part).top);
  const run = (el, frames, opts = MOTION) => {
    for (const x of el.getAnimations()) if (x.id === "glide") x.cancel(); // a newer change takes over from here
    el.animate(frames, { ...opts, id: "glide" });
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
  const kept = new Set();
  for (const n of now) {
    const o = snap.items.get(n.li.dataset.id);
    kept.add(n.li.dataset.id);
    if (!o || !seen(o.rect)) { if (seen(n.rect)) n.li.animate([{ opacity: 0 }, { opacity: 1 }], MOTION); }
    else if (!seen(n.rect)) fly(o, head, null); // into the folded ticked group
    else if (o.part === n.part) slide(n.li, inside(o.rect, n.rect, n.part));
    else fly(o, n.rect, n.li);
  }
  for (const [id, o] of snap.items) if (!kept.has(id) && seen(o.rect)) fly(o, o.rect, null); // deleted
}
// The item's old element (or the drag ghost) travels from its old place to the new one,
// over everything, and the real item shows when it lands. With no target, it fades away.
function fly(o, to, target) {
  const el = o.li;
  const dx = to.left - o.rect.left, dy = to.top - o.rect.top;
  const ms = target ? Math.round(Math.min(700, 420 + Math.hypot(dx, dy) * 0.35)) : 320;
  if (el.classList.contains("ghost")) el.classList.add("landing"); // let go after a drag
  else float(el, o.rect, "flying");
  el.style.animationDuration = ms + "ms"; // the lift and landing, in app.css
  if (target) target.style.opacity = "0";
  const move = `translate(${dx}px, ${dy}px)`;
  const a = el.animate([{ transform: "none" }, target ? { transform: move } : { transform: move + " scale(0.94)", opacity: 0 }], { duration: ms, easing: EASE, id: "fly" });
  const land = () => {
    if (!flights.delete(a)) return;
    el.remove();
    if (target) target.style.opacity = "";
  };
  flights.set(a, land);
  a.finished.then(land, () => {});
}

/* ---------- Render ---------- */

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
  const { online, full, waiting } = store.status();
  if (online && !full) return null;
  const kept = waiting
    ? plural(waiting, "{n} change is saved on this phone", "{n} changes are saved on this phone")
    : t("Changes you make are saved on this phone");
  if (full) return { text: t("List full"), detail: t("The server has no room left for this list. {kept}.", { kept }) };
  if (!navigator.onLine) return { text: t("Offline"), detail: t("No connection. {kept}, to be sent when you're back online.", { kept }) };
  return { text: t("Can't reach the server"), detail: t("The server isn't answering. {kept}, to be sent as soon as it answers.", { kept }) };
}
function paintStatus() {
  const info = $("#app").hidden ? null : statusInfo();
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
    const now = statusInfo();
    if (!now) return;
    if (statusShown !== now.text) announce(now.text + ". " + now.detail);
    statusShown = now.text;
    $("#status-text").textContent = now.text;
    $("#status-detail").textContent = now.detail;
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
  const name = listName(), title = $("#list-name");
  if (editingId !== LIST && title.textContent !== name) title.textContent = name;
  title.setAttribute("aria-label", t("{x}, rename", { x: name }));
  document.title = name;
  computeSections();
  syncShells();
  for (const s of sections) shells[s.id].ul.replaceChildren(...shown(s.id).map(itemEl));
  const since = Date.now() - TRIP_MS;
  const basket = items.filter(i => i.checked && !settling.has(i.id) && i.checkedAt >= since).sort((a, b) => b.checkedAt - a.checkedAt);
  $("#basket").classList.toggle("empty", basket.length === 0);
  $("#basket-count").textContent = String(basket.length);
  $("#basket-toggle").setAttribute("aria-expanded", String(ui.basketOpen));
  const bl = $("#basket-list");
  bl.replaceChildren(...basket.map(itemEl));
  bl.hidden = !ui.basketOpen;
  const u = store.undoLabel(), r = store.redoLabel();
  $("#dock").hidden = !u && !r;
  setHist($("#undo"), u, "Undo");
  setHist($("#redo"), r, "Redo");
  paintStatus();

  if (flashId) {
    const li = document.querySelector('.item[data-id="' + flashId + '"]');
    flashId = null;
    if (li) {
      li.classList.add("flash");
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

/* ---------- Pairing ---------- */

function qrSvg(textToEncode) {
  const qr = window.qrcode(0, "M");
  qr.addData(textToEncode);
  qr.make();
  const n = qr.getModuleCount(), pad = 4;
  let d = "";
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) d += "M" + (c + pad) + " " + (r + pad) + "h1v1h-1z";
  const t = document.createElement("template");
  t.innerHTML = '<svg viewBox="0 0 ' + (n + 2 * pad) + " " + (n + 2 * pad) + '" shape-rendering="crispEdges" aria-hidden="true"><rect width="100%" height="100%" fill="#fff"/><path d="' + d + '" fill="#000"/></svg>';
  return t.content.firstChild;
}
// Sheets (pairing, Settings) open as a step in the browser's history, so the phone's
// back gesture closes them like a page.
// Each opening is its own step, so one left over from before a reload doesn't count.
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
});

// The QR code library is only needed here, so it loads the first time the sheet opens.
let qrLib = null;
const loadQr = () => (qrLib ||= new Promise((resolve, reject) => {
  document.head.append(h("script", { src: "vendor/qrcode.js", onload: resolve, onerror: () => { qrLib = null; reject(); } }));
}));
function openPair() {
  const link = store.pairingLink();
  $("#qr").replaceChildren();
  $("#share-link").hidden = !navigator.share;
  openSheet($("#pair"));
  loadQr().then(() => $("#qr").replaceChildren(qrSvg(link)), () => {});
}
$("#pair-open").addEventListener("click", openPair);
$("#pair-close").addEventListener("click", () => $("#pair").close());
$("#share-link").addEventListener("click", () => {
  navigator.share({ title: listName(), url: store.pairingLink() }).catch(() => {});
});
$("#copy-link").addEventListener("click", async e => {
  const b = e.currentTarget;
  try {
    await navigator.clipboard.writeText(store.pairingLink());
    b.textContent = t("Copied");
  } catch (_) {
    b.textContent = t("Couldn't copy");
  }
  setTimeout(() => { b.textContent = t("Copy link"); }, 2000);
});

/* ---------- Settings ---------- */

const THEME_KEY = "panier-theme";
// Asks the browser to keep the list even when the phone runs low on space. Firefox asks
// you once; Chrome decides for itself. Returns whether it's kept, or null if unknown.
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
  let bytes = 0;
  try { bytes = new Blob([localStorage.getItem("panier") || ""]).size; } catch (_) {}
  const toGet = items.filter(i => !i.checked).length;
  $("#size-text").textContent = t("On this phone, the list takes {size}: {toGet} to get, {done}.", {
    size: size(bytes), toGet: plural(toGet, "{n} item", "{n} items"), done: plural(items.length - toGet, "{n} bought before", "{n} bought before"),
  });
  $("#about-server").textContent = location.host;
  const [kept, keys] = await Promise.all([isKept(), caches.keys().catch(() => [])]);
  $("#keep-text").textContent = kept
    ? t("Kept on this phone: the browser won't clear the list to free up space.")
    : t("The browser may clear the list if this phone runs low on space. Keep the link from {link} somewhere safe, such as a password manager: it brings the list back.", { link: q(t("Add someone to this list")) });
  $("#keep-btn").hidden = kept !== false;
  const k = keys.find(k => k.startsWith("panier-") && !k.startsWith("panier-static-"));
  $("#about-version").textContent = k ? k.slice(7) : "dev";
}
// The list as a plain-text checklist, named after it: each section's items to get, then
// everything bought before, by name, as suggested.
function exportList() {
  const now = new Date(), name = listName();
  const lines = [name + ", " + now.toLocaleDateString(lang, { day: "numeric", month: "long", year: "numeric" })];
  for (const s of sections) {
    const list = items.filter(i => i.section === s.id && !i.checked).sort((a, b) => a.pos - b.pos);
    if (list.length) lines.push("", s.name, ...list.map(i => "- [ ] " + i.text));
  }
  const done = items.filter(i => i.checked).sort((a, b) => b.checkedAt - a.checkedAt);
  if (done.length) lines.push("", t("Bought before"), ...done.map(i => "- [x] " + bare(i.text)));
  const url = URL.createObjectURL(new Blob([lines.join("\n") + "\n"], { type: "text/plain;charset=utf-8" }));
  const day = [now.getFullYear(), now.getMonth() + 1, now.getDate()].map(n => String(n).padStart(2, "0")).join("-");
  const file = keyOf(name).replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "") || "panier";
  const a = h("a", { href: url, download: file + "-" + day + ".txt", hidden: true });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}
$("#settings-open").addEventListener("click", () => { paintSettings(); openSheet($("#settings")); });
$("#settings-close").addEventListener("click", () => $("#settings").close());
for (const r of document.querySelectorAll('input[name="theme"]')) {
  r.addEventListener("change", () => {
    try { if (r.value) localStorage.setItem(THEME_KEY, r.value); else localStorage.removeItem(THEME_KEY); } catch (_) {}
    if (window.panierTheme) window.panierTheme(r.value);
  });
}
$("#keep-btn").addEventListener("click", async () => { await keepList(); paintSettings(); });
$("#export-btn").addEventListener("click", exportList);

/* ---------- Wiring and start ---------- */

$("#add-sec-form").addEventListener("submit", e => { e.preventDefault(); addSection($("#add-sec").value); });
$("#list-name").addEventListener("click", e => { if (editingId !== LIST) editListName(e.currentTarget, e.clientX, e.clientY); });
$("#list-name").addEventListener("keydown", e => {
  if (editingId === LIST) return;
  if (e.key === "Enter" || e.key === " " || e.key === "F2") { e.preventDefault(); editListName(e.currentTarget); }
});
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
  try { localStorage.setItem("panier-basket-open", ui.basketOpen ? "1" : "0"); } catch (_) {}
  paint(null, false);
});
document.addEventListener("visibilitychange", () => {
  if (!document.hidden && !editingId && !drag) paint(activeFk(), false);
});
store.subscribe(kind => {
  if (kind === "remote") refreshFromStore();
  else if (kind === "status" || kind === "local") paintStatus();
});

function showList() {
  $("#welcome").hidden = true;
  $("#app").hidden = false;
  items = store.items();
  render();
  // Text left in an "Add item" field when the app was closed becomes an item now.
  for (const [sec, text] of Object.entries(loadDrafts())) {
    const target = shells[sec] ? sec : sections[0].id;
    shells[target].input.value = text;
    submitAdd(target, true);
  }
  try { localStorage.removeItem(DRAFTS_KEY); } catch (_) {}
  dragHint();
}
function showWelcome(message) {
  $("#app").hidden = true;
  $("#dock").hidden = true;
  $("#welcome").hidden = false;
  if (message) $("#welcome-msg").textContent = message;
}
const MESSAGES = {
  code: t("That setup code didn't work. Check it on the server and try again."),
  link: t("That link is incomplete. Ask for the link again from the phone that has the list."),
  server: t("Couldn't reach the server. Check your connection and try again."),
};
$("#setup-form").addEventListener("submit", async e => {
  e.preventDefault();
  const code = $("#setup-code").value;
  if (!code.trim()) return;
  try {
    await store.createList(code);
    showList();
    openPair();
    keepList();
  } catch (err) {
    showWelcome(MESSAGES[err.message] || MESSAGES.server);
  }
});

async function init() {
  const params = new URLSearchParams(location.hash.slice(1));
  if (location.hash) history.replaceState(null, "", location.pathname); // keep keys out of history
  try {
    if (params.get("k")) { await store.join(params.get("k")); keepList(); }
    else if (params.get("setup") && !store.hasList()) {
      await store.createList(params.get("setup"));
      showList();
      openPair();
      keepList();
      return;
    }
  } catch (err) {
    if (!store.hasList()) return showWelcome(MESSAGES[err.message] || MESSAGES.server);
  }
  if (!store.hasList()) return showWelcome();
  showList();
  store.start();
}
translatePage();
init();

/* ---------- Updates ---------- */

// A new version installs in the background. When it takes over, the app reloads into it,
// waiting first for anything in progress: editing, typing, dragging or the pairing sheet.
function busy() {
  return !!(editingId || drag || lifted || pointerIsDown || document.querySelector("dialog[open]") ||
    $("#add-sec").value.trim() || Object.values(shells).some(sh => sh.input.value.trim()));
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
