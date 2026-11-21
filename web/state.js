// What the app's parts share: what's on screen and what's under way, and a few words
// about the list on screen.

import * as store from "./store.js";
import { listColorOk, tickedOk, listTitle } from "./model.js";

export const state = {
  view: null, // "list", the list lid, or "lists", the lists page
  lid: null, // the list on screen, or last on screen
  drag: null, // a drag in progress: an item's, a section's, a sheet's
  editing: null, // what's being edited in place: an item's id, "#" and a section's, or a new list's name
  lifted: false, // held long enough to drag
  suppressClick: false, // the click that ends a hold or a drag does nothing
  pointerDown: false,
  removed: [], // lists deleted from this phone since the app opened, for undo
};
// app.js fills these in: showList(lid), showLists(), and turn(into, update, at), which
// turns the page quietly between the lists page, a list and their settings as update
// changes it, from what at() returns.
export const nav = {};

// A closed list, or one from a newer Panier, is only read: what's done here could never be
// sent, so nothing can be added, edited, moved or ticked.
export const readOnly = () => state.view === "list" && (store.status().closed || store.newerFormat());
export const listName = () => listTitle(store.listName());
export const listColor = () => listColorOk(store.listColor());
export const tickedDays = () => tickedOk(store.listTicked());
export const draftsKey = (lid = store.current()) => "panier2-drafts:" + lid; // text typed into a list's "Add item" fields, kept until added
