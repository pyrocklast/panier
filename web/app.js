// Panier's screen: this file starts the app and moves between its two views, the lists
// page (lists.js) and a list (list.js). store.js keeps the lists themselves.

import * as store from "./store.js";
import { translatePage } from "./i18n.js";
import { state, nav } from "./state.js";
import { $ } from "./dom.js";
import * as list from "./list.js";
import * as lists from "./lists.js";
import { paintStatus } from "./bar.js";
import { follow } from "./sheets.js";
import { openPair, peopleChanged } from "./share.js";
import { keepList } from "./settings.js";

$("#lists-open").addEventListener("click", showLists);
// Undo is the list's on a list, and on the lists page brings back a list deleted from this phone.
const undo = () => (state.view === "lists" ? lists.undoRemove() : list.undo());
const redo = () => { if (state.view === "list") list.redo(); };
$("#undo").addEventListener("click", undo);
$("#redo").addEventListener("click", redo);
document.addEventListener("keydown", e => {
  const a = document.activeElement;
  if (!(e.ctrlKey || e.metaKey) || (a && (a.type === "text" || a.isContentEditable))) return;
  const k = e.key.toLowerCase();
  if (k === "z" && !e.shiftKey) { e.preventDefault(); undo(); }
  else if ((k === "z" && e.shiftKey) || k === "y") { e.preventDefault(); redo(); }
});

// Back on screen, or back online, the lists page catches up too.
document.addEventListener("visibilitychange", () => {
  if (document.hidden) return;
  if (state.view === "lists") store.refreshAll();
  else if (state.view === "list") list.repaint();
});
addEventListener("online", () => { if (state.view === "lists") store.refreshAll(); });
store.subscribe(kind => {
  if (kind === "lists") {
    if (state.view === "list" && !store.current()) showLists(); // taken off this phone in another tab
    else lists.renderLists();
  }
  else if (state.view !== "list") return;
  else if (kind === "remote") {
    list.refreshFromStore();
    peopleChanged();
  }
  else if (kind === "status" || kind === "local") {
    paintStatus();
    if (list.readOnlyChanged()) list.refreshFromStore();
  }
});

function showList(lid) {
  const from = document.activeElement;
  if (!store.open(lid)) return showLists();
  const switched = state.lid !== lid;
  if (switched) list.reset();
  lists.clearNotice();
  state.lid = lid;
  state.view = "list";
  follow();
  $("#lists").hidden = true;
  $("#app").hidden = false;
  if (window.panierView) window.panierView("");
  if (switched) window.scrollTo(0, 0);
  list.show(lid);
  // Opened from the keyboard, the cursor moves to the list's name rather than stay on a
  // sheet now hidden; a tap shows no ring for it.
  if (from && $("#lists").contains(from)) $("#list-name").focus({ preventScroll: true });
}
function showLists() {
  const from = document.activeElement;
  if (state.view === "list") { list.closeSug(); store.leave(); }
  state.view = "lists";
  follow();
  $("#app").hidden = true;
  $("#lists").hidden = false;
  if (window.panierView) window.panierView("lists");
  document.title = "Panier";
  store.refreshAll();
  lists.renderLists();
  paintStatus();
  window.scrollTo(0, 0);
  // Back from a list, the cursor returns to its sheet.
  const sheet = lists.sheetButton(state.lid);
  if (from && $("#app").contains(from) && sheet) sheet.focus({ preventScroll: true });
}

// The app opens on the list last used, or the lists page when there's none. A link adds
// the lists it holds: with one, that list opens.
async function init() {
  const params = new URLSearchParams(location.hash.slice(1));
  if (location.hash) history.replaceState(null, "", location.pathname); // keep keys out of history
  const keys = store.keysIn(params.get("k"));
  if (params.has("k") && !keys.length) lists.say(lists.MESSAGES.link);
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
      lists.say(lists.MESSAGES[err.message] || lists.MESSAGES.server);
    }
  }
  const st = history.state;
  if (st && st.list && store.lists().some(e => e.lid === st.list)) { showList(st.list); store.refreshAll(); return; }
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
nav.showList = showList;
nav.showLists = showLists;
translatePage();
init();
// A pairing or setup link opened in this tab, with the app already open: it starts afresh
// from the link, as when opened anew.
addEventListener("hashchange", () => { if (/^#(k|setup)=/.test(location.hash)) location.reload(); });

/* ---------- Updates ---------- */

// A new version installs in the background. When it takes over, the app reloads into it,
// waiting first for anything in progress: editing, typing, dragging or the pairing sheet.
function busy() {
  return !!(state.editing || state.drag || state.lifted || state.pointerDown || document.querySelector("dialog[open]") ||
    list.typing() || lists.typing());
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
