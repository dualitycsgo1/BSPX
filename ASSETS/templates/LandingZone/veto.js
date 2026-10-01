(function () {
  var POOL = ["dust2", "anubis", "ancient", "mirage", "cache", "nuke", "inferno"];
  var ALIAS = {
    "de_dust2": "dust2", dust: "dust2", d2: "dust2",
    "de_anubis": "anubis",
    "de_ancient": "ancient",
    "de_mirage": "mirage",
    "de_cache": "cache",
    "de_nuke": "nuke",
    "de_inferno": "inferno"
  };

  function key(name) {
    var k = String(name || "").toLowerCase().trim().replace(/\s+/g, "");
    k = k.replace(/^de_/, "");
    return ALIAS[k] || k;
  }

  function label(k) {
    var map = {
      dust2: "DUST II", anubis: "ANUBIS", ancient: "ANCIENT",
      mirage: "MIRAGE", cache: "CACHE", nuke: "NUKE", inferno: "INFERNO"
    };
    return map[k] || String(k).toUpperCase();
  }

  function code(k) {
    var map = {
      dust2: "D2", anubis: "ANU", ancient: "ANC",
      mirage: "MRG", cache: "CCH", nuke: "NUK", inferno: "INF"
    };
    return map[k] || (k || "MAP").slice(0, 3).toUpperCase();
  }

  function shotUrl(k) {
    if (window.LZDB && LZDB.map(k)) return LZDB.map(k).shot;
    return "assets/maps/" + k + ".jpg";
  }
  function logoUrl(k) {
    if (window.LZDB && LZDB.map(k)) return LZDB.map(k).logo;
    return "assets/maps/" + k + "_logo.png";
  }

  function parseAction(raw) {
    raw = String(raw || "").trim();
    if (!raw) return { kind: "open", map: "", team: "" };
    var parts = raw.split(/[|,/]/).map(function (s) { return s.trim(); });
    var kind = (parts[0] || "open").toLowerCase();
    if (kind === "remain" || kind === "left") kind = "decider";
    return { kind: kind, map: key(parts[1] || ""), team: parts[2] || "" };
  }

  var BLURB = {
    dust2: "The old city streets",
    anubis: "Temple of the sun",
    ancient: "Lost jungle ruins",
    mirage: "Marketplace at noon",
    cache: "Industrial layover",
    nuke: "Atomic riviera",
    inferno: "Tuscan afternoon"
  };
  var TAGS = {
    ban: "ROUTE CLOSED",
    pick: "NOW BOOKING",
    decider: "FEATURED STAY",
    open: "STILL AVAILABLE"
  };

  function paint(rootSel, slots) {
    var root = document.querySelector(rootSel);
    if (!root) return;
    root.innerHTML = "";
    slots.forEach(function (slot, i) {
      var k = slot.map || POOL[i] || "dust2";
      var kind = slot.kind || "open";
      var col = document.createElement("div");
      col.className = "col " + kind;

      var mast = document.createElement("div");
      mast.className = "mast tone-" + k;
      mast.innerHTML = '<span class="visit">Visit</span><span class="idx">0' + (i + 1) + '  ·  OSL</span>';

      var shot = document.createElement("div");
      shot.className = "shot";
      shot.style.backgroundImage = "url('" + shotUrl(k) + "')";
      var logo = document.createElement("img");
      logo.className = "mlogo";
      logo.src = logoUrl(k);
      logo.alt = "";
      logo.onerror = function () { logo.style.display = "none"; };
      shot.appendChild(logo);
      if (kind === "ban") {
        var stamp = document.createElement("div");
        stamp.className = "stamp";
        stamp.textContent = "CANCELLED";
        shot.appendChild(stamp);
      }
      var rib = document.createElement("div");
      rib.className = "ribbon";
      rib.textContent = kind === "ban" ? "ROUTE CLOSED" : kind === "pick" ? "NOW BOOKING" : kind === "decider" ? "EDITOR'S PICK" : "AVAILABLE";
      col.appendChild(rib);

      var body = document.createElement("div");
      body.className = "body";
      body.innerHTML =
        '<div class="mname">' + label(k) + '</div>' +
        '<div class="blurb">' + (BLURB[k] || "A new destination") + '</div>' +
        '<div class="route">OSL → ' + code(k) + '  ·  LZ DESTINATIONS</div>';
      if (slot.teamLogo) {
        var row = document.createElement("div");
        row.className = "actor-row";
        var actor = document.createElement("img");
        actor.className = "actor";
        actor.src = slot.teamLogo;
        actor.alt = "";
        var lab = document.createElement("div");
        lab.className = "actor-lab";
        lab.textContent = kind === "ban" ? "Closed by carrier" : kind === "pick" ? "Booked by" : "Held for";
        row.appendChild(actor);
        row.appendChild(lab);
        body.appendChild(row);
      }

      var tag = document.createElement("div");
      tag.className = "tag";
      tag.textContent = TAGS[kind] || kind.toUpperCase();

      col.appendChild(mast);
      col.appendChild(shot);
      col.appendChild(body);
      col.appendChild(tag);
      root.appendChild(col);
    });
  }

  var timers = [];
  function later(fn, ms) { timers.push(setTimeout(fn, ms)); }
  function clearReveal() {
    timers.forEach(clearTimeout);
    timers = [];
  }

  function markChrome(state) {
    var hdr = document.querySelector(".hdr");
    var foot = document.querySelector(".foot");
    if (hdr) { hdr.classList.remove("up", "instant", "out"); if (state) hdr.classList.add(state); }
    if (foot) { foot.classList.remove("up", "instant", "out"); if (state) foot.classList.add(state); }
  }

  function hide(rootSel, duration) {
    duration = duration || 3000;
    var root = document.querySelector(rootSel);
    if (!root) return;
    var cols = [].slice.call(root.querySelectorAll(".col"));
    var n = Math.max(1, cols.length);
    clearReveal();
    markChrome("out");
    var per = Math.max(80, Math.floor((duration - 900) / n));
    cols.forEach(function (col, i) {
      later(function () {
        col.classList.remove("show", "instant");
        col.classList.add("out");
      }, 160 + i * per);
    });
  }

  function reveal(rootSel, duration) {
    duration = duration || 15000;
    var root = document.querySelector(rootSel);
    if (!root) return;
    var cols = [].slice.call(root.querySelectorAll(".col"));
    var n = Math.max(1, cols.length);
    var headerMs = 800;
    var footMs = 700;
    var per = Math.max(1500, Math.floor((duration - headerMs - footMs) / n));
    clearReveal();
    cols.forEach(function (c) { c.classList.remove("show", "marked", "instant", "out"); });
    markChrome(null);
    later(function () { markChrome("up"); }, 30);
    cols.forEach(function (col, i) {
      later(function () { col.classList.add("show"); }, headerMs + i * per);
      later(function () { col.classList.add("marked"); }, headerMs + i * per + 780);
    });
    later(function () { var f = document.querySelector(".foot"); if (f) f.classList.add("up"); }, headerMs + n * per);
  }

  function snap(rootSel) {
    clearReveal();
    var root = document.querySelector(rootSel);
    if (!root) return;
    [].slice.call(root.querySelectorAll(".col")).forEach(function (c) {
      c.classList.add("show", "marked", "instant");
    });
    markChrome("instant");
  }

  window.Veto = {
    POOL: POOL, key: key, label: label, parseAction: parseAction,
    paint: paint, reveal: reveal, snap: snap, hide: hide
  };
})();

