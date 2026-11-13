// Small helpers for the page: finding and making elements, and a few things several
// parts of the app do to them.

import { splitQty, keyOf } from "./model.js";

export const $ = s => document.querySelector(s);

export const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)");

// Fills an item's text: the quantity in its own span, the name after it.
export function fillText(el, text) {
  const { qty, sep, name } = splitQty(text);
  el.replaceChildren(...(qty ? [h("span", { class: "qty" }, qty.replace(/^([\d.,½¼¾⅓⅔]+\s*)x$/i, "$1×")), sep] : []), name);
}

export const buzz = ms => { try { if (navigator.vibrate) navigator.vibrate(ms); } catch (_) {} };

export function h(tag, attrs, ...kids) {
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
export function icon(name) {
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
export const emptyField = input => { input.value = ""; input.form.classList.remove("typing"); };
export function addRow(form, input, { add, clear = () => emptyField(input), escape = clear }) {
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

export function announce(msg) {
  const l = $("#live");
  l.textContent = "";
  requestAnimationFrame(() => { l.textContent = msg; });
}
export const activeFk = () => { const a = document.activeElement; return a && a.dataset ? a.dataset.fk : null; };

// Puts rows into ul in this order: those that left go first, so the rest only move if
// their order changed.
export function setRows(ul, list) {
  const want = new Set(list);
  for (const li of [...ul.children]) if (!want.has(li)) li.remove();
  let at = ul.firstElementChild;
  for (const li of list) {
    if (li === at) at = at.nextElementSibling;
    else ul.insertBefore(li, at);
  }
}

export function download(name, text) {
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
