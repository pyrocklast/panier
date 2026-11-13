// The list on screen: its sections and items, and everything done to them.

import * as store from "./store.js";
import { t, plural, q } from "./i18n.js";
import { toMarkdown, pastedItems } from "./md.js";
import { state, readOnly, listName, listColor, draftsKey } from "./state.js";
import { DEFAULTS, COLORS, PALETTE, LIST_COLORS, MAX_ITEM, MAX_SECTION, LIST, RECENT_MS, fold, splitQty, nameKey, bare, retext, fromHint, clean, between, layout, sheetOfList } from "./model.js";
import { $, h, icon, fillText, addRow, emptyField, announce, activeFk, buzz, setRows, download, reduceMotion } from "./dom.js";
import { whenTapEnds, bindPress, beginDrag } from "./press.js";
import { float, landAll, snapshot, glide, fly, MOTION } from "./motion.js";
import { editInPlace, palette } from "./edit.js";
import { noteUndo, paintDock, paintStatus } from "./bar.js";

const SETTLE_MS = 1500;

let items = [];
let sections = []; // the sections on screen, in order
let sectionInfo = new Map(); // every section ever seen, for names and colours
const settling = new Set();
let settleTimer = null, flashId = null, renderPending = false;
const ui = { sugSec: null, sug: [], sugIndex: -1, sugCol: 0, basketOpen: true };
let wasReadOnly = false; // as the list on screen was last drawn

const find = id => items.find(i => i.id === id);
const nameOf = id => (sectionInfo.get(id) || { name: t("this section") }).name;
const colorOf = id => (sectionInfo.has(id) ? sectionInfo.get(id).color : "muted");
const isShown = id => sections.some(s => s.id === id);
const inList = i => !i.checked || settling.has(i.id);
const shown = sec => items.filter(i => i.section === sec && inList(i)).sort((a, b) => a.pos - b.pos || (a.id < b.id ? -1 : 1));
const maxPos = sec => shown(sec).reduce((m, i) => Math.max(m, i.pos), 0);
const onScreen = i => inList(i) || i.checkedAt >= Date.now() - RECENT_MS;

function computeSections() {
  const typing = Object.entries(shells).filter(([, sh]) => sh.input.value.trim()).map(([id]) => id);
  const l = layout(store.sections(), items, typing, inList);
  sectionInfo = l.all;
  sections = l.shown;
}

/* ---------- Changes ---------- */

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
  if (state.drag) { renderPending = true; return; }
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
  if (animate !== false && !reduceMotion.matches && !state.drag) snap = snap || snapshot();
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
// Takes in what the store holds now, including the other phones' changes.
function sync() {
  renderPending = false;
  items = store.items();
  for (const id of [...settling]) { const it = find(id); if (!it || !it.checked) settling.delete(id); }
}
// Changes from the other phones wait while you are editing or dragging, and appear
// without motion, so nothing slides away just as you reach for it.
export function refreshFromStore() {
  if (state.view !== "list") return;
  if (state.editing || state.drag) { renderPending = true; return; }
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
export const undo = () => { if (!readOnly()) step(store.undo, "Undid {x}", "Nothing to undo: {x} already changed it"); };
export const redo = () => { if (!readOnly()) step(store.redo, "Redid {x}", "Nothing to redo: {x} already changed it"); };

// Ticked items stay put briefly, then all move to the ticked group together.
function scheduleSettle() {
  clearTimeout(settleTimer);
  if (!settling.size) return;
  settleTimer = setTimeout(() => {
    if (state.editing || state.drag) return scheduleSettle();
    settling.clear();
    paint(activeFk());
  }, SETTLE_MS);
}

// A row can outlive its item for a moment: deleted on another phone while this one was
// editing. Whatever is done to it then does nothing.
function toggle(id, checked) {
  const it = find(id);
  if (readOnly() || !it) return;
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
  emptyField(shells[sec].input);
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
  if (readOnly() || !it) return;
  settling.delete(id);
  announce(t("Deleted {x}", { x: it.text }));
  act(t("deleting {x}", { x: q(it.text) }), [[id, "deleted", true]], { ...opts, note: it.text });
}
function nudge(id, dir) {
  const it = find(id);
  if (readOnly() || !it) return;
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
  emptyField($("#add-sec"));
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

/* ---------- Editing ---------- */

// Editing in place, here: the row is rewritten at the next redraw, and what the other
// phones changed meanwhile shows once the text is left as it was.
const edit = (span, o) => editInPlace(span, {
  ...o,
  onDone: () => { if (rows.has(o.key)) rows.get(o.key).shown = null; },
  onUnchanged: () => { if (renderPending) whenTapEnds(refreshFromStore); },
});
function editItem(span, id, x, y, caret) {
  if (readOnly() || !find(id)) return;
  const orig = find(id).text;
  const row = span.closest(".item");
  edit(span, {
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

function editSection(span, id, x, y) {
  if (readOnly()) return;
  const orig = nameOf(id);
  edit(span, {
    key: "#" + id, row: span.closest(".sec-head"), orig, max: MAX_SECTION, x, y,
    below: palette(orig, COLORS, colorOf(id), (c, label) => recolour(id, c, label)),
    onDelete: canDelete(id) ? () => deleteSection(id) : null, deleteLabel: t("Delete section {x}", { x: orig }),
    onSave: name => renameSection(id, name),
  });
}
// The list's name, at the top, is renamed the same way as a section's, its colour chosen
// under it.
function editListName(span, x, y) {
  if (readOnly()) return;
  const orig = listName();
  edit(span, {
    key: LIST, row: span.closest(".list-top"), orig, max: MAX_SECTION, x, y,
    below: palette(orig, LIST_COLORS, listColor(), (c, label) => {
      announce(t("{x} is now {y}", { x: listName(), y: t(label).toLowerCase() }));
      act(t("changing the colour of {x}", { x: q(listName()) }), [[LIST, "color", c, ""]], { animate: false });
    }),
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
export function closeSug() {
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
    if (state.suppressClick) { state.suppressClick = false; return; }
    if (state.editing !== "#" + id) editSection(name, id, e.clientX, e.clientY);
  });
  name.addEventListener("keydown", e => {
    if (state.editing === "#" + id) return;
    if (e.key === "Enter" || e.key === " " || e.key === "F2") { e.preventDefault(); editSection(name, id); }
    else if (e.altKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) { e.preventDefault(); moveSection(id, e.key === "ArrowUp" ? -1 : 1); }
  });
  const head = h("h2", { class: "sec-head" }, name);
  const el = h("section", { class: "sec", "data-sec": id, "aria-labelledby": "h-" + id }, head, ul, sug, form);
  bindPress(head, { look: el, can: () => !readOnly() && sections.length > 1, start: (offY, y) => startSectionDrag(id, y) });
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
    if (state.editing !== "#" + s.id && sh.name.textContent !== s.name) sh.name.textContent = s.name;
    sh.name.setAttribute("aria-label", readOnly() ? s.name : t("{x}, rename", { x: s.name }));
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
  if (r && state.editing === it.id) return r.li; // being edited: left just as it is
  if (!r || tint) rows.set(it.id, (r = itemEl(it.id)));
  const cls = "item" + (it.checked ? " done" : "") + (tint ? " flash" : ""), sec = "var(--" + colorOf(it.section) + ")";
  if (r.li.className !== cls) r.li.className = cls; // also clears what a drag or a press left
  if (r.li.style.length !== 1 || r.li.style.getPropertyValue("--sec") !== sec) r.li.style.cssText = "--sec:" + sec;
  if (r.chk.checked !== it.checked) r.chk.checked = it.checked;
  const ro = readOnly();
  if (r.chk.disabled !== ro) r.chk.disabled = ro;
  if (r.shown !== it.text || r.ro !== ro) {
    r.shown = it.text;
    r.ro = ro;
    fillText(r.text, it.text);
    r.chk.setAttribute("aria-label", it.text);
    r.text.setAttribute("aria-label", ro ? it.text : t("Edit {x}", { x: it.text }));
  }
  return r.li;
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
  cell.addEventListener("click", e => { if (state.suppressClick) { e.preventDefault(); state.suppressClick = false; } });
  const text = h("span", { class: "text", id: "txt-" + id, role: "button", tabindex: "0", dataset: { fk: "txt-" + id } });
  text.addEventListener("click", e => {
    if (state.suppressClick) { state.suppressClick = false; return; }
    if (state.editing !== id) editItem(text, id, e.clientX, e.clientY);
  });
  text.addEventListener("keydown", e => {
    if (state.editing === id) return;
    if (e.key === "Enter" || e.key === " " || e.key === "F2") { e.preventDefault(); editItem(text, id); }
    else if (e.key === "Delete") { e.preventDefault(); del(id); }
  });
  li.append(cell, text);
  bindPress(li, { can: () => !readOnly() && !!li.closest("#list .items, #basket-list"), start: (offY, y) => startDrag(li, id, offY, y) });
  return { li, chk, text, shown: null };
}

/* ---------- Dragging items and sections ---------- */

// Letting go: the drag ends, and how the page looked is kept, so things glide from there
// and the ghost from where it was let go.
function letGo() {
  const { ghost } = state.drag;
  const snap = reduceMotion.matches ? null : snapshot();
  if (snap) snap.ghost = { li: ghost, rect: ghost.getBoundingClientRect(), part: null };
  else ghost.remove();
  document.documentElement.classList.remove("dragging", "drag-ticked", "sorting");
  $("#tick-drop").classList.remove("over");
  state.drag = null;
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

function setSec(sec) {
  state.drag.li.style.setProperty("--sec", sec);
  state.drag.ghost.style.setProperty("--sec", sec);
}
function place(y) {
  // Over the ticked group, from its heading down: the item will be ticked, or stay ticked.
  const toTick = y > $("#basket").getBoundingClientRect().top - 8;
  if (toTick !== state.drag.toTick) {
    if (toTick && state.drag.toTick === false) buzz(8);
    state.drag.toTick = toTick;
    state.drag.ghost.classList.toggle("done", toTick);
    state.drag.ghost.querySelector(".chk").checked = toTick;
    if (!state.drag.ticked) {
      state.drag.li.classList.toggle("away", toTick); // its slot empties, nothing moves
      $("#tick-drop").classList.toggle("over", toTick);
    } else if (toTick) {
      state.drag.home.ul.insertBefore(state.drag.li, state.drag.home.next);
      setSec(state.drag.home.sec);
    }
  }
  if (toTick) return;
  const secs = [...document.querySelectorAll("#list .sec")];
  let target = secs[secs.length - 1];
  for (const s of secs) { if (y < s.getBoundingClientRect().bottom) { target = s; break; } }
  const ul = target.querySelector("ul.items");
  let before = null;
  for (const n of ul.children) {
    if (n === state.drag.li) continue;
    const r = n.getBoundingClientRect();
    if (y < r.top + r.height / 2) { before = n; break; }
  }
  if (state.drag.li.parentElement === ul && state.drag.li.nextElementSibling === before) return;
  ul.insertBefore(state.drag.li, before);
  setSec("var(--" + colorOf(ul.dataset.sec) + ")");
}
function endDrag() {
  const { li, id, toTick, ticked } = state.drag;
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
    if (c === state.drag.el) continue;
    const r = c.getBoundingClientRect();
    if (y < r.top + r.height / 2) { before = c; break; }
  }
  if (state.drag.el.nextElementSibling !== before) list.insertBefore(state.drag.el, before);
}
// Let go, the section stays where it was dropped, as far as the page allows: the sections
// above it unfold at once, upwards, out of the way, and it unfolds downwards with those
// below it.
function endSectionDrag() {
  const { id, el, ghost } = state.drag;
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
  if (readOnly()) return;
  const order = sections.map(s => s.id), i = order.indexOf(id), j = i + dir;
  if (j < 0 || j >= order.length) return;
  [order[i], order[j]] = [order[j], order[i]];
  announce(t(dir < 0 ? "{x} moved up" : "{x} moved down", { x: nameOf(id) }));
  act(t("moving section {x}", { x: q(nameOf(id)) }), orderOps(order), { focusKey: "name-" + id });
}

/* ---------- Render ---------- */

function render() {
  if (state.view !== "list" || !store.current()) return; // the lists page shows; the list draws when it's back
  const name = listName(), title = $("#list-name");
  if (state.editing !== LIST && title.textContent !== name) title.textContent = name;
  title.setAttribute("aria-label", readOnly() ? name : t("{x}, rename", { x: name }));
  document.title = name;
  wasReadOnly = readOnly();
  $("#app").classList.toggle("readonly", wasReadOnly);
  if (window.panierList) window.panierList(listColor());
  computeSections();
  syncShells();
  // What the other phones changed is tinted where it is, without scrolling to it.
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
      if (!state.pointerDown && (rect.top < 0 || rect.bottom > innerHeight - 80)) {
        window.scrollBy({ top: rect.top - innerHeight / 3, behavior: reduceMotion.matches ? "auto" : "smooth" });
      }
    }
  }
}

function exportList() {
  download(listName(), toMarkdown([sheetOfList({ name: listName(), color: listColor(), sections: store.sections(), items })]));
}

$("#export-btn").addEventListener("click", exportList);

// Adding a section moves the cursor to its Add item field.
addRow($("#add-sec-form"), $("#add-sec"), { add: () => addSection($("#add-sec").value) });
$("#list-name").addEventListener("click", e => { if (state.editing !== LIST) editListName(e.currentTarget, e.clientX, e.clientY); });
$("#list-name").addEventListener("keydown", e => {
  if (state.editing === LIST) return;
  if (e.key === "Enter" || e.key === " " || e.key === "F2") { e.preventDefault(); editListName(e.currentTarget); }
});

$("#basket-toggle").addEventListener("click", () => {
  ui.basketOpen = !ui.basketOpen;
  store.setFolded(state.lid, !ui.basketOpen);
  paint(null, false);
});

/* ---------- For app.js ---------- */

// Another list takes the screen: nothing of the last one stays.
export function reset() {
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
// Draws the list the store has just opened, lid, with its ticked group folded as it was left.
export function show(lid) {
  const e = store.lists().find(x => x.lid === lid);
  ui.basketOpen = !(e && e.folded);
  items = store.items();
  render();
  // Text left in an "Add item" field when the app was closed becomes an item now.
  if (!readOnly()) for (const [sec, text] of Object.entries(loadDrafts())) {
    const target = shells[sec] ? sec : sections[0].id;
    shells[target].input.value = text;
    submitAdd(target, true);
  }
  try { localStorage.removeItem(draftsKey()); } catch (_) {}
}
// Back on screen: redrawn, as what shows depends on the time, unless something's under way.
export const repaint = () => { if (!state.editing && !state.drag) paint(activeFk(), false); };
// Closed while on screen: it now reads only.
export const readOnlyChanged = () => readOnly() !== wasReadOnly;
// Whether something is being typed here, which an update waits for.
export const typing = () => !!($("#add-sec").value.trim() || Object.values(shells).some(sh => sh.input.value.trim()));
