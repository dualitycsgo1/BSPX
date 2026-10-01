(function () {
  function parse(data) {
    if (!data) return null;
    if (typeof data === "string") {
      try { data = JSON.parse(data); } catch (e) { return null; }
    }
    if (Array.isArray(data)) {
      const o = {};
      data.forEach(function (item) {
        if (item && item.field) o[item.field] = item.value;
      });
      return o;
    }
    return data;
  }

  function setNode(el, value) {
    if (!el) return;
    const v = value == null ? "" : String(value);
    if (el.tagName === "IMG") {
      if (v) el.src = v;
      el.style.visibility = v ? "visible" : "hidden";
      return;
    }
    if (el.dataset && el.dataset.bg !== undefined) {
      el.style.backgroundImage = v ? "url('" + v.replace(/'/g, "\\'") + "')" : "none";
      return;
    }
    el.textContent = v;
  }

  function apply(data) {
    const obj = parse(data);
    if (!obj) return obj;
    Object.keys(obj).forEach(function (k) {
      setNode(document.getElementById(k), obj[k]);
    });
    return obj;
  }

  function setOn(state) {
    document.querySelectorAll(".gfx").forEach(function (n) {
      n.classList.toggle("on", state);
      n.classList.toggle("off", !state);
    });
  }

  var STINGER_SRC = "assets/stinger/lz-stinger.webm";
  var STINGER_SKIP = /(^|\/)(lt-1|lt-2|lt-3|ticker|countdown)\.html$/i;
  var stingTimers = [];

  function pageName() {
    var p = (location.pathname || "").split("/").pop() || "";
    return p;
  }
  function usesStinger() {
    return !STINGER_SKIP.test(pageName());
  }
  function clearSting() {
    stingTimers.forEach(clearTimeout);
    stingTimers = [];
  }
  function later(fn, ms) {
    stingTimers.push(setTimeout(fn, ms));
  }
  function stingerEl() {
    var v = document.getElementById("lz-stinger");
    if (v) return v;
    v = document.createElement("video");
    v.id = "lz-stinger";
    v.src = STINGER_SRC;
    v.preload = "auto";
    v.playsInline = true;
    v.setAttribute("playsinline", "");
    v.muted = false;
    var host = document.querySelector(".SPXWindow") || document.body;
    host.appendChild(v);
    v.addEventListener("ended", function () {
      v.classList.remove("show");
    });
    return v;
  }
  function runStinger(hitMs, onHit, onDone) {
    clearSting();
    var v = stingerEl();
    try { v.pause(); } catch (e) {}
    v.classList.add("show");
    v.currentTime = 0;
    var p = v.play();
    if (p && p.catch) p.catch(function () {
      v.muted = true;
      v.play().catch(function () {});
    });
    later(function () { if (onHit) onHit(); }, hitMs || 800);
    later(function () {
      v.classList.remove("show");
      if (onDone) onDone();
    }, 2050);
  }

  window.play = function () {
    clearSting();
    if (!usesStinger()) {
      setOn(false);
      requestAnimationFrame(function () {
        setOn(true);
        if (typeof window.onPlay === "function") window.onPlay();
      });
      return;
    }
    setOn(false);
    runStinger(820, function () {
      setOn(true);
      if (typeof window.onPlay === "function") window.onPlay();
    });
  };

  window.stop = function () {
    clearSting();
    if (!usesStinger()) {
      if (typeof window.onStop === "function") window.onStop();
      setOn(false);
      return;
    }
    runStinger(280, function () {
      if (typeof window.onStop === "function") window.onStop();
      setOn(false);
    });
  };

  window.update = function (data) {
    const obj = apply(data);
    if (typeof window.onUpdate === "function") window.onUpdate(obj || data);
  };

  window.next = window.play;
  window.runAnimationIN = window.play;
  window.runAnimationOUT = window.stop;

  window.LZ = {
    apply: apply,
    val: function (id, fallback) {
      const el = document.getElementById(id);
      if (!el) return fallback == null ? "" : fallback;
      const t = (el.value != null && el.tagName === "INPUT") ? el.value : el.textContent;
      const s = (t || "").trim();
      return s || (fallback == null ? "" : fallback);
    },
    pad: function (n) { return String(n).padStart(2, "0"); },
    osloNow: function () {
      return new Date(new Date().toLocaleString("en-US", { timeZone: "Europe/Oslo" }));
    },
    clock: function (withSec) {
      const d = window.LZ.osloNow();
      const p = window.LZ.pad;
      return p(d.getHours()) + ":" + p(d.getMinutes()) + (withSec === false ? "" : ":" + p(d.getSeconds()));
    },
    parseCountdown: function (raw) {
      if (!raw) return 0;
      raw = String(raw).trim();
      if (/^\d{4}-\d{2}-\d{2}/.test(raw)) {
        const t = Date.parse(raw);
        return isNaN(t) ? 0 : Math.max(0, Math.floor((t - Date.now()) / 1000));
      }
      const m = raw.match(/^(\d+):(\d{2})(?::(\d{2}))?$/);
      if (m) {
        if (m[3] != null) return parseInt(m[1], 10) * 3600 + parseInt(m[2], 10) * 60 + parseInt(m[3], 10);
        return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
      }
      const n = parseInt(raw, 10);
      return isNaN(n) ? 0 : n;
    },
    fmtHMS: function (sec) {
      sec = Math.max(0, sec | 0);
      const h = Math.floor(sec / 3600);
      const m = Math.floor((sec % 3600) / 60);
      const s = sec % 60;
      const p = window.LZ.pad;
      return (h > 0 ? p(h) + ":" : "") + p(m) + ":" + p(s);
    },
    basename: function (path) {
      if (!path) return "";
      return String(path).replace(/\\/g, "/").split("/").pop();
    },
    resolveAsset: function (val, folder) {
      val = (val || "").trim();
      if (!val) return "";
      if (/^(https?:|data:)/i.test(val)) return val;
      var base = window.LZ.basename(val);
      if (!base) return val;
      folder = (folder || "assets").replace(/\/?$/, "/");
      return folder + base;
    },
    prettyName: function (path) {
      var n = window.LZ.basename(path).replace(/\.[^.]+$/, "");
      n = n.replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim();
      if (!n) return "";
      return n.replace(/\b[a-z]/g, function (c) { return c.toUpperCase(); });
    },
    setImg: function (id, src, fallback) {
      const el = document.getElementById(id);
      if (!el) return;
      const url = (src || "").trim();
      if (!url) {
        if (fallback) el.src = fallback;
        else el.removeAttribute("src");
        return;
      }
      el.onerror = function () { if (fallback) el.src = fallback; };
      el.src = url;
    }
  };
})();
