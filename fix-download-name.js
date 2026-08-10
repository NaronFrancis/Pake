/**
 * Pake fix v3 - KeepControl
 *
 * DIAGNOSTICO (confirmado via DevTools):
 *   O WebView2 recusa a leitura do cabecalho Content-Disposition
 *   ("Refused to get unsafe header"). O site faz:
 *
 *       a.download = c(e.headers)   // c() -> e("content-disposition").split(";")
 *
 *   Recebendo null, o .split lanca TypeError. A excecao quebra a cadeia de
 *   promises, o site nunca limpa a flag de requisicao em andamento, o modal
 *   "Carregando anexo..." fica preso e a tentativa seguinte e recusada com
 *   {"status":-191,"message":"Request already in progress."}.
 *   Quando o arquivo chega, a.download esta vazio e vira "download" sem extensao.
 *
 * CORRECAO:
 *   Fabricamos um Content-Disposition sintetico quando o real e inacessivel,
 *   derivando o nome do proprio caminho da URL e a extensao do Content-Type
 *   (que E legivel, por estar na lista segura do CORS). Assim o parser do site
 *   recebe string valida, nao lanca, o modal fecha e o arquivo sai nomeado.
 */
(function () {
  "use strict";

  var LOG = [];
  window.__pakeDownloadLog = LOG;

  function log(evt, data) {
    LOG.push({ t: new Date().toISOString(), evt: evt, data: data });
    if (LOG.length > 80) LOG.shift();
    try {
      console.log("[pake-download]", evt, data);
    } catch (e) {}
  }

  var MIME_EXT = {
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
    "application/vnd.ms-excel": "xls",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
    "application/msword": "doc",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
    "application/pdf": "pdf",
    "application/zip": "zip",
    "application/x-zip-compressed": "zip",
    "text/csv": "csv",
    "text/plain": "txt",
    "application/xml": "xml",
    "text/xml": "xml",
    "application/json": "json",
    "image/png": "png",
    "image/jpeg": "jpg",
  };

  function stamp() {
    var d = new Date();
    var p = function (n) {
      return String(n).padStart(2, "0");
    };
    return (
      d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + "-" +
      p(d.getHours()) + p(d.getMinutes())
    );
  }

  function contentType(xhr) {
    try {
      // content-type e CORS-safelisted, sempre legivel
      return (xhr.getResponseHeader("content-type") || "").split(";")[0].trim().toLowerCase();
    } catch (e) {
      return "";
    }
  }

  /** A resposta parece um arquivo binario para download? */
  function isFileResponse(xhr) {
    try {
      if (xhr.status !== 200) return false;
      var rt = xhr.responseType;
      if (rt !== "arraybuffer" && rt !== "blob") return false;
      var r = xhr.response;
      var size = r ? (r.byteLength !== undefined ? r.byteLength : r.size) : 0;
      return size > 0;
    } catch (e) {
      return false;
    }
  }

  // Segmentos genericos que nao servem como nome de arquivo
  var SKIP = /^(api|v\d+|list|download|downloadhash|downloadbatchhash|hash|attachment|attachments|file|files|export|view|print|get)$/i;

  function deriveName(url, ctype) {
    var path = String(url || "").split("?")[0].split("#")[0];
    var segs = path.split("/").filter(Boolean);

    var pick = "";
    for (var i = segs.length - 1; i >= 0; i--) {
      if (!SKIP.test(segs[i])) {
        pick = segs[i];
        break;
      }
    }
    if (!pick) pick = "KeepControl";

    pick = pick.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");

    var ext = MIME_EXT[ctype] || "";
    if (!ext) ext = ctype === "application/octet-stream" ? "bin" : "bin";

    if (new RegExp("\\." + ext + "$", "i").test(pick)) return pick;
    return pick + "-" + stamp() + "." + ext;
  }

  function synthName(xhr) {
    if (!xhr.__pakeSynthName) {
      xhr.__pakeSynthName = deriveName(xhr.__pakeUrl, contentType(xhr));
      log("nome-sintetizado", { url: xhr.__pakeUrl, nome: xhr.__pakeSynthName });
    }
    return xhr.__pakeSynthName;
  }

  // ---- registra a URL de cada XHR -----------------------------------------
  var origOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url) {
    try {
      this.__pakeUrl = url;
    } catch (e) {}
    return origOpen.apply(this, arguments);
  };

  // ---- getAllResponseHeaders: usado pelo $http do AngularJS ---------------
  var origGetAll = XMLHttpRequest.prototype.getAllResponseHeaders;
  XMLHttpRequest.prototype.getAllResponseHeaders = function () {
    var raw = "";
    try {
      raw = origGetAll.apply(this, arguments) || "";
    } catch (e) {}

    try {
      if (!/^content-disposition\s*:/im.test(raw) && isFileResponse(this)) {
        if (raw && !/\r\n$/.test(raw)) raw += "\r\n";
        raw += 'content-disposition: attachment; filename="' + synthName(this) + '"\r\n';
      }
    } catch (e) {}

    return raw;
  };

  // ---- getResponseHeader: evita o "Refused to get unsafe header" ----------
  var origGetHeader = XMLHttpRequest.prototype.getResponseHeader;
  XMLHttpRequest.prototype.getResponseHeader = function (name) {
    var lower = String(name || "").toLowerCase();

    if (lower === "content-disposition") {
      var real = null;
      try {
        real = origGetHeader.apply(this, arguments);
      } catch (e) {}
      if (real) return real;
      try {
        if (isFileResponse(this)) {
          return 'attachment; filename="' + synthName(this) + '"';
        }
      } catch (e) {}
      return null;
    }

    return origGetHeader.apply(this, arguments);
  };

  // ---- rede de seguranca no anchor ----------------------------------------
  function hasExt(n) {
    return /\.[A-Za-z0-9]{2,5}$/.test(n || "");
  }

  function fixAnchor(a) {
    if (!a || !a.getAttribute) return;
    var href = a.getAttribute("href") || a.href || "";
    if (!/^(blob:|data:)/i.test(href)) return;

    var cur = a.getAttribute("download") || "";
    if (cur && cur !== "undefined" && cur !== "null" && hasExt(cur)) return;

    var name = "KeepControl-" + stamp() + ".bin";
    a.setAttribute("download", name);
    log("anchor-corrigido", { de: cur || "(vazio)", para: name });
  }

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

  var origClick = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function () {
    try {
      fixAnchor(this);
    } catch (e) {}
    return origClick.apply(this, arguments);
  };

  log("inject-ativo", "fix-download-name v3");
})();
