// Applies what Settings chose on this phone before the page draws, so it never flashes
// another look: the theme, the style (cards or paper) and the compact layout. Settings
// calls these again when they change.
(function () {
  var root = document.documentElement;
  var set = function (name, value) { if (value) root.setAttribute(name, value); else root.removeAttribute(name); };
  // The browser's bars match the page: white paper, or the grey behind the cards.
  var bars = function () {
    var t = root.getAttribute("data-theme"), light = root.getAttribute("data-style") === "paper" ? "#ffffff" : "#f4f5f3", dark = "#111513";
    var metas = document.querySelectorAll('meta[name="theme-color"]');
    for (var i = 0; i < metas.length; i++) {
      var m = metas[i], forDark = (m.getAttribute("media") || "").indexOf("dark") >= 0;
      m.setAttribute("content", t === "light" ? light : t === "dark" ? dark : forDark ? dark : light);
    }
  };
  window.panierTheme = function (t) { set("data-theme", t === "light" || t === "dark" ? t : ""); bars(); };
  window.panierStyle = function (s) { set("data-style", s === "paper" ? s : ""); bars(); };
  window.panierLayout = function (l) { set("data-layout", l === "compact" ? l : ""); };
  try {
    set("data-style", localStorage.getItem("panier-style") === "paper" ? "paper" : "");
    window.panierTheme(localStorage.getItem("panier-theme"));
    window.panierLayout(localStorage.getItem("panier-layout"));
  } catch (e) {}
})();
