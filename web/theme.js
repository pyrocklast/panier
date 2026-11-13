// Applies what Settings chose on this phone before the page draws, so it never flashes
// another look: the theme and the compact layout, and the list's colour as last seen here
// (list.js keeps it up to date). Settings calls these again when they change.
(function () {
  var root = document.documentElement;
  var set = function (name, value) { if (value) root.setAttribute(name, value); else root.removeAttribute(name); };
  // The browser's bars match the page, whatever its colour, as plain RGB.
  var bars = function () {
    if (!document.body) return;
    var c = document.createElement("canvas").getContext("2d");
    c.fillStyle = getComputedStyle(document.body).backgroundColor;
    c.fillRect(0, 0, 1, 1);
    var d = c.getImageData(0, 0, 1, 1).data, rgb = "rgb(" + d[0] + "," + d[1] + "," + d[2] + ")";
    var metas = document.querySelectorAll('meta[name="theme-color"]');
    for (var i = 0; i < metas.length; i++) metas[i].setAttribute("content", rgb);
  };
  window.panierTheme = function (t) { set("data-theme", t === "light" || t === "dark" ? t : ""); bars(); };
  window.panierLayout = function (l) { set("data-layout", l === "compact" ? l : ""); };
  // The lists page isn't paper: it takes no list's colour, and the colour stays stored
  // for the next list opened.
  window.panierView = function (v) {
    set("data-view", v);
    if (v) root.removeAttribute("data-list");
    bars();
  };
  window.panierList = function (c) {
    try { if ((localStorage.getItem("panier-list-colour") || "") !== c) { if (c) localStorage.setItem("panier-list-colour", c); else localStorage.removeItem("panier-list-colour"); } } catch (e) {}
    if ((root.getAttribute("data-list") || "") === c) return;
    set("data-list", c);
    bars();
  };
  try {
    window.panierTheme(localStorage.getItem("panier-theme"));
    window.panierLayout(localStorage.getItem("panier-layout"));
    // The app opens on the last list used, or on the lists page when there's none.
    var index = JSON.parse(localStorage.getItem("panier2") || "null");
    if (index && index.open) set("data-list", localStorage.getItem("panier-list-colour"));
    else set("data-view", "lists");
  } catch (e) {}
  document.addEventListener("DOMContentLoaded", bars);
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", bars);
})();
