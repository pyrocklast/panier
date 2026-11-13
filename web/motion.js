// Motion: after a change, things glide to their new places.

import { $ } from "./dom.js";

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
// such as one being ticked, lifts, flies across and lands, taking longer the further it
// goes. New items fade in, removed ones fade out. Each element animates on its own, so
// taps keep working throughout, unlike with the browser's page-wide transitions.
const EASE = "cubic-bezier(0.4, 0, 0.2, 1)"; // gentle start, gentle landing
const LEAVE = "cubic-bezier(0.4, 0, 1, 1)"; // gentle start, then out of view at full speed
export const MOTION = { duration: 400, easing: EASE };
const PACE = 0.8; // px per ms: every trip at the same speed, however long the list
const SHORTEST = 420; // ms, so a short hop still reads as a move
const PARTS = "#list > .sec, #basket-list";
const ITEMS = "#list .item[data-id], #basket-list .item[data-id]";
const ADDS = "#list > .sec > .add";
const flights = new Map(); // each flying item's animation, and how it lands
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
export function glide(snap) {
  const seen = r => r && r.height > 0;
  // Where things are now, without the last change's motion: each glides on from where
  // the snapshot saw it.
  for (const a of glides) a.cancel();
  glides.clear();
  // Measure everything before moving anything.
  const parts = rectsOf(PARTS), adds = rectsOf(ADDS);
  const now = [...document.querySelectorAll(ITEMS)].map(li => ({ li, rect: li.getBoundingClientRect(), part: li.closest(PARTS) }));
  const head = $(".basket-head").getBoundingClientRect();
  // How far something moved within its section, leaving out the section's own movement.
  const inside = (wasRect, nowRect, part) => (wasRect.top - snap.parts.get(part).top) - (nowRect.top - parts.get(part).top);
  const run = (el, frames, opts = MOTION) => {
    const a = el.animate(frames, { ...opts, id: "glide" });
    glides.add(a);
    a.finished.then(() => glides.delete(a), () => {});
  };
  const slide = (el, dy) => { if (Math.abs(dy) > 0.5) run(el, [{ transform: `translateY(${dy}px)` }, { transform: "none" }]); };
  for (const [p, r] of parts) {
    const was = snap.parts.get(p);
    if (was && seen(r) && Math.abs(was.height - r.height) > 0.5) run(p, [{ height: was.height + "px" }, { height: r.height + "px" }]);
  }
  for (const [f, r] of adds) {
    const was = snap.adds.get(f), part = f.closest(PARTS);
    if (seen(was) && snap.parts.has(part)) slide(f, inside(was, r, part));
  }
  // Only items on screen, before or after, move: the rest are simply in their new place,
  // so a long list costs no more than a short one.
  const H = innerHeight, near = r => r.bottom > -100 && r.top < H + 100; // read once: each read can redo the layout
  const kept = new Set();
  for (const n of now) {
    const o = snap.items.get(n.li.dataset.id);
    kept.add(n.li.dataset.id);
    if (!o || !seen(o.rect)) { if (seen(n.rect) && near(n.rect)) n.li.animate([{ opacity: 0 }, { opacity: 1 }], MOTION); }
    else if (!seen(n.rect)) fly(o, head, null); // into the folded ticked group
    else if (!near(o.rect) && !near(n.rect)) continue;
    else if (o.part === n.part) slide(n.li, inside(o.rect, n.rect, n.part));
    else fly(o, n.rect, n.li);
  }
  for (const [id, o] of snap.items) if (!kept.has(id) && seen(o.rect) && near(o.rect)) fly(o, o.rect, null); // deleted
}
// A copy of the item (or the drag ghost) travels from its old place to the new one, over
// everything, and the real item shows when it lands; a deleted item's own row, gone from
// the list, travels itself. With no target, it fades away.
// It only travels as far as the screen shows: a place beyond the edge is reached at the
// edge, where the item slips out of view without slowing down, so a long list doesn't
// make it rush.
export function fly(o, to, target) {
  const el = o.li.isConnected && !o.li.classList.contains("ghost") ? o.li.cloneNode(true) : o.li;
  const h = o.rect.height;
  const top = Math.min(Math.max(to.top, -h - 8), innerHeight + 8), leaving = top !== to.top;
  const dx = to.left - o.rect.left, dy = top - o.rect.top;
  const ms = target ? Math.round(Math.max(SHORTEST, Math.hypot(dx, dy) / PACE)) : 320;
  if (el.classList.contains("ghost")) el.classList.add("landing"); // let go after a drag
  else float(el, o.rect, "flying");
  el.style.animationDuration = ms + "ms"; // the lift and landing, in app.css
  if (target) target.style.opacity = "0";
  const move = `translate(${dx}px, ${dy}px)`;
  const a = el.animate([{ transform: "none" }, target ? { transform: move } : { transform: move + " scale(0.94)", opacity: 0 }], { duration: ms, easing: leaving ? LEAVE : EASE, id: "fly" });
  const land = () => {
    if (!flights.delete(a)) return;
    el.remove();
    if (target) target.style.opacity = "";
  };
  flights.set(a, land);
  a.finished.then(land, () => {});
}
