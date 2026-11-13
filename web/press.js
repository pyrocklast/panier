// Pointers: taps that land before the page redraws; press and hold, then move, to drag;
// and a drag in progress, whatever is dragged.

import { state } from "./state.js";
import { buzz } from "./dom.js";

const LONG_PRESS_MS = 450;

// A change made while leaving a field by tapping elsewhere redraws once that tap has
// landed, so the thing you tapped is still there to receive it. With a mouse, the field
// is left as the button goes down; with a finger, only after it lifts, just before the
// tap itself.
let afterTap = [];
addEventListener("pointerdown", () => { state.pointerDown = true; }, true);
const tapEnded = () => {
  state.pointerDown = false;
  const fns = afterTap;
  afterTap = [];
  for (const f of fns) setTimeout(f, 0);
};
addEventListener("pointerup", tapEnded, true);
addEventListener("pointercancel", tapEnded, true);
export const whenTapEnds = fn => { if (state.pointerDown) afterTap.push(fn); else setTimeout(fn, 0); };

/* Press and hold, then move, to drag; with a mouse, just move. look is what lifts. */
export function bindPress(target, { look = target, can, start }) {
  let timer = null, p = null;
  const off = () => {
    clearTimeout(timer); timer = null; p = null; state.lifted = false;
    look.classList.remove("pressing", "lifted");
    removeEventListener("pointermove", move);
    removeEventListener("pointerup", off);
    removeEventListener("pointercancel", off);
  };
  const lift = () => {
    clearTimeout(timer); timer = null;
    if (!p || p.lifted) return;
    if (!can()) { state.suppressClick = true; off(); return; }
    p.lifted = true; state.lifted = true; state.suppressClick = true;
    look.classList.remove("pressing");
    look.classList.add("lifted");
    buzz(8);
  };
  const move = e => {
    if (!p) return;
    const d = Math.hypot(e.clientX - p.x, e.clientY - p.y);
    if ((p.lifted || p.mouse) && d > 6 && can()) {
      const r = look.getBoundingClientRect(), offY = p.y - r.top, offX = p.x - r.left;
      off();
      state.suppressClick = true;
      start(offY, e.clientY, offX, e.clientX);
    } else if (!p.lifted && !p.mouse && d > 8) off();
  };
  target.addEventListener("pointerdown", e => {
    if (e.button > 0 || state.editing || state.drag) return;
    state.suppressClick = false;
    p = { x: e.clientX, y: e.clientY, mouse: e.pointerType === "mouse", lifted: false };
    look.classList.add("pressing");
    timer = setTimeout(lift, LONG_PRESS_MS);
    addEventListener("pointermove", move);
    addEventListener("pointerup", off);
    addEventListener("pointercancel", off);
  });
  target.addEventListener("contextmenu", e => {
    if (e.pointerType === "mouse") return;
    e.preventDefault();
    if (p && !p.mouse && !state.editing) lift();
  });
}
// A drag in progress: the ghost follows the pointer, d.place puts the slot under it, the
// page scrolls near the edges, and d.end runs when it's let go.
export function beginDrag(d) {
  state.drag = { ...d, raf: 0 };
  addEventListener("pointermove", onDragMove);
  addEventListener("pointerup", stopDrag);
  addEventListener("pointercancel", stopDrag);
  state.drag.raf = requestAnimationFrame(dragTick);
  state.drag.place(state.drag.y, state.drag.x);
}
function stopDrag() {
  if (!state.drag) return;
  cancelAnimationFrame(state.drag.raf);
  removeEventListener("pointermove", onDragMove);
  removeEventListener("pointerup", stopDrag);
  removeEventListener("pointercancel", stopDrag);
  state.drag.end();
}
document.addEventListener("touchmove", e => { if (state.lifted || state.drag) e.preventDefault(); }, { passive: false });

function onDragMove(e) {
  if (!state.drag) return;
  state.drag.y = e.clientY;
  state.drag.x = e.clientX;
  state.drag.ghost.style.top = (e.clientY - state.drag.offY) + "px";
  if (state.drag.offX != null) state.drag.ghost.style.left = (e.clientX - state.drag.offX) + "px"; // a sheet, side by side with others
  state.drag.place(e.clientY, e.clientX);
}
function dragTick() {
  if (!state.drag) return;
  const y = state.drag.y, H = state.drag.bottom || innerHeight;
  let dy = 0;
  if (y < 64) dy = -Math.ceil((64 - y) / 6);
  else if (y > H - 64) dy = Math.ceil((y - (H - 64)) / 6);
  if (dy) { window.scrollBy(0, dy); state.drag.place(y, state.drag.x); }
  state.drag.raf = requestAnimationFrame(dragTick);
}
