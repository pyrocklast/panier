// Applies the appearance chosen in Settings before the page draws, so it never flashes
// the other theme. Settings calls panierTheme again when it changes.
window.panierTheme = function (t) {
  var root = document.documentElement, light = "#f4f5f3", dark = "#111513";
  if (t === "light" || t === "dark") root.setAttribute("data-theme", t);
  else root.removeAttribute("data-theme");
  var metas = document.querySelectorAll('meta[name="theme-color"]');
  for (var i = 0; i < metas.length; i++) {
    var m = metas[i], forDark = (m.getAttribute("media") || "").indexOf("dark") >= 0;
    m.setAttribute("content", t === "light" ? light : t === "dark" ? dark : forDark ? dark : light);
  }
};
try { window.panierTheme(localStorage.getItem("panier-theme")); } catch (e) {}
