(function () {
  var GLYPHS = " ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789:.-/!?+";

  function normalize(ch) {
    ch = String(ch || " ").toUpperCase();
    return GLYPHS.indexOf(ch) >= 0 ? ch : " ";
  }

  function makeFlap(ch) {
    var el = document.createElement("span");
    el.className = "flap";
    var inner = document.createElement("span");
    inner.className = "ch";
    inner.textContent = normalize(ch);
    el.appendChild(inner);
    return el;
  }

  function FlipRow(host, length, initial) {
    this.host = typeof host === "string" ? document.querySelector(host) : host;
    this.length = length;
    this.flaps = [];
    this.text = "";
    this._gen = 0;
    if (!this.host) return;
    this.host.classList.add("flap-row");
    this.host.innerHTML = "";
    var seed = (initial || "").toUpperCase();
    for (var i = 0; i < length; i++) {
      var f = makeFlap(seed[i] || " ");
      this.host.appendChild(f);
      this.flaps.push(f);
    }
    this.text = this.read();
  }

  FlipRow.prototype.read = function () {
    return this.flaps.map(function (f) {
      var n = f.querySelector(".ch");
      return n ? n.textContent : " ";
    }).join("");
  };

  FlipRow.prototype.set = function (value, animate, opts) {
    opts = opts || {};
    value = String(value == null ? "" : value).toUpperCase();
    if (value.length > this.length) value = value.slice(0, this.length);
    while (value.length < this.length) value += " ";
    var self = this;
    this._gen += 1;
    var gen = this._gen;

    this.flaps.forEach(function (flap, i) {
      var next = normalize(value.charAt(i));
      var node = flap.querySelector(".ch");
      if (!node) return;
      var cur = node.textContent || " ";

      if (animate === false) {
        node.textContent = next;
        flap.classList.remove("flip");
        return;
      }
      if (cur === next && !opts.force) return;

      var start = GLYPHS.indexOf(cur);
      if (start < 0) start = 0;
      var travel = opts.force ? (6 + (i % 7)) : 8;
      var delay = (opts.offset || 0) + i * 22;
      var stepMs = 32;

      setTimeout(function () {
        if (self._gen !== gen) return;
        var step = 0;
        function tick() {
          if (self._gen !== gen) return;
          flap.classList.add("flip");
          if (step >= travel) {
            node.textContent = next;
            setTimeout(function () {
              if (self._gen === gen) flap.classList.remove("flip");
            }, 80);
            return;
          }
          node.textContent = GLYPHS.charAt((start + step) % GLYPHS.length);
          step += 1;
          setTimeout(tick, stepMs);
        }
        tick();
      }, delay);
    });
    this.text = value;
  };

  window.FlipRow = FlipRow;
  window.FlipBoard = {
    row: function (sel, len, initial) { return new FlipRow(sel, len, initial); }
  };
})();
