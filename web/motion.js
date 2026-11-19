// Motion: after a change, things glide to their new places.

import { $, reduceMotion } from "./dom.js";

// A floating copy over the page, at rect: a drag's ghost, or an item flying to its new
// place. It has no ids, so nothing is found twice.
export function float(el, rect, cls, top = rect.top) {
  el.classList.remove("placeholder", "away", "lifted", "pressing", "flash");
  el.classList.add(cls);
  el.querySelectorAll("[id]").forEach(n => n.removeAttribute("id"));
  el.setAttribute("aria-hidden", "true");
  Object.assign(el.style, { left: rect.left + "px", top: top + "px", width: rect.width + "px" });
  document.body.append(el);
  return el;
}

// After a change, things glide to their new places. Sections and the ticked list
// grow or shrink to their new height, and what follows moves along with them; inside
// each, items and the Add item row slide to their new spot; an item that changes place,
// such as one being ticked, rises off the page, flies across, taking the size of the row
// it becomes, and settles into the page there. New items fade in, and what you typed
// stays where you typed it; removed ones fade where they were. While dragging, what's in
// the way glides aside. Each element animates on its own, so taps keep working
// throughout, unlike with the browser's page-wide transitions.
// Motion keeps to three lengths: 160 ms for what only fades, 240 ms for what rises into
// place (app.css), 320 ms for what moves, and a longer trip takes longer.
const EASE = "cubic-bezier(0.4, 0, 0.2, 1)"; // gentle start, gentle landing; --ease-move in app.css
const LEAVE = "cubic-bezier(0.4, 0, 1, 1)"; // gentle start, then out of view at full speed
export const MOTION = { duration: 320, easing: EASE };
const QUICK = { duration: 160, easing: EASE };
// A longer trip takes longer, but less than in proportion, as something going further
// gathers speed: about 290 ms to the next row, 480 ms across a phone's screen.
const trip = d => Math.round(200 + 12 * Math.sqrt(d));
const PARTS = "#list > .sec, #basket-list";
const ITEMS = "#list .item[data-id], #basket-list .item[data-id]";
const ADDS = "#list > .sec > .add";
const TICKED = "basket-list"; // where rows are smaller
const flights = new Map(); // each flying or fading copy's animation, and how it ends
const glides = new Set(); // the glides under way, so a newer change takes over from them
export function landAll() {
  for (const [a, land] of [...flights]) { a.cancel(); land(); }
}
const rectsOf = sel => new Map([...document.querySelectorAll(sel)].map(el => [el, el.getBoundingClientRect()]));
export function snapshot() {
  landAll(); // one change at a time: anything still flying lands at once
  const its = new Map();
  for (const li of document.querySelectorAll(ITEMS)) its.set(li.dataset.id, { li, rect: li.getBoundingClientRect(), part: li.closest(PARTS) });
  return { parts: rectsOf(PARTS), adds: rectsOf(ADDS), items: its };
}
const run = (el, frames, opts = MOTION) => {
  const a = el.animate(frames, { ...opts, id: "glide" });
  glides.add(a);
  a.finished.then(() => glides.delete(a), () => {});
};
// Where things are now, without the last change's motion: each glides on from where it
// was last seen.
const stopGlides = () => { for (const a of glides) a.cancel(); glides.clear(); };
export function glide(snap) {
  const seen = r => r && r.height > 0;
  stopGlides();
  // Measure everything before moving anything.
  const parts = rectsOf(PARTS), adds = rectsOf(ADDS);
  const now = [...document.querySelectorAll(ITEMS)].map(li => ({ li, rect: li.getBoundingClientRect(), part: li.closest(PARTS) }));
  const head = $(".basket-head").getBoundingClientRect();
  // How far something moved within its section, leaving out the section's own movement.
  const inside = (wasRect, nowRect, part) => (wasRect.top - snap.parts.get(part).top) - (nowRect.top - parts.get(part).top);
  const slide = (el, dy) => { if (Math.abs(dy) > 0.5) run(el, [{ transform: `translateY(${dy}px)` }, { transform: "none" }]); };
  for (const [p, r] of parts) {
    const was = snap.parts.get(p);
    if (was && seen(r) && Math.abs(was.height - r.height) > 0.5) run(p, [{ height: was.height + "px" }, { height: r.height + "px" }]);
  }
  // An item that appears where an Add item row was is what was just typed there: it stays
  // put, and the row, empty again, slides on below it, fading in.
  const typed = new Set();
  for (const [f, r] of adds) {
    const was = snap.adds.get(f), part = f.closest(PARTS);
    if (!seen(was) || !snap.parts.has(part)) continue;
    const dy = inside(was, r, part), at = was.top - snap.parts.get(part).top;
    const it = now.find(n => n.part === part && !snap.items.has(n.li.dataset.id) && Math.abs(n.rect.top - parts.get(part).top - at) < 1);
    if (it && dy < -0.5) {
      typed.add(it.li);
      run(f, [{ transform: `translateY(${dy}px)`, opacity: 0 }, { transform: "none", opacity: 1 }]);
    } else slide(f, dy);
  }
  // Only items on screen, before or after, move: the rest are simply in their new place,
  // so a long list costs no more than a short one.
  const H = innerHeight, near = r => r.bottom > -100 && r.top < H + 100; // read once: each read can redo the layout
  const kept = new Set();
  for (const n of now) {
    const o = snap.items.get(n.li.dataset.id);
    kept.add(n.li.dataset.id);
    if (!o || !seen(o.rect)) { if (seen(n.rect) && near(n.rect) && !typed.has(n.li)) n.li.animate([{ opacity: 0 }, { opacity: 1 }], MOTION); }
    else if (!seen(n.rect)) fly(o, head, null, true); // into the folded ticked group
    else if (!near(o.rect) && !near(n.rect)) continue;
    else if (n.li.classList.contains("placeholder")) { if (Math.abs(o.rect.top - n.rect.top) > 0.5) opens(n.li); }
    else if (o.part === n.part) slide(n.li, inside(o.rect, n.rect, n.part));
    else fly(o, n.rect, n.li);
  }
  for (const [id, o] of snap.items) if (!kept.has(id) && seen(o.rect) && near(o.rect)) fade(o); // deleted
}
// While dragging, the slot opens where it goes, as what was there glides aside over it.
// Its colour grows in rather than its opacity, which would lift it over what glides past.
const opens = el => run(el, [{ backgroundColor: "transparent", boxShadow: "none" }]);
// While dragging: what makes room for the slot glides aside.
export function shift(change) {
  if (reduceMotion.matches) return change();
  const snap = snapshot();
  change();
  glide(snap);
}
// Sheets lie side by side on the lists page: after a change, each glides from where it
// was, across or down; one gone fades where it was, and one back fades in.
export function shuffle(sel, change) {
  if (reduceMotion.matches) return change();
  landAll();
  const was = rectsOf(sel);
  stopGlides();
  change();
  const now = rectsOf(sel);
  for (const [el, r] of now) {
    const o = was.get(el);
    const moved = o && (Math.abs(o.left - r.left) > 0.5 || Math.abs(o.top - r.top) > 0.5);
    if (!o) el.animate([{ opacity: 0 }, { opacity: 1 }], MOTION);
    else if (moved && el.classList.contains("placeholder")) opens(el);
    else if (moved) run(el, [{ transform: `translate(${o.left - r.left}px, ${o.top - r.top}px)` }, { transform: "none" }]);
  }
  for (const [el, o] of was) if (!now.has(el)) fade({ li: el, rect: o });
}
// A copy of the item (or the drag ghost) travels from its old place to the new one, over
// everything, and the real item shows when it lands; with no target, it fades away. On
// the way, it takes the size of the row it becomes: a ticked one is smaller.
// It only travels as far as the screen shows: a place beyond the edge is reached at the
// edge, where the item slips out of view without slowing down, so a long list doesn't
// make it rush.
export function fly(o, to, target, small = !!(target && target.closest("#" + TICKED))) {
  const ghost = o.li.classList.contains("ghost");
  const el = o.li.isConnected && !ghost ? o.li.cloneNode(true) : o.li;
  const h = o.rect.height;
  const top = Math.min(Math.max(to.top, -h - 8), innerHeight + 8), leaving = top !== to.top;
  const dx = to.left - o.rect.left, dy = top - o.rect.top;
  const ms = target ? trip(Math.hypot(dx, dy)) : MOTION.duration, easing = leaving ? LEAVE : EASE;
  if (ghost) el.classList.add("landing"); // let go after a drag
  else float(el, o.rect, "flying");
  // The lift, the landing and the change of size, in app.css, take as long as the trip.
  Object.assign(el.style, { animationDuration: ms + "ms" });
  el.style.setProperty("--trip", ms + "ms");
  el.style.setProperty("--ease", easing);
  el.classList.toggle("small", !!(o.part && o.part.id === TICKED));
  el.getBoundingClientRect(); // its size as it sets off, so the change of size shows
  el.classList.toggle("small", small);
  if (target) el.style.width = to.width + "px";
  if (target) target.style.opacity = "0";
  const move = `translate(${dx}px, ${dy}px)`;
  const a = el.animate([{ transform: "none" }, target ? { transform: move } : { transform: move + " scale(0.94)", opacity: 0 }], { duration: ms, easing, id: "fly" });
  const land = () => {
    if (!flights.delete(a)) return;
    el.remove();
    if (target) target.style.opacity = "";
  };
  flights.set(a, land);
  a.finished.then(land, () => {});
}
// Something removed fades where it was, quickly, as what follows closes the gap.
function fade(o) {
  const el = float(o.li.isConnected ? o.li.cloneNode(true) : o.li, o.rect, "fading");
  const a = el.animate([{ opacity: 1 }, { opacity: 0 }], { ...QUICK, id: "fly" });
  const gone = () => { if (flights.delete(a)) el.remove(); };
  flights.set(a, gone);
  a.finished.then(gone, () => {});
}
