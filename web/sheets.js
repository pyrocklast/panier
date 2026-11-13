// Sheets, the dialogs over the page, and the browser's history, which they and the list
// on screen are steps in.

import { t } from "./i18n.js";
import { state, nav } from "./state.js";
import { $ } from "./dom.js";

// A list opened from the lists page is a step in the browser's history, and so is a sheet
// (sharing, Settings) on top, so the phone's back gesture steps back through them like
// pages. The app changes what it shows at once, and history follows: a step back lands a
// moment later, so the next step waits for it, and a slow one can never land on top of
// what came after it and undo it. Each sheet opening is its own step, so one left over
// from before a reload doesn't count.
let stepping = false, syncing = false;
export function follow() {
  if (stepping || syncing) return;
  const s = history.state || {}, dlg = document.querySelector("dialog[open]");
  const want = [...(state.view === "list" ? [{ list: state.lid }] : []), ...(dlg && dlg.dataset.step ? [{ sheet: dlg.dataset.step }] : [])];
  const top = want[want.length - 1] || {};
  if (s.sheet ? s.sheet === top.sheet : s.list ? s.list === top.list : !want.length) return;
  if (s.sheet || (s.list && !(want[0] && want[0].list))) { stepping = true; return history.back(); }
  let rest = want;
  if (s.list) { if (s.list !== want[0].list) history.replaceState(want[0], ""); rest = want.slice(1); }
  for (const w of rest) history.pushState(w, "");
}
export function openSheet(dlg) {
  dlg.showModal();
  dlg.focus(); // the sheet itself, not its first button, which would show a focus ring
  dlg.dataset.step = Date.now() + "-" + Math.random();
  follow();
}
for (const dlg of document.querySelectorAll("dialog")) dlg.addEventListener("close", follow);
addEventListener("popstate", () => {
  if (stepping) { stepping = false; return follow(); }
  // The back gesture, or forward: what's shown follows history.
  const s = history.state || {};
  syncing = true;
  try {
    for (const dlg of document.querySelectorAll("dialog[open]")) if (s.sheet !== dlg.dataset.step) dlg.close();
    if (!s.sheet) {
      if (s.list) { if (state.view !== "list" || state.lid !== s.list) nav.showList(s.list); }
      else if (state.view !== "lists") nav.showLists();
    }
  } finally {
    syncing = false;
  }
  follow();
});
export function closeThen(dlg, fn) {
  if (dlg.open) dlg.close();
  fn();
}

// Deleting a list and changing its key ask first. more is a second, quieter answer, as
// Delete for everyone is to Delete; a sheet already open asks its next question in place.
export function confirmSheet({ title, text, ok, run, more = null }) {
  const dlg = $("#confirm"), btn = $("#confirm-ok"), alt = $("#confirm-more");
  $("#confirm-title").textContent = title;
  $("#confirm-text").textContent = text;
  $("#confirm-error").hidden = true;
  btn.textContent = ok;
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
  alt.hidden = !more;
  alt.textContent = more ? more.label : "";
  alt.onclick = more && more.run;
  if (dlg.open) dlg.focus();
  else openSheet(dlg);
}
$("#confirm-cancel").addEventListener("click", () => $("#confirm").close());
