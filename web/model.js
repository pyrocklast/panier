// What a list is made of: its sections and colours, how names and quantities are read,
// which sections show, and a list as Markdown reads and writes it. Nothing here touches
// the page.

import { t, lang } from "./i18n.js";
import { newId } from "./store.js";

// A list holds the sections written into it, and one more, implied: the section without a
// name, in ink, where a plain sheet's items go. implied() is what that section is until a
// field of it is written, so undo can put it back.
export const PLAIN = { id: "ess", name: "", color: "ess", pos: 0 };
export const implied = (id, field) => (id === PLAIN.id ? PLAIN[field] : undefined);
// Section colours, in palette order; each is a colour in app.css, light and dark. Ink,
// the colour of the section without a name and of the app's buttons, comes first; then
// eight hues.
export const COLORS = [["ess", "Ink"], ["green", "Green"], ["teal", "Teal"], ["blue", "Blue"], ["long", "Indigo"], ["plum", "Plum"], ["rose", "Rose"], ["look", "Amber"], ["olive", "Olive"]];
export const PALETTE = ["teal", "rose", "green", "blue", "olive", "plum", "look", "long", "ess"]; // new sections take the first unused
const colorOk = (c, fallback) => (COLORS.some(([id]) => id === c) ? c : fallback);
// The list's own colour tints the paper: white, the paper as it is, then the section
// colours but ink.
export const LIST_COLORS = [["", "White"], ...COLORS.filter(([id]) => id !== "ess")];
export const listColorOk = c => (LIST_COLORS.some(([id]) => id === c) ? c : "");

export const MAX_ITEM = 300; // a few sentences, about eight lines on a phone
export const MAX_SECTION = 40; // and the list's name
export const LIST = "@list"; // where the list's own name is kept, among items and sections
export const listTitle = name => name || t("Untitled list"); // what a list is called on screen

// A new list is a plain sheet: it writes only its name, if it has one, and its format. An
// app that reads only format 1 still implies three sections, so it waits for its update.
export const startOps = (name = "") => [[LIST, "format", 2], ...(name ? [[LIST, "name", name]] : [])];

// How many days ticked items stay in view in the ticked group, chosen for each list and
// the same for everyone on it: a day, a week, a month, or always (0). Afterwards they're
// still suggested. Anything else, or nothing, is a week.
const TICKED = [1, 7, 30, 0];
export const tickedOk = d => (TICKED.includes(d) ? d : 7);
// Ticked before, as an import or a paste brings it: older than the ticked group shows,
// unless it shows everything.
export const BEFORE_MS = 31 * 864e5;

export const fold = s => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
export const keyOf = s => fold(s).replace(/\s+/g, " ").trim();
// A quantity at the start of an item, such as "2", "2×", "500 g", "1.5kg", "2 litres of"
// or "3 paquets de", is shown apart from the name and left out when comparing names, so
// "2 litres of milk" is still Milk.
const UNITS = "kg|kilos?|kilogram(?:me)?s?|g|grams?|grammes?|mg|ml|cl|dl|l|lit(?:re|er)s?|lbs?|pounds?|oz|ounces?|" +
  "packs?|packets?|bottles?|cans?|tins?|jars?|bags?|box(?:es)?|cartons?|slices?|bunch(?:es)?|" +
  "paquets?|bouteilles?|bo[iî]tes?|pots?|sachets?|tranches?|briques?|bottes?|canettes?|sacs?";
const QTY = new RegExp("^((?:\\d+(?:[.,]\\d+)?|[½¼¾⅓⅔])\\s*(?:[x×]|(" + UNITS + ")(?![\\p{L}\\d]))?)\\s+(?=\\S)", "iu");
const OF = /^(?:(?:of|de)\s+|d['’]\s*)(?=\S)/i; // after a unit: "2 litres of milk", "1 l d’huile"
export function splitQty(text) {
  const m = QTY.exec(text);
  if (!m) return { qty: "", sep: "", name: text };
  let sep = m[0].slice(m[1].length), name = text.slice(m[0].length);
  const of = m[2] && OF.exec(name);
  if (of) { sep += of[0]; name = name.slice(of[0].length); }
  return { qty: m[1], sep, name };
}
// Each text's key is worked out once: names are compared with every past item on every
// keystroke.
const nameKeys = new Map();
export function nameKey(s) {
  let k = nameKeys.get(s);
  if (k === undefined) {
    if (nameKeys.size > 5000) nameKeys.clear();
    nameKeys.set(s, (k = keyOf(splitQty(s).name)));
  }
  return k;
}
// An item's name without its quantity, with a capital, as if typed on its own.
export function bare(text) {
  const { qty, name } = splitQty(text);
  return qty ? name.charAt(0).toLocaleUpperCase(lang) + name.slice(1) : text;
}
// An item's text after typing typed for it: a quantity typed replaces its quantity.
export function retext(old, typed) {
  const n = splitQty(typed);
  return n.qty ? n.qty + n.sep + splitQty(old).name : old;
}
// What an item ticked before comes back as from its suggestion: its name, with the
// quantity typed so far, if any. Its old quantity stays behind.
export const fromHint = (old, typed) => (splitQty(typed).qty ? retext(old, typed) : bare(old));

export const clean = (s, max = MAX_ITEM) => s.replace(/\s+/g, " ").trim().slice(0, max);

export function between(a, b) {
  if (a == null && b == null) return 1;
  if (a == null) return b - 1;
  if (b == null) return a + 1;
  return (a + b) / 2;
}

// Works out which sections to show. A section stays on screen while it has items to
// tick, or text being typed into it, even if someone deleted it meanwhile; inList says
// which items are still to tick, which on screen includes those just ticked.
export function layout(storedSections, its, typing = [], inList = i => !i.checked) {
  const stored = new Map(storedSections.map(s => [s.id, s]));
  const all = new Map(), p = stored.get(PLAIN.id) || {};
  all.set(PLAIN.id, { ...PLAIN, name: p.name ?? PLAIN.name, color: colorOk(p.color, PLAIN.color), pos: p.pos ?? PLAIN.pos, deleted: !!p.deleted });
  for (const st of stored.values()) {
    if (!all.has(st.id)) all.set(st.id, { id: st.id, name: st.name || t("Untitled section"), color: colorOk(st.color, PALETTE[0]), pos: st.pos ?? 100, deleted: st.deleted });
  }
  const used = new Set(its.filter(inList).map(i => i.section));
  for (const id of typing) used.add(id);
  for (const id of used) if (!all.has(id)) all.set(id, { id, name: t("Untitled section"), color: PALETTE[0], pos: 100, deleted: false });
  // The section without a name always comes first.
  const order = (a, b) => !!a.name - !!b.name || a.pos - b.pos || (a.id < b.id ? -1 : 1);
  const shown = [...all.values()].filter(s => !s.deleted || used.has(s.id)).sort(order);
  // Two phones can each delete one of the last two sections at once: the first of them
  // stays on screen, so there's always somewhere to add an item.
  return { all, shown: shown.length ? shown : [[...all.values()].sort(order)[0]] };
}

// A list as Export writes it: its sections as on screen, each with its items to tick,
// then those ticked before, latest first.
export function sheetOfList({ name, color, sections: stored, items: its }) {
  const { shown } = layout(stored, its);
  const at = new Map(shown.map((s, k) => [s.id, k]));
  const secs = shown.map(s => ({ name: s.name, color: s.color, items: [] }));
  for (const i of its.filter(i => !i.checked).sort((a, b) => a.pos - b.pos)) secs[at.get(i.section) ?? 0].items.push({ text: i.text, checked: false });
  for (const i of its.filter(i => i.checked).sort((a, b) => b.checkedAt - a.checkedAt)) secs[at.get(i.section) ?? 0].items.push({ text: i.text, checked: true });
  return { name: listTitle(name), color: color || "", sections: secs };
}

// The changes that make a list as read from Markdown, on top of a new list's start: its
// sections in order, the first without a name being the list's own, where items before
// the first heading go; each name once; what was ticked before kept out of the ticked
// group, to be suggested.
export function importOps(l) {
  const ops = [], used = new Set(), colours = new Set(), seen = new Set();
  const old = Date.now() - BEFORE_MS;
  let n = 0, k = 0;
  if (l.name) ops.push([LIST, "name", clean(l.name, MAX_SECTION)]);
  if (listColorOk(l.color)) ops.push([LIST, "color", l.color]);
  l.sections.forEach((sec, i) => {
    const name = sec.name ? clean(sec.name, MAX_SECTION) : "";
    const own = !name && !used.has(PLAIN.id), id = own ? PLAIN.id : newId(), key = "#" + id;
    const color = colorOk(sec.color, own ? PLAIN.color : PALETTE.find(c => !colours.has(c)) || PALETTE[0]);
    used.add(id);
    colours.add(color);
    ops.push([key, "name", name || (own ? "" : t("Untitled section"))], [key, "pos", i + 1], [key, "color", color], [key, "deleted", false]);
    sec.items.forEach((it, j) => {
      const text = clean(it.text), nk = text && nameKey(text);
      if (!text || seen.has(nk)) return;
      seen.add(nk);
      const iid = newId();
      ops.push([iid, "text", text], [iid, "section", id], [iid, "pos", j + 1], [iid, "deleted", false]);
      if (it.checked) ops.push([iid, "checked", true], [iid, "checkedAt", old - k++]);
      n++;
    });
  });
  return { ops, n };
}
