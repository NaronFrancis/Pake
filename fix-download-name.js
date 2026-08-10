/**
 * Pake fix - preserva nome e extensao em downloads gerados por blob:/data:
 *
 * O KeepControl gera exportacoes via Blob. O Pake delega blob:/data: ao
 * download nativo do WebView2 (ver src-tauri/src/inject/event.js), e quando o
 * atributo `download` do anchor chega vazio o arquivo e salvo como "download",
 * sem extensao. Este script garante um nome valido antes do clique nativo,
 * deduzindo a extensao pelo MIME do proprio Blob.
 */
(function () {
  "use strict";

  var MIME_EXT = {
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
    "application/vnd.ms-excel": "xls",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
    "application/msword": "doc",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
    "application/pdf": "pdf",
    "text/csv": "csv",
    "text/plain": "txt",
    "application/json": "json",
    "application/xml": "xml",
    "text/xml": "xml",
    "application/zip": "zip",
    "application/octet-stream": "xlsx",
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/svg+xml": "svg",
  };

  // blob: URL -> extensao deduzida do MIME do Blob
  var blobExt = Object.create(null);

  var origCreateObjectURL = URL.createObjectURL;
  URL.createObjectURL = function (obj) {
    var url = origCreateObjectURL.apply(URL, arguments);
    try {
      var type = obj && obj.type ? String(obj.type).split(";")[0].trim().toLowerCase() : "";
      if (type && MIME_EXT[type]) blobExt[url] = MIME_EXT[type];
    } catch (e) {}
    return url;
  };

  // O site costuma revogar a URL logo apos o clique; o download nativo ainda
  // pode estar lendo. Mantemos o mapeamento por mais um minuto.
  var origRevokeObjectURL = URL.revokeObjectURL;
  URL.revokeObjectURL = function (url) {
    setTimeout(function () {
      delete blobExt[url];
    }, 60000);
    return origRevokeObjectURL.apply(URL, arguments);
  };

  function hasExtension(name) {
    return /\.[A-Za-z0-9]{2,5}$/.test(name || "");
  }

  function timestamp() {
    var d = new Date();
    var p = function (n) {
      return String(n).padStart(2, "0");
    };
    return (
      d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + "-" +
      p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds())
    );
  }

  function fixAnchor(anchor) {
    if (!anchor || !anchor.getAttribute) return;

    var href = anchor.getAttribute("href") || anchor.href || "";
    if (!/^(blob:|data:)/i.test(href)) return;

    var name = anchor.getAttribute("download") || "";
    if (hasExtension(name)) return; // ja tem nome bom, nao mexe

    var ext = blobExt[href] || "";

    if (!ext && /^data:/i.test(href)) {
      var m = /^data:([^;,]+)/i.exec(href);
      if (m) ext = MIME_EXT[m[1].toLowerCase()] || "";
    }

    if (!ext) ext = "xlsx"; // exportacoes do KeepControl sao XLSX

    anchor.setAttribute("download", (name || "KeepControl-" + timestamp()) + "." + ext);
  }

  // 1) Clique do usuario. Fase de captura para rodar antes do handler do Pake.
  document.addEventListener(
    "click",
    function (e) {
      try {
        var a = e.target && e.target.closest ? e.target.closest("a[href]") : null;
        fixAnchor(a);
      } catch (err) {}
    },
    true
  );

  // 2) Clique programatico - FileSaver.js, SheetJS e afins.
  var origClick = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function () {
    try {
      fixAnchor(this);
    } catch (e) {}
    return origClick.apply(this, arguments);
  };

  // 3) MouseEvent sintetico via dispatchEvent.
  var origDispatch = HTMLAnchorElement.prototype.dispatchEvent;
  HTMLAnchorElement.prototype.dispatchEvent = function (evt) {
    try {
      if (evt && evt.type === "click") fixAnchor(this);
    } catch (e) {}
    return origDispatch.apply(this, arguments);
  };
})();
