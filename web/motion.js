// Motion. Panier is paper, and each kind of motion says where something happens:
// - ink, on the page: it fades in or out where it is (a new or deleted item, the box
//   filling, the pen stroke, what others change, tinted a moment);
// - flow, along the page: it glides to its new place (rows and sections, the sheets on
//   the lists page, what makes room during a drag, a fold);
// - lift, off the page: it rises with a shadow, travels and settles back (an item or a
//   sheet held, a ticked item on its way);
// - laid on top: it rises into place over the page (the sheets, undo, the status);
// - turn, the page itself: its colour changes and the words fade through (app.js).
// Three lengths: 150 ms for feedback and what leaves, 240 ms for what arrives, 320 ms for
// what moves and for turning the page; a trip takes longer the further it goes. Three
// curves: what moves starts and ends gently, what arrives comes quickly and settles, what
// leaves starts gently and goes. app.css holds the same, as --quick, --arrive, --move
// and --ease-move, --ease-arrive, --ease-leave. Nothing moves when the phone asks for
// reduced motion.

import { $, reduceMotion } from "./dom.js";

const EASE = "cubic-bezier(0.4, 0, 0.2, 1)"; // what moves
const ARRIVE = "cubic-bezier(0.2, 0, 0, 1)"; // what arrives
const LEAVE = "cubic-bezier(0.4, 0, 1, 1)"; // what leaves, out of view at full speed
export const MOTION = { duration: 320, easing: EASE };
const ARRIVING = { duration: 240, easing: ARRIVE };
const LEAVING = { duration: 150, easing: LEAVE };
// A longer trip takes longer, but less than in proportion, as something going further
// gathers speed: about 290 ms to the next row, 480 ms across a phone's screen.
const trip = d => Math.round(200 + 12 * Math.sqrt(d));

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

// After a change, things glide to their new places. The list's sections and the ticked
// list grow or shrink to their new height, as does the palette under the list's name,
// opening like a drawer, and what follows moves along with them;
// inside each, items and the Add item row slide to their new spot; an item that changes
// place, such as one being ticked, rises off the page, flies across, taking the size of
// the row it becomes, and settles into the page there. New items fade in, and what you
// typed stays where you typed it; removed ones fade where they were. While dragging,
// what's in the way glides aside. Each element animates on its own, so taps keep working
// throughout, unlike with the browser's page-wide transitions.
const PARTS = "#app > .palette, #list > .sec, #basket-list";
const ITEMS = "#list .item[data-id], #basket-list .item[data-id]";
const ADDS = "#list > .sec > .add";
const TICKED = "basket-list"; // where rows are smaller
const flights = new Map(); // each flying copy's animation, and how it lands
const fades = new Map(); // each fading copy's, and how it goes
const glides = new Set(); // the glides under way, so a newer change takes over from them
// Anything still flying lands at once, so a change is measured as things will be; with
// all, what's fading goes too, as when another list takes the screen.
export function landAll(all = false) {
  for (const [a, land] of [...flights, ...(all ? fades : [])]) { a.cancel(); land(); }
}
const rectsOf = sel => new Map([...document.querySelectorAll(sel)].map(el => [el, el.getBoundingClientRect()]));
export function snapshot() {
  landAll(); // one change at a time
  const its = new Map();
  for (const li of document.querySelectorAll(ITEMS)) its.set(li.dataset.id, { li, rect: li.getBoundingClientRect(), part: li.closest(PARTS) });
  return { parts: rectsOf(PARTS), adds: rectsOf(ADDS), items: its };
}
const run = (el, frames, opts = MOTION) => {
  const a = el.animate(frames, { ...opts, id: "glide" });
  glides.add(a);
  a.finished.then(() => glides.delete(a), () => {});
};
const appear = el => el.animate([{ opacity: 0 }, { opacity: 1 }], { ...ARRIVING, id: "glide" });
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
    else if (!was && seen(r) && p.matches(".palette")) run(p, [{ height: "0px" }, { height: r.height + "px" }]);
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
    if (!o || !seen(o.rect)) { if (seen(n.rect) && near(n.rect) && !typed.has(n.li)) appear(n.li); }
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
// A change to the list's page that isn't the list's own, such as suggestions or a palette
// showing: what follows glides to its new place.
export function shift(change) {
  if (reduceMotion.matches) return change();
  const snap = snapshot();
  change();
  glide(snap);
}
// Things lying side by side, the sheets on the lists page, or the sections while one is
// moved: after a change, each glides from where it was, across or down; one gone fades
// where it was, and one back fades in. With fold, each is folding to its heading: what it
// held fades where it was, as the headings glide together.
export function shuffle(sel, change, { fold = false } = {}) {
  if (reduceMotion.matches) return change();
  landAll();
  const was = rectsOf(sel);
  if (fold) for (const [el, r] of was) if (r.bottom > 0 && r.top < innerHeight) fade({ li: el, rect: r });
  stopGlides();
  change();
  const now = rectsOf(sel);
  for (const [el, r] of now) {
    const o = was.get(el);
    const moved = o && (Math.abs(o.left - r.left) > 0.5 || Math.abs(o.top - r.top) > 0.5);
    if (!o) appear(el);
    else if (moved && el.classList.contains("placeholder")) opens(el);
    else if (moved) run(el, [{ transform: `translate(${o.left - r.left}px, ${o.top - r.top}px)` }, { transform: "none" }]);
  }
  for (const [el, o] of was) if (!now.has(el)) fade({ li: el, rect: o });
}
// The ticked group folding away: its height glides to nothing as its rows fade, and what
// follows moves up with it; then done hides it. Unfolding, the list's own glide opens it.
export function foldAway(el, done) {
  if (reduceMotion.matches || el.hidden) return done();
  const h = el.getBoundingClientRect().height;
  el.style.overflow = "clip";
  const a = el.animate([{ height: h + "px", opacity: 1 }, { height: "0px", opacity: 0 }], { ...MOTION, id: "glide" });
  const end = () => { el.style.overflow = ""; done(); };
  a.finished.then(end, end);
}
// Something that grows or shrinks in place, such as undo naming what it brings back: its
// width glides from what it was.
export function resize(el, change) {
  if (reduceMotion.matches) return change();
  const w = el.getBoundingClientRect().width;
  change();
  const now = el.getBoundingClientRect().width;
  if (Math.abs(now - w) > 0.5) el.animate([{ width: w + "px" }, { width: now + "px" }], { ...MOTION, id: "glide" });
}
// A new colour spreads over what it dyes: the page crossfades to it, where the browser can
// show a page's change as a whole.
let dyeing = 0;
export function dye(change) {
  if (!document.startViewTransition || reduceMotion.matches) return change();
  const root = document.documentElement;
  dyeing++;
  root.dataset.dye = "";
  document.startViewTransition(change).finished.finally(() => { if (!--dyeing) delete root.dataset.dye; });
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
// Something removed fades where it was, quickly, as what follows closes the gap. Nothing
// is measured against it, so it fades on whatever comes next.
function fade(o) {
  const el = float(o.li.isConnected ? o.li.cloneNode(true) : o.li, o.rect, "fading");
  const a = el.animate([{ opacity: 1 }, { opacity: 0 }], { ...LEAVING, id: "fly" });
  const gone = () => { if (fades.delete(a)) el.remove(); };
  fades.set(a, gone);
  a.finished.then(gone, () => {});
}
