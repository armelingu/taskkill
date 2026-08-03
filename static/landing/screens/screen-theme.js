// Segue o tema pedido pela landing via querystring (?theme=dark|light).
// Externo (não inline) para respeitar a CSP do app (script-src 'self').
(function () {
  var t = new URLSearchParams(location.search).get("theme");
  document.documentElement.setAttribute("data-theme", t === "dark" ? "dark" : "light");
})();
