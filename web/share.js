// Sharing: the sheet that adds someone to a list or sets up another phone, who's on a
// list, and removing someone.

import * as store from "./store.js";
import { t, plural, q, lang } from "./i18n.js";
import { listName } from "./state.js";
import { clean, MAX_SECTION } from "./model.js";
import { $, h, announce } from "./dom.js";
import { openSheet, closeThen, confirmSheet } from "./sheets.js";

function qrSvg(textToEncode) {
  const qr = window.qrcode(0, "M");
  qr.addData(textToEncode);
  qr.make();
  const n = qr.getModuleCount(), pad = 4;
  let d = "";
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (!qr.isDark(r, c)) continue;
      let w = 1; // a run of dark squares is drawn as one
      while (c + w < n && qr.isDark(r, c + w)) w++;
      d += "M" + (c + pad) + " " + (r + pad) + "h" + w + "v1h-" + w + "z";
      c += w;
    }
  }
  const t = document.createElement("template");
  t.innerHTML = '<svg viewBox="0 0 ' + (n + 2 * pad) + " " + (n + 2 * pad) + '" shape-rendering="crispEdges" aria-hidden="true"><rect width="100%" height="100%" fill="#fff"/><path d="' + d + '" fill="#000"/></svg>';
  return t.content.firstChild;
}

// The QR code library is only needed here, so it loads the first time the sheet opens.
let qrLib = null, shared = "";
const loadQr = () => (qrLib ||= new Promise((resolve, reject) => {
  document.head.append(h("script", { src: "vendor/qrcode.js", onload: resolve, onerror: () => { qrLib = null; reject(); } }));
}));
// The sheet shares one list, with who's on it; or, all of this phone's lists at once,
// to set up another phone.
export function openPair(all = false) {
  shared = all ? store.allLink() : store.pairingLink();
  $("#pair-title").textContent = all ? t("Set up another phone") : t("Add someone to this list");
  $("#pair-text").textContent = all ? t("Scan this code with the other phone, and it has every list this one has.")
    : t("They scan this code with their phone, or open the link you send them.");
  $("#pair-note").textContent = all ? t("This link holds the keys to all your lists: anyone who has it can open them. Keep it to yourself.")
    : t("This link is the key to your list: anyone who has it can open it. Keep a copy in your password manager to recover the list if you lose your phones.");
  $("#people").hidden = all;
  if (!all) {
    $("#pair-name").hidden = !!store.myName(); // names start to matter here: asked for once, where they do
    $("#pair-name-input").value = "";
    paintPeople();
  }
  $("#qr").replaceChildren();
  $("#qr").hidden = false;
  $("#share-link").hidden = !navigator.share;
  openSheet($("#pair"));
  // Offline before the code's library ever loaded, or dozens of lists, too many for a code: the link still copies.
  loadQr().then(() => $("#qr").replaceChildren(qrSvg(shared))).catch(() => { $("#qr").hidden = true; });
}
// Who has the list: each phone writes itself onto it, with the name its owner gave in
// Settings, if any. The server sees none of it.
function paintPeople() {
  const others = store.members().filter(m => !m.me);
  const named = others.filter(m => m.name).map(m => m.name), nameless = others.length - named.length;
  const who = [t("you"), ...named];
  if (nameless) who.push(plural(nameless, "{n} phone without a name", "{n} phones without a name"));
  $("#members").textContent = others.length ? t("On this list: {x}.", { x: new Intl.ListFormat(lang, { type: "conjunction" }).format(who) }) : t("Only you, so far.");
  $("#rekey-open").hidden = !others.length; // removing someone needs someone to remove
}
$("#pair-open").addEventListener("click", () => openPair());
$("#pair-name-input").addEventListener("change", e => store.setMyName(clean(e.target.value, MAX_SECTION)));
$("#pair-name-input").addEventListener("keydown", e => { if (e.key === "Enter") e.target.blur(); });
$("#pair-close").addEventListener("click", () => $("#pair").close());
$("#share-link").addEventListener("click", () => {
  navigator.share({ title: $("#people").hidden ? "Panier" : listName(), url: shared }).catch(() => {});
});
$("#copy-link").addEventListener("click", async e => {
  const b = e.currentTarget;
  try {
    await navigator.clipboard.writeText(shared);
    b.textContent = t("Copied");
  } catch (_) {
    b.textContent = t("Couldn't copy");
  }
  setTimeout(() => { b.textContent = t("Copy link"); }, 2000);
});

// Someone shouldn't have the list any more: it moves to a new key, and the old one is
// closed, for everyone. The people who should keep it get the new link.
$("#rekey-open").addEventListener("click", () => closeThen($("#pair"), () => confirmSheet({
  title: t("Remove someone from {x}?", { x: q(listName()) }),
  text: t("The list moves to a new key. Everyone who has it now loses it, on every phone but this one, though they keep what they had. Then send the new link to those who should keep it."),
  ok: t("Give it a new key"),
  run: async () => {
    await store.changeKey();
    announce(t("{x} has a new key", { x: listName() }));
    closeThen($("#confirm"), () => openPair());
  },
})));
// Someone joined, or named themselves, while the sheet shows who's on the list.
export const peopleChanged = () => { if ($("#pair").open && !$("#people").hidden) paintPeople(); };
