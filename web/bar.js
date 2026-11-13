// What floats at the foot of the page: undo and redo at the right, and at the left, only
// when something is wrong, the connection's status.

import * as store from "./store.js";
import { t, plural } from "./i18n.js";
import { state, readOnly } from "./state.js";
import { $, announce } from "./dom.js";

// Undo floats at the bottom right; redo joins it once something has been undone. On the
// lists page, it brings back a list taken off this phone.
let undoNote = null, noteTimer = 0;
const top = a => (a.length ? a[a.length - 1].label : null);
export function noteUndo(name) {
  clearTimeout(noteTimer);
  undoNote = name || null;
  if (undoNote) noteTimer = setTimeout(() => { undoNote = null; paintDock(); }, 5000);
}
export function paintDock() {
  const onList = state.view === "list";
  const u = onList ? store.undoLabel() : top(state.removed), r = onList ? store.redoLabel() : null;
  $("#dock").hidden = (!u && !r) || readOnly(); // undo would make a change, which a read-only list can't take
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
  if (closed) return { text: t("List closed"), detail: t("Someone closed this list, for everyone. If they gave it a new key, ask them for the new link. What's here stays on this phone until you delete it, from the lists page.") };
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
export function paintStatus() {
  if (state.view === "list") $("#pair-open").hidden = store.status().closed || store.newerFormat(); // a closed list's link opens nothing
  const now = () => (state.view === "lists" ? listsStatus() : state.view === "list" ? statusInfo() : null);
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
    $("#status-detail").textContent = s.detail;
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
