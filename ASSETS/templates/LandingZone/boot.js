/* SPX imports HTML in jsdom without loading sibling scripts.
   This stub keeps TemplateDefinition + first-paint from throwing. */
(function () {
  if (!window.LZ) {
    window.LZ = {
      val: function (id, fb) {
        var el = document.getElementById(id);
        var s = el ? String(el.textContent || el.value || "").trim() : "";
        return s || (fb == null ? "" : fb);
      },
      pad: function (n) {
        n = String(n == null ? 0 : n);
        return n.length < 2 ? "0" + n : n;
      },
      parseCountdown: function () { return 0; },
      clock: function () { return "00:00:00"; },
      fmtHMS: function () { return "00:00"; },
      setImg: function () {},
      resolveAsset: function (v) { return v || ""; },
      prettyName: function () { return ""; },
      apply: function () {}
    };
  }
  if (!window.LZDB) {
    var maps = [
      { text: "Dust II", value: "dust2" },
      { text: "Anubis", value: "anubis" },
      { text: "Ancient", value: "ancient" },
      { text: "Mirage", value: "mirage" },
      { text: "Cache", value: "cache" },
      { text: "Nuke", value: "nuke" },
      { text: "Inferno", value: "inferno" }
    ];
    var teams = [
      { text: "Metizport (MZP)", value: "metizport" },
      { text: "Acend (ACE)", value: "acend" },
      { text: "Young Ninjas (YN)", value: "youngninjas" },
      { text: "Phantom (PHT)", value: "phantom" },
      { text: "AaB (AAB)", value: "aab" },
      { text: "Lilmix (LMX)", value: "lilmix" },
      { text: "ReThink (RTK)", value: "rethink" },
      { text: "Fingers Crossed (FCX)", value: "fingerscrossed" },
      { text: "Apron Red (APR)", value: "apronred" },
      { text: "Taxiway (TAX)", value: "taxiway" }
    ];
    window.LZDB = {
      teamItems: function (game) {
        if (game === "cs2") return teams.slice(0, 8);
        if (game === "brawl") return teams.slice(8);
        return teams.slice();
      },
      playerItems: function () { return []; },
      mapItems: function () { return maps.slice(); },
      matchItems: function () { return []; },
      team: function (id) { return { id: id || "", name: id || "Team", tag: "", logo: "assets/teams/" + (id || "metizport") + ".png" }; },
      match: function () { return null; },
      map: function (id) {
        id = id || "dust2";
        return { id: id, name: id, shot: "assets/maps/" + id + ".jpg", logo: "assets/maps/" + id + "_logo.png" };
      },
      resolvePlayer: function () { return { name: "", role: "", photo: "", logo: "", teamName: "" }; },
      MATCHES: []
    };
  }
  if (!window.Veto) {
    window.Veto = { POOL: [], key: function (s) { return s || ""; }, paint: function () {} };
  }
})();
