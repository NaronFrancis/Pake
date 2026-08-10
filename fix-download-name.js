/**
 * Pake fix v2 - KeepControl
 *
 * O site monta o nome do arquivo lendo o cabecalho Content-Disposition da
 * resposta XHR (ver main.min.js: a.download = c(e.headers)). Dentro do Pake
 * esse parser devolve vazio e o WebView2 salva o arquivo como "download",
 * sem extensao.
 *
 * Este script:
 *  1. Intercepta XMLHttpRequest e captura o Content-Disposition real,
 *     tratando tambem o formato RFC 5987 (filename*=UTF-8''nome%20com%20acento).
 *  2. Quando um anchor blob:/data: e clicado sem nome valido, aplica o ultimo
 *     nome capturado.
 *  3. Registra diagnostico em window.__pakeDownloadLog para inspecao no DevTools.
 */
(function () {
  "use strict";

  var LOG = [];
  var MAX_LOG = 50;
  var recent = []; // { name, ts }
  var WINDOW_MS = 30000;

  function log(evt, data) {
    var entry = { t: new Date().toISOString(), evt: evt, data: data };
    LOG.push(entry);
    if (LOG.length > MAX_LOG) LOG.shift();
    try {
      console.log("[pake-download]", evt, data);
    } catch (e) {}
  }

  window.__pakeDownloadLog = LOG;

  var MIME_EXT = {
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
    "application/vnd.ms-excel": "xls",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
      "docx",
    "application/msword": "doc",
    "application/pdf": "pdf",
    "text/csv": "csv",
    "application/zip": "zip",
    "application/x-zip-compressed": "zip",
    "image/png": "png",
    "image/jpeg": "jpg",
  };

  var blobExt = Object.create(null);

  /** Extrai o filename de um Content-Disposition, cobrindo filename e filename*. */
  function parseDisposition(cd) {
    if (!cd) return "";
    // RFC 5987 tem prioridade: filename*=UTF-8''nome%20acentuado.xlsx
    var star = /filename\*\s*=\s*([^']*)''([^;]+)/i.exec(cd);
    if (star) {
      try {
        return decodeURIComponent(star[2].trim().replace(/^"|"$/g, ""));
      } catch (e) {}
    }
    var plain = /filename\s*=\s*("([^"]*)"|[^;]+)/i.exec(cd);
    if (plain) {
      var v = (plain[2] !== undefined ? plain[2] : plain[1]).trim();
      try {
        // alguns servidores mandam UTF-8 cru interpretado como latin1
        if (/[À-ÿ]/.test(v)) v = decodeURIComponent(escape(v));
      } catch (e) {}
      return v;
    }
    return "";
  }

  function remember(name, url) {
    if (!name) return;
    recent.push({ name: name, ts: Date.now() });
    if (recent.length > 10) recent.shift();
    log("filename-capturado", { name: name, url: url });
  }

  function lastName() {
    var now = Date.now();
    for (var i = recent.length - 1; i >= 0; i--) {
      if (now - recent[i].ts <= WINDOW_MS) return recent[i].name;
    }
    return "";
  }

  // ---- 1) Intercepta XHR para capturar o Content-Disposition real ----------
  var origOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url) {
    try {
      this.__pakeUrl = url;
    } catch (e) {}
    return origOpen.apply(this, arguments);
  };

  var origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function () {
    var xhr = this;
    try {
      xhr.addEventListener("load", function () {
        try {
          var cd = xhr.getResponseHeader("content-disposition");
          if (cd) {
            remember(parseDisposition(cd), xhr.__pakeUrl);
          } else if (/download|attachment|export/i.test(xhr.__pakeUrl || "")) {
            // diagnostico: rota de download que NAO expos o cabecalho
            log("sem-content-disposition", {
              url: xhr.__pakeUrl,
              headers: xhr.getAllResponseHeaders(),
            });
          }
        } catch (e) {
          log("erro-lendo-headers", String(e));
        }
      });
      xhr.addEventListener("error", function () {
        log("xhr-erro", { url: xhr.__pakeUrl });
      });
      xhr.addEventListener("timeout", function () {
        log("xhr-timeout", { url: xhr.__pakeUrl });
      });
    } catch (e) {}
    return origSend.apply(this, arguments);
  };

  // ---- 2) Guarda a extensao pelo MIME do Blob ------------------------------
  var origCreate = URL.createObjectURL;
  URL.createObjectURL = function (obj) {
    var url = origCreate.apply(URL, arguments);
    try {
      var type =
        obj && obj.type
          ? String(obj.type).split(";")[0].trim().toLowerCase()
          : "";
      if (type && MIME_EXT[type]) blobExt[url] = MIME_EXT[type];
    } catch (e) {}
    return url;
  };

  var origRevoke = URL.revokeObjectURL;
  URL.revokeObjectURL = function (url) {
    setTimeout(function () {
      delete blobExt[url];
    }, 60000);
    return origRevoke.apply(URL, arguments);
  };

  // ---- 3) Corrige o anchor antes do clique nativo --------------------------
  function hasExtension(n) {
    return /\.[A-Za-z0-9]{2,5}$/.test(n || "");
  }

  function stamp() {
    var d = new Date();
    var p = function (n) {
      return String(n).padStart(2, "0");
    };
    return (
      d.getFullYear() +
      p(d.getMonth() + 1) +
      p(d.getDate()) +
      "-" +
      p(d.getHours()) +
      p(d.getMinutes()) +
      p(d.getSeconds())
    );
  }

  function fixAnchor(a) {
    if (!a || !a.getAttribute) return;
    var href = a.getAttribute("href") || a.href || "";
    if (!/^(blob:|data:)/i.test(href)) return;

    var current = a.getAttribute("download") || "";
    if (
      current &&
      current !== "undefined" &&
      current !== "null" &&
      hasExtension(current)
    ) {
      log("nome-ok", current);
      return;
    }

    var name = lastName();
    if (!name || !hasExtension(name)) {
      var ext = blobExt[href] || "";
      if (!ext && /^data:/i.test(href)) {
        var m = /^data:([^;,]+)/i.exec(href);
        if (m) ext = MIME_EXT[m[1].toLowerCase()] || "";
      }
      if (!ext) ext = "bin";
      name = (name || "KeepControl-" + stamp()) + "." + ext;
    }

    a.setAttribute("download", name);
    log("nome-corrigido", { de: current || "(vazio)", para: name });
  }

  document.addEventListener(
    "click",
    function (e) {
      try {
        var a =
          e.target && e.target.closest ? e.target.closest("a[href]") : null;
        fixAnchor(a);
      } catch (err) {}
    },
    true,
  );

  var origClick = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function () {
    try {
      fixAnchor(this);
    } catch (e) {}
    return origClick.apply(this, arguments);
  };

  var origDispatch = HTMLAnchorElement.prototype.dispatchEvent;
  HTMLAnchorElement.prototype.dispatchEvent = function (evt) {
    try {
      if (evt && evt.type === "click") fixAnchor(this);
    } catch (e) {}
    return origDispatch.apply(this, arguments);
  };

  log("inject-ativo", "fix-download-name v2");
})();
