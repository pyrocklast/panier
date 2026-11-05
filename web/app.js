import * as store from "./store.js";

// The three sections every list starts with. They can be renamed or deleted like any other.
const DEFAULTS = [
  { id: "ess", name: "Essentials", icon: "home", color: "ess", pos: 1 },
  { id: "look", name: "Look out for", icon: "eye", color: "look", pos: 2 },
  { id: "long", name: "Long term", icon: "bookmark", color: "long", pos: 3 },
];
const PALETTE = ["teal", "rose", "blue", "olive", "plum"]; // for new sections
const MAX_ITEM = 120; // four lines on a phone
const MAX_SECTION = 40;
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
const clean = (s, max = MAX_ITEM) => s.replace(/\s+/g, " ").trim().slice(0, max);
const q = s => "“" + s + "”";
const buzz = ms => { try { if (navigator.vibrate) navigator.vibrate(ms); } catch (_) {} };

let items = [];
let sections = []; // the sections on screen, in order
let sectionInfo = new Map(); // every section ever seen, for names and colours
const settling = new Set();
let settleTimer = null, flashId = null, drag = null, editingId = null, renderPending = false;
let suppressClick = false, lifted = false;
const ui = { sugSec: null, sug: [], sugIndex: -1, basketOpen: true };
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
  grip: SVG(18, '<g fill="currentColor"><circle cx="7" cy="4.5" r="1.6"/><circle cx="13" cy="4.5" r="1.6"/><circle cx="7" cy="10" r="1.6"/><circle cx="13" cy="10" r="1.6"/><circle cx="7" cy="15.5" r="1.6"/><circle cx="13" cy="15.5" r="1.6"/></g>'),
  check: SVG(13, '<path d="M4.5 10.5l3.7 3.7 7.3-8.7" ' + STROKE + ' stroke-width="2.7"/>'),
  plus: SVG(18, '<path d="M10 4v12M4 10h12" ' + STROKE + ' stroke-width="2.2"/>'),
  home: SVG(18, '<path d="M3.5 9.5L10 3.8l6.5 5.7M5.5 8v8.5h9V8M8.5 16.5v-4h3v4" ' + STROKE + ' stroke-width="1.7"/>'),
  eye: SVG(18, '<path d="M2 10s3-5.5 8-5.5 8 5.5 8 5.5-3 5.5-8 5.5S2 10 2 10z" ' + STROKE + ' stroke-width="1.7"/><circle cx="10" cy="10" r="2.3" ' + STROKE + ' stroke-width="1.7"/>'),
  bookmark: SVG(18, '<path d="M6 3.5h8v13l-4-3.2-4 3.2z" ' + STROKE + ' stroke-width="1.7"/>'),
  bin: SVG(19, '<path d="M4 6h12M8 6V4.5h4V6M5.8 6l.8 10h6.8l.8-10M8.6 9v4.5M11.4 9v4.5" ' + STROKE + ' stroke-width="1.6"/>'),
  back: SVG(16, '<path d="M7.5 4.4L3.1 8.75l4.4 4.35M3.75 8.75h8.75a4.4 4.4 0 0 1 0 8.75H10" ' + STROKE + ' stroke-width="2.1"/>'),
};
function icon(name) {
  const t = document.createElement("template");
  t.innerHTML = ICONS[name];
  return t.content.firstChild;
}

const find = id => items.find(i => i.id === id);
const nameOf = id => (sectionInfo.get(id) || { name: "this section" }).name;
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
    all.set(d.id, { ...d, name: st.name ?? d.name, pos: st.pos ?? d.pos, deleted: !!st.deleted });
  }
  for (const st of stored.values()) {
    if (!all.has(st.id)) all.set(st.id, { id: st.id, name: st.name || "Untitled", icon: null, color: st.color || PALETTE[0], pos: st.pos ?? 100, deleted: st.deleted });
  }
  const used = new Set(items.filter(inList).map(i => i.section));
  for (const [id, sh] of Object.entries(shells)) if (sh.input.value.trim()) used.add(id);
  for (const id of used) if (!all.has(id)) all.set(id, { id, name: "Untitled", icon: null, color: PALETTE[0], pos: 100, deleted: false });
  sectionInfo = all;
  sections = [...all.values()].filter(s => !s.deleted || used.has(s.id)).sort((a, b) => a.pos - b.pos || (a.id < b.id ? -1 : 1));
}

/* ---------- Changes ---------- */

// Browsers send every tap to the page itself while an animation plays, so animations
// only follow your own actions, never the other phone's. A change made in the middle of
// a tap (leaving a field by tapping elsewhere) redraws once the tap is over, so the
// thing you tapped is still there to receive it.
let pointerIsDown = false, afterTap = null;
addEventListener("pointerdown", () => { pointerIsDown = true; }, true);
const tapEnded = () => {
  pointerIsDown = false;
  if (afterTap) { const f = afterTap; afterTap = null; setTimeout(f, 0); }
};
addEventListener("pointerup", tapEnded, true);
addEventListener("pointercancel", tapEnded, true);
const whenTapEnds = fn => { if (pointerIsDown) afterTap = fn; else fn(); };

// act records one undoable step and redraws.
function act(label, ops, opts = {}) {
  const fk = opts.focusKey || activeFk();
  if (!store.change(label, ops)) return;
  items = store.items();
  if (opts.leaving) whenTapEnds(() => paint(null, false));
  else paint(fk, opts.animate);
}
function paint(fk, animate) {
  const run = () => {
    render();
    if (fk) {
      const t = document.querySelector('[data-fk="' + fk + '"]');
      if (t && t !== document.activeElement) t.focus({ preventScroll: true });
    }
  };
  if (animate !== false && document.startViewTransition && !reduceMotion.matches && !drag) {
    document.startViewTransition(run).ready.catch(() => {}); // a newer change can cut an animation short
  } else run();
}
// Changes from the other phone wait while you are editing or dragging.
function refreshFromStore() {
  if (editingId || drag) { renderPending = true; return; }
  renderPending = false;
  items = store.items();
  for (const id of [...settling]) { const it = find(id); if (!it || !it.checked) settling.delete(id); }
  paint(activeFk(), false);
}
function step(fn, verb) {
  const r = fn();
  if (!r) return;
  announce(r.done ? verb + " " + r.label : "Nothing to " + verb.toLowerCase().replace(/id$/, "o") + ": the other phone already changed it");
  refreshFromStore();
  scheduleSettle();
}
const undo = () => step(store.undo, "Undid");
const redo = () => step(store.redo, "Redid");

// Ticked items stay put briefly, then all move to the ticked group together.
function scheduleSettle() {
  clearTimeout(settleTimer);
  if (!settling.size) return;
  settleTimer = setTimeout(() => {
    if (editingId || drag) return scheduleSettle();
    settling.clear();
    paint(activeFk(), false);
  }, SETTLE_MS);
}

function toggle(id, checked) {
  const it = find(id);
  const fromList = !it.checked;
  const wasSettling = settling.has(id);
  if (checked) {
    if (fromList) settling.add(id);
    buzz(12);
    announce(it.text + " ticked");
    act("checking " + q(it.text), [[id, "checked", true], [id, "checkedAt", Date.now()]], { animate: false });
  } else {
    settling.delete(id);
    const ops = [[id, "checked", false], [id, "checkedAt", 0]];
    if (!wasSettling) {
      const sec = isShown(it.section) ? it.section : sections[0].id;
      ops.push([id, "section", sec], [id, "pos", maxPos(sec) + 1]);
    }
    announce(it.text + " back on the list");
    act("unchecking " + q(it.text), ops, { animate: !wasSettling });
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
  closeSug();
}
function revive(id, sec, opts = {}) {
  clearAdd(sec);
  const it = find(id);
  settling.delete(id);
  flashId = id;
  announce(it.text + " is back on the list");
  act("putting back " + q(it.text), [[id, "section", sec], [id, "pos", maxPos(sec) + 1], [id, "checked", false], [id, "checkedAt", 0]], opts);
}
// submitAdd adds what was typed into a section's "Add item" field: on Enter, or, with
// leaving, when you leave the field or reopen the app with text still in it.
function submitAdd(sec, leaving = false) {
  const opts = leaving ? { leaving: true } : {};
  const pick = !leaving && ui.sugSec === sec && ui.sugIndex >= 0 && ui.sug[ui.sugIndex];
  if (pick) return revive(pick.id, sec);
  const text = clean(shells[sec].input.value);
  if (!text) { clearAdd(sec); return; }
  const ex = items.find(i => keyOf(i.text) === keyOf(text));
  if (ex && ex.checked && !settling.has(ex.id)) return revive(ex.id, sec, opts);
  clearAdd(sec);
  if (ex) {
    flashId = ex.id;
    announce(ex.text + " is already on the list");
    if (leaving) whenTapEnds(() => paint(null, false));
    else paint(null, false);
    return;
  }
  const id = store.newId();
  flashId = id;
  announce("Added " + text);
  act("adding " + q(text), [[id, "text", text], [id, "section", sec], [id, "pos", maxPos(sec) + 1],
    [id, "checked", false], [id, "checkedAt", 0], [id, "deleted", false]], opts);
}
function del(id) {
  const it = find(id);
  settling.delete(id);
  announce("Deleted " + it.text);
  act("deleting " + q(it.text), [[id, "deleted", true]]);
}
function nudge(id, dir) {
  const it = find(id);
  const list = shown(it.section);
  const other = list[list.indexOf(it) + dir];
  if (other) {
    act("moving " + q(it.text), [[id, "pos", other.pos], [other.id, "pos", it.pos]], { focusKey: "chk-" + id });
    return;
  }
  const next = sections[sections.findIndex(s => s.id === it.section) + dir];
  if (!next) return;
  const l = shown(next.id);
  const pos = dir > 0 ? (l.length ? l[0].pos - 1 : 1) : maxPos(next.id) + 1;
  announce(it.text + " moved to " + next.name);
  act("moving " + q(it.text), [[id, "section", next.id], [id, "pos", pos]], { focusKey: "chk-" + id });
}

function addSection(raw) {
  const name = clean(raw, MAX_SECTION);
  if (!name) return;
  $("#add-sec").value = "";
  const id = store.newId(), key = "#" + id;
  const usedColors = new Set(sections.map(s => s.color));
  const color = PALETTE.find(c => !usedColors.has(c)) || PALETTE[sectionInfo.size % PALETTE.length];
  const pos = sections.reduce((m, s) => Math.max(m, s.pos), 0) + 1;
  announce("Added section " + name);
  act("adding section " + q(name), [[key, "name", name], [key, "pos", pos], [key, "color", color], [key, "deleted", false]], { focusKey: "add-" + id });
}
function renameSection(id, name) {
  const info = sectionInfo.get(id);
  const fallback = (DEFAULTS.find(d => d.id === id) || {}).name;
  announce("Renamed section to " + name);
  act("renaming section " + q(info.name), [["#" + id, "name", name, fallback]], { animate: false });
}
// A section can only be deleted once it has nothing to get, and the last one stays.
const canDelete = id => sections.length > 1 && !items.some(i => i.section === id && inList(i));
function deleteSection(id) {
  const name = nameOf(id);
  announce("Deleted section " + name);
  act("deleting section " + q(name), [["#" + id, "deleted", true, false]]);
}

/* ---------- Editing in place ---------- */

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
// editInPlace turns a text span into an editable field until Enter, Escape or leaving
// it. With onDelete, a bin appears at the end of the row while editing.
function editInPlace(span, { key, row, orig, max, x, y, onSave, onDelete, deleteLabel }) {
  if (editingId || drag) return;
  editingId = key;
  span.contentEditable = PLAIN ? "plaintext-only" : "true";
  span.classList.add("editing");
  span.setAttribute("role", "textbox");
  const at = x != null ? caretAt(span, x, y) : null;
  span.focus();
  try {
    let r = at;
    if (!r) { r = document.createRange(); r.selectNodeContents(span); r.collapse(false); }
    const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r);
  } catch (_) {}
  let cancelled = false, done = false;
  const bin = onDelete && h("button", {
    type: "button", class: "bin", "aria-label": deleteLabel,
    onpointerdown: e => e.preventDefault(), onmousedown: e => e.preventDefault(),
    onclick: () => { cancelled = true; finish(); onDelete(); },
  }, icon("bin"));
  row.classList.add("editing");
  if (bin) row.append(bin);
  const onKey = e => {
    if (e.key === "Enter") { e.preventDefault(); span.blur(); }
    else if (e.key === "Escape") { e.preventDefault(); cancelled = true; span.blur(); }
  };
  const onBefore = e => {
    if (e.inputType === "insertParagraph" || e.inputType === "insertLineBreak") { e.preventDefault(); span.blur(); return; }
    // Keep to the length limit while typing or pasting.
    const room = max - span.textContent.length + (getSelection().toString().length || 0);
    if (e.data && e.data.length > room) e.preventDefault();
  };
  const onPaste = e => {
    if (PLAIN) return;
    e.preventDefault();
    document.execCommand("insertText", false, (e.clipboardData && e.clipboardData.getData("text/plain")) || "");
  };
  const onSpanBlur = e => { if (!bin || e.relatedTarget !== bin) finish(); };
  const onBinBlur = e => { if (e.relatedTarget !== span) finish(); };
  function finish() {
    if (done) return;
    done = true;
    span.removeEventListener("keydown", onKey);
    span.removeEventListener("beforeinput", onBefore);
    span.removeEventListener("paste", onPaste);
    span.removeEventListener("blur", onSpanBlur);
    if (bin) { bin.removeEventListener("blur", onBinBlur); bin.remove(); }
    span.contentEditable = "false";
    span.classList.remove("editing");
    span.setAttribute("role", "button");
    row.classList.remove("editing");
    editingId = null;
    const text = clean(span.textContent, max);
    if (cancelled || !text || text === orig) {
      span.textContent = orig;
      if (renderPending && !cancelled) refreshFromStore();
      return;
    }
    if (onSave(text) === false) span.textContent = orig;
  }
  span.addEventListener("keydown", onKey);
  span.addEventListener("beforeinput", onBefore);
  span.addEventListener("paste", onPaste);
  span.addEventListener("blur", onSpanBlur);
  if (bin) bin.addEventListener("blur", onBinBlur);
}

function editItem(span, id, x, y) {
  const orig = find(id).text;
  editInPlace(span, {
    key: id, row: span.closest(".item"), orig, max: MAX_ITEM, x, y,
    onDelete: () => del(id), deleteLabel: "Delete " + orig,
    onSave: text => {
      const dup = items.find(i => i.id !== id && keyOf(i.text) === keyOf(text));
      if (dup && onScreen(dup)) {
        flashId = dup.id;
        announce(dup.text + " is already on the list");
        items = store.items();
        paint(activeFk(), false);
        return false;
      }
      const ops = [[id, "text", text]];
      if (dup) ops.push([dup.id, "deleted", true]);
      announce("Renamed to " + text);
      act("renaming " + q(orig), ops, { animate: false });
    },
  });
}

function editSection(span, id, x, y) {
  const orig = nameOf(id);
  editInPlace(span, {
    key: "#" + id, row: span.closest(".sec-head"), orig, max: MAX_SECTION, x, y,
    onDelete: canDelete(id) ? () => deleteSection(id) : null, deleteLabel: "Delete section " + orig,
    onSave: name => renameSection(id, name),
  });
}

/* ---------- Suggestions from everything bought before ---------- */

function suggestions(text) {
  const n = keyOf(text);
  if (n.length < 3) return [];
  const scored = [];
  for (const it of items) {
    if (!it.checked || settling.has(it.id)) continue;
    const t = keyOf(it.text);
    const at = t.indexOf(n);
    if (at < 0) continue;
    const wordStart = at === 0 || /[\s(,'-]/.test(t[at - 1]);
    scored.push({ it, score: at === 0 ? 0 : wordStart ? 1 : 2 });
  }
  scored.sort((a, b) => a.score - b.score || b.it.checkedAt - a.it.checkedAt);
  return scored.slice(0, 5).map(x => x.it);
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
function paintSug(sec, list) {
  const sh = shells[sec], query = sh.input.value;
  sh.sug.replaceChildren(...list.map((it, i) => h("li", {
    role: "option", id: "sug-" + sec + "-" + i, class: "sugopt",
    "aria-selected": String(ui.sugSec === sec && i === ui.sugIndex),
    onpointerdown: e => e.preventDefault(),
    onclick: () => revive(it.id, sec),
  }, icon("back"), h("span", { class: "t" }, highlight(it.text, query)))));
  sh.sug.hidden = !list.length;
  sh.input.setAttribute("aria-expanded", String(list.length > 0));
  if (list.length && ui.sugIndex >= 0) sh.input.setAttribute("aria-activedescendant", "sug-" + sec + "-" + ui.sugIndex);
  else sh.input.removeAttribute("aria-activedescendant");
}
function updateSug(sec) {
  if (ui.sugSec && ui.sugSec !== sec) paintSug(ui.sugSec, []);
  const list = suggestions(shells[sec].input.value);
  ui.sugSec = list.length ? sec : null;
  ui.sug = list;
  ui.sugIndex = -1;
  paintSug(sec, list);
}
function closeSug() {
  if (ui.sugSec) paintSug(ui.sugSec, []);
  ui.sugSec = null; ui.sug = []; ui.sugIndex = -1;
}

/* ---------- Section cards, kept between renders so a focused field keeps its keyboard ---------- */

const shells = {};
function buildShell(id) {
  const ul = h("ul", { class: "items", "data-sec": id });
  const input = h("input", {
    type: "text", class: "add-input", id: "add-" + id, placeholder: "Add item",
    maxlength: String(MAX_ITEM), enterkeyhint: "enter", autocomplete: "off", autocapitalize: "sentences", spellcheck: "false",
    role: "combobox", "aria-autocomplete": "list", "aria-expanded": "false", "aria-controls": "sug-" + id,
    dataset: { fk: "add-" + id },
  });
  const form = h("form", { class: "add", autocomplete: "off", onsubmit: e => { e.preventDefault(); submitAdd(id); } },
    h("label", { class: "add-plus", for: "add-" + id, "aria-hidden": "true" }, icon("plus")), input);
  const sug = h("ul", { class: "sug", id: "sug-" + id, role: "listbox", "aria-label": "Bought before", hidden: true });
  const name = h("span", { class: "sec-name", id: "h-" + id, role: "button", tabindex: "0", dataset: { fk: "name-" + id } });
  name.addEventListener("click", e => { if (editingId !== "#" + id) editSection(name, id, e.clientX, e.clientY); });
  name.addEventListener("keydown", e => {
    if (editingId === "#" + id) return;
    if (e.key === "Enter" || e.key === " " || e.key === "F2") { e.preventDefault(); editSection(name, id); }
  });
  const kind = h("span", { class: "kind", "aria-hidden": "true" });
  const head = h("h2", { class: "sec-head" }, name, kind);
  const el = h("section", { class: "sec", "data-sec": id, "aria-labelledby": "h-" + id }, head, ul, sug, form);
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
    if (e.key === "Escape") { closeSug(); return; }
    if (ui.sugSec !== id || !ui.sug.length) return;
    if (e.key === "ArrowDown") { e.preventDefault(); ui.sugIndex = (ui.sugIndex + 1) % ui.sug.length; paintSug(id, ui.sug); }
    else if (e.key === "ArrowUp") { e.preventDefault(); ui.sugIndex = ui.sugIndex <= 0 ? ui.sug.length - 1 : ui.sugIndex - 1; paintSug(id, ui.sug); }
  });
  const sh = { el, ul, input, form, sug, name, kind, icon: undefined };
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
    sh.name.setAttribute("aria-label", s.name + ", rename");
    sh.input.setAttribute("aria-label", "Add item to " + s.name);
    if (sh.icon !== s.icon) { sh.icon = s.icon; sh.kind.replaceChildren(s.icon ? icon(s.icon) : ""); }
    if (list.children[i] !== sh.el) list.insertBefore(sh.el, list.children[i] || null);
  });
}

/* ---------- Items ---------- */

function itemEl(it) {
  const li = h("li", {
    class: "item" + (it.checked ? " done" : ""), "data-id": it.id,
    style: "--sec:var(--" + colorOf(it.section) + ");view-transition-name:v" + it.id.replace(/[^A-Za-z0-9]/g, "_"),
  });
  const chk = h("input", { type: "checkbox", class: "chk", id: "chk-" + it.id, "aria-label": it.text, dataset: { fk: "chk-" + it.id } });
  chk.checked = it.checked;
  chk.addEventListener("change", () => toggle(it.id, chk.checked));
  chk.addEventListener("keydown", e => {
    if (e.altKey && (e.key === "ArrowUp" || e.key === "ArrowDown") && inList(it)) { e.preventDefault(); nudge(it.id, e.key === "ArrowUp" ? -1 : 1); }
    else if (e.key === "Delete") { e.preventDefault(); del(it.id); }
  });
  const cell = h("label", { class: "boxcell", for: "chk-" + it.id },
    chk, h("span", { class: "box", "aria-hidden": "true" }, icon("check")), h("span", { class: "grip", "aria-hidden": "true" }, icon("grip")));
  cell.addEventListener("click", e => { if (suppressClick) { e.preventDefault(); suppressClick = false; } });
  const text = h("span", { class: "text", id: "txt-" + it.id, role: "button", tabindex: "0", "aria-label": "Edit " + it.text, dataset: { fk: "txt-" + it.id } }, it.text);
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
  bindPress(li, it.id);
  return li;
}

/* Press and hold, then move, to drag */
function bindPress(li, id) {
  let timer = null, p = null;
  const off = () => {
    clearTimeout(timer); timer = null; p = null; lifted = false;
    li.classList.remove("pressing", "lifted");
    removeEventListener("pointermove", move);
    removeEventListener("pointerup", off);
    removeEventListener("pointercancel", off);
  };
  const draggable = () => !!(li.parentElement && li.parentElement.dataset.sec);
  const lift = () => {
    clearTimeout(timer); timer = null;
    if (!p || p.lifted) return;
    if (!draggable()) { suppressClick = true; off(); return; }
    p.lifted = true; lifted = true; suppressClick = true;
    li.classList.remove("pressing");
    li.classList.add("lifted");
    buzz(8);
  };
  const move = e => {
    if (!p) return;
    const d = Math.hypot(e.clientX - p.x, e.clientY - p.y);
    if ((p.lifted || p.mouse) && d > 6 && draggable()) {
      const offY = p.y - li.getBoundingClientRect().top;
      off();
      suppressClick = true;
      startDrag(li, id, offY, e.clientY);
    } else if (!p.lifted && !p.mouse && d > 8) off();
  };
  li.addEventListener("pointerdown", e => {
    if (e.button > 0 || editingId || drag) return;
    suppressClick = false;
    p = { x: e.clientX, y: e.clientY, mouse: e.pointerType === "mouse", lifted: false };
    li.classList.add("pressing");
    timer = setTimeout(lift, LONG_PRESS_MS);
    addEventListener("pointermove", move);
    addEventListener("pointerup", off);
    addEventListener("pointercancel", off);
  });
  li.addEventListener("contextmenu", e => {
    if (e.pointerType === "mouse") return;
    e.preventDefault();
    if (p && !p.mouse && !editingId) lift();
  });
}
document.addEventListener("touchmove", e => { if (lifted || drag) e.preventDefault(); }, { passive: false });

function startDrag(li, id, offY, y) {
  const r = li.getBoundingClientRect();
  const ghost = li.cloneNode(true);
  ghost.classList.remove("lifted", "pressing", "flash", "hint");
  ghost.classList.add("ghost");
  ghost.style.viewTransitionName = "none";
  ghost.querySelectorAll("[id]").forEach(n => n.removeAttribute("id"));
  Object.assign(ghost.style, { left: r.left + "px", top: (y - offY) + "px", width: r.width + "px" });
  document.body.append(ghost);
  li.classList.add("placeholder");
  document.documentElement.classList.add("dragging");
  drag = { id, li, ghost, offY, y, raf: 0, toTick: false };
  addEventListener("pointermove", onDragMove);
  addEventListener("pointerup", endDrag);
  addEventListener("pointercancel", endDrag);
  drag.raf = requestAnimationFrame(dragTick);
  place(y);
}
function onDragMove(e) {
  if (!drag) return;
  drag.y = e.clientY;
  drag.ghost.style.top = (e.clientY - drag.offY) + "px";
  place(e.clientY);
}
function dragTick() {
  if (!drag) return;
  const y = drag.y, H = innerHeight;
  let dy = 0;
  if (y < 64) dy = -Math.ceil((64 - y) / 6);
  else if (y > H - 64) dy = Math.ceil((y - (H - 64)) / 6);
  if (dy) { window.scrollBy(0, dy); place(y); }
  drag.raf = requestAnimationFrame(dragTick);
}
function place(y) {
  // Over the drop zone below the sections: the item will be ticked.
  const toTick = y > $("#tick-drop").getBoundingClientRect().top - 12;
  if (toTick !== drag.toTick) {
    drag.toTick = toTick;
    drag.li.classList.toggle("away", toTick);
    drag.ghost.classList.toggle("to-tick", toTick);
    $("#tick-drop").classList.toggle("over", toTick);
    if (toTick) buzz(8);
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
  drag.li.style.setProperty("--sec", "var(--" + colorOf(ul.dataset.sec) + ")");
  drag.ghost.style.setProperty("--sec", "var(--" + colorOf(ul.dataset.sec) + ")");
}
function endDrag() {
  if (!drag) return;
  const { li, ghost, id, toTick } = drag;
  cancelAnimationFrame(drag.raf);
  removeEventListener("pointermove", onDragMove);
  removeEventListener("pointerup", endDrag);
  removeEventListener("pointercancel", endDrag);
  ghost.remove();
  document.documentElement.classList.remove("dragging");
  $("#tick-drop").classList.remove("over");
  drag = null;
  try { localStorage.setItem(HINT_KEY, "1"); } catch (_) {}
  if (toTick) {
    const it = find(id);
    buzz(12);
    announce(it.text + " ticked");
    act("checking " + q(it.text), [[id, "checked", true], [id, "checkedAt", Date.now()]]);
    return;
  }
  const ul = li.parentElement, sec = ul.dataset.sec;
  const sibs = [...ul.children], i = sibs.indexOf(li);
  const prev = sibs[i - 1] && find(sibs[i - 1].dataset.id);
  const next = sibs[i + 1] && find(sibs[i + 1].dataset.id);
  const it = find(id);
  if (it.section !== sec) announce(it.text + " moved to " + nameOf(sec));
  const fk = activeFk();
  if (!store.change("moving " + q(it.text), [[id, "section", sec], [id, "pos", between(prev && prev.pos, next && next.pos)]])) {
    if (renderPending) refreshFromStore();
    return;
  }
  items = store.items();
  paint(fk, false);
  scheduleSettle();
}

/* ---------- Render ---------- */

function setHist(btn, label, verb) {
  btn.setAttribute("aria-disabled", String(!label));
  btn.setAttribute("aria-label", label ? verb + " " + label : verb);
  btn.title = label ? verb + " " + label : verb;
}
function paintStatus() {
  const { online, full, waiting } = store.status();
  const el = $("#status");
  el.hidden = online;
  const queued = waiting ? " · " + waiting + (waiting === 1 ? " change" : " changes") + " to send" : "";
  el.textContent = (full ? "The list is full on the server" : "Offline") + queued;
}
function render() {
  computeSections();
  syncShells();
  for (const s of sections) shells[s.id].ul.replaceChildren(...shown(s.id).map(itemEl));
  const since = Date.now() - TRIP_MS;
  const basket = items.filter(i => i.checked && !settling.has(i.id) && i.checkedAt >= since).sort((a, b) => b.checkedAt - a.checkedAt);
  $("#basket").hidden = basket.length === 0;
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
function openPair() {
  const link = store.pairingLink();
  $("#qr").replaceChildren(window.qrcode ? qrSvg(link) : "");
  $("#share-link").hidden = !navigator.share;
  $("#pair").showModal();
}
$("#pair-open").addEventListener("click", openPair);
$("#pair-close").addEventListener("click", () => $("#pair").close());
$("#share-link").addEventListener("click", () => {
  navigator.share({ title: "Panier", url: store.pairingLink() }).catch(() => {});
});
$("#copy-link").addEventListener("click", async e => {
  const b = e.currentTarget;
  try {
    await navigator.clipboard.writeText(store.pairingLink());
    b.textContent = "Copied";
  } catch (_) {
    b.textContent = "Couldn't copy";
  }
  setTimeout(() => { b.textContent = "Copy link"; }, 2000);
});

/* ---------- Wiring and start ---------- */

$("#add-sec-form").addEventListener("submit", e => { e.preventDefault(); addSection($("#add-sec").value); });
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
  code: "That setup code didn't work. Check it on the server and try again.",
  link: "That link is incomplete. Ask for the link again from the phone that has the list.",
  server: "Couldn't reach the server. Check your connection and try again.",
};
$("#setup-form").addEventListener("submit", async e => {
  e.preventDefault();
  const code = $("#setup-code").value;
  if (!code.trim()) return;
  try {
    await store.createList(code);
    showList();
    openPair();
  } catch (err) {
    showWelcome(MESSAGES[err.message] || MESSAGES.server);
  }
});

async function init() {
  const params = new URLSearchParams(location.hash.slice(1));
  if (location.hash) history.replaceState(null, "", location.pathname); // keep keys out of history
  try {
    if (params.get("k")) await store.join(params.get("k"));
    else if (params.get("setup") && !store.hasList()) {
      await store.createList(params.get("setup"));
      showList();
      openPair();
      return;
    }
  } catch (err) {
    if (!store.hasList()) return showWelcome(MESSAGES[err.message] || MESSAGES.server);
  }
  if (!store.hasList()) return showWelcome();
  showList();
  store.start();
}
init();

if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
