(function () {
  try {
    var pref = localStorage.getItem("openbib.theme");
    var dark = pref === "dark" || ((!pref || pref === "system") && window.matchMedia("(prefers-color-scheme: dark)").matches);
    document.documentElement.dataset.theme = dark ? "dark" : "light";
  } catch {
    document.documentElement.dataset.theme = "light";
  }
})();
/* global localStorage, window, document */
