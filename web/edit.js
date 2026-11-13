// Editing a text in place: an item, a section's name, the list's.

import { t } from "./i18n.js";
import { state } from "./state.js";
import { clean } from "./model.js";
import { h, icon } from "./dom.js";

const PLAIN = (() => { try { const d = document.createElement("div"); d.contentEditable = "plaintext-only"; return d.contentEditable === "plaintext-only"; } catch (_) { return false; } })();

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
// onDone runs whenever editing ends, and onUnchanged when it ends with the text as it was.
export function editInPlace(span, { key, row, orig, max, x, y, caret, fill, onSave, onDelete, deleteLabel, onSplit, canJoin, onJoin, onEmpty, below, onDone, onUnchanged }) {
  if (state.editing || state.drag) return;
  state.editing = key;
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
    if (onDone) onDone();
    span.contentEditable = "false";
    span.classList.remove("editing");
    span.setAttribute("role", "button");
    row.classList.remove("editing");
    state.editing = null;
    if (then) return then();
    const text = clean(span.textContent, max);
    if (!text && !cancelled && !away && onEmpty) return onEmpty();
    if (cancelled || !text || text === orig) {
      show();
      if (onUnchanged && !binned) onUnchanged();
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

// Colours to choose from while a name is edited: a tap recolours at once, and the name
// stays in editing.
export function palette(name, colors, current, pick) {
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
