// Sheets, the dialogs over the page, and the browser's history, which they and the list
// on screen are steps in.

import { t } from "./i18n.js";
import { state, nav } from "./state.js";
import { $ } from "./dom.js";

// A list opened from the lists page is a step in the browser's history, and so is each
// sheet on top (sharing, either page of settings, and what those open over themselves),
// so the phone's back gesture steps back through them like pages. Each step holds the
// path to it: the list, if one is open, then each sheet, in the order they opened. The
// app changes what it shows at once, and history follows: a step back lands a moment
// later, so the next step waits for it, and a slow one can never land on top of what came
// after it and undo it. Each sheet opening is its own step, so one left over from before
// a reload doesn't count.
let stepping = false, syncing = false;
const open = []; // the sheets open, in the order they opened
const LIST = "list:";
const pathOf = s => (s && Array.isArray(s.path) ? s.path : []);
const listIn = path => (path[0] && path[0].startsWith(LIST) ? path[0].slice(LIST.length) : null);
export const listInHistory = () => listIn(pathOf(history.state));
export function follow() {
  if (stepping || syncing) return;
  const have = pathOf(history.state);
  const want = [...(state.view === "list" ? [LIST + state.lid] : []), ...open.map(d => d.dataset.step)];
  let k = 0;
  while (k < have.length && k < want.length && have[k] === want[k]) k++;
  if (k === have.length && k === want.length) return;
  if (k < have.length) {
    // Another list in place of the one history has: it takes its place, rather than a step back and on.
    if (k === 0 && have.length === 1 && listIn(have) && listIn(want)) { history.replaceState({ path: want.slice(0, 1) }, ""); k = 1; }
    else { stepping = true; return history.back(); }
  }
  for (let i = k; i < want.length; i++) history.pushState({ path: want.slice(0, i + 1) }, "");
}
export function openSheet(dlg) {
  dlg.showModal();
  dlg.focus(); // the sheet itself, not its first button, which would show a focus ring
  dlg.dataset.step = Date.now() + "-" + Math.random();
  open.push(dlg);
  follow();
}
for (const dlg of document.querySelectorAll("dialog")) dlg.addEventListener("close", () => {
  const i = open.indexOf(dlg);
  if (i >= 0) open.splice(i, 1);
  follow();
});
addEventListener("popstate", e => {
  if (stepping) { stepping = false; return follow(); }
  // The back gesture, or forward: what's shown follows history. Between the lists page and
  // a list, or back from a page of settings, the page turns as it does for a tap, unless
  // the browser has already shown a move of its own; history is read again as it turns,
  // so a later step still wins.
  const path = pathOf(history.state), lid = listIn(path), top = open[open.length - 1];
  const between = !open.length && path.length === (lid ? 1 : 0) && (lid ? state.view !== "list" : state.view === "list");
  const leaving = !!top && top.classList.contains("page") && !path.includes(top.dataset.step);
  if (e.hasUAVisualTransition || !(between || leaving)) showHistory();
  else if (leaving) nav.turn(false, showHistory, () => $("#" + top.id + "-open")); // into what opened it
  else nav.turn(!!lid, showHistory);
});
function showHistory() {
  const path = pathOf(history.state), lid = listIn(path);
  syncing = true;
  try {
    for (const dlg of [...open].reverse()) if (!path.includes(dlg.dataset.step)) dlg.close();
    if (lid) { if (state.view !== "list" || state.lid !== lid) nav.showList(lid); }
    else if (state.view !== "lists") nav.showLists();
  } finally {
    syncing = false;
  }
  follow();
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
