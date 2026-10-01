(function () {
  var TEAMS = {
    metizport: {
      id: "metizport", name: "Metizport", tag: "MZP", game: "cs2",
      color: "#e92027", logo: "assets/teams/metizport.png",
      players: [
        { id: "jackinho", name: "Jackinho", role: "AWPer" },
        { id: "forsy", name: "forsy", role: "Rifler" },
        { id: "adamb", name: "adamb", role: "Rifler" },
        { id: "loomi", name: "L00m1", role: "Support" },
        { id: "n1xen", name: "n1xen", role: "Lurker" }
      ]
    },
    acend: {
      id: "acend", name: "Acend", tag: "ACE", game: "cs2",
      color: "#7b5cff", logo: "assets/teams/acend.png",
      players: [
        { id: "s1mon", name: "s1mon", role: "Rifler" },
        { id: "styko", name: "STYKO", role: "IGL" },
        { id: "pocco", name: "pocco", role: "AWPer" },
        { id: "nuttie", name: "nutt1e", role: "Rifler" },
        { id: "priestahh", name: "Priestahh", role: "Support" }
      ]
    },
    youngninjas: {
      id: "youngninjas", name: "Young Ninjas", tag: "YN", game: "cs2",
      color: "#f0c14b", logo: "assets/teams/youngninjas.png",
      players: [
        { id: "blue", name: "Blue", role: "Rifler" },
        { id: "jocab", name: "jocab", role: "IGL" },
        { id: "rez", name: "REZ", role: "Rifler" },
        { id: "mistem", name: "MisteM", role: "AWPer" },
        { id: "silence", name: "Silence", role: "Support" }
      ]
    },
    phantom: {
      id: "phantom", name: "Phantom", tag: "PHT", game: "cs2",
      color: "#5cffd2", logo: "assets/teams/phantom.png",
      players: [
        { id: "mhl", name: "mhL", role: "AWPer" },
        { id: "bnox", name: "bnox", role: "Rifler" },
        { id: "prism", name: "Prism", role: "IGL" },
        { id: "dgl", name: "DGL", role: "Rifler" },
        { id: "lunah", name: "lunah", role: "Support" }
      ]
    },
    aab: {
      id: "aab", name: "AaB", tag: "AAB", game: "cs2",
      color: "#e10600", logo: "assets/teams/aab.png",
      players: [
        { id: "bekker", name: "bekker", role: "Rifler" },
        { id: "maze", name: "Maze", role: "AWPer" },
        { id: "qx", name: "qx", role: "IGL" },
        { id: "mol011", name: "Mol011", role: "Rifler" },
        { id: "cabbi", name: "Cabbi", role: "Support" }
      ]
    },
    lilmix: {
      id: "lilmix", name: "Lilmix", tag: "LMX", game: "cs2",
      color: "#3ddc84", logo: "assets/teams/lilmix.png",
      players: [
        { id: "quix", name: "quix", role: "Rifler" },
        { id: "bodenmaster", name: "b0denmaster", role: "AWPer" },
        { id: "shine", name: "SHiNE", role: "IGL" },
        { id: "ztr", name: "ztr", role: "Rifler" },
        { id: "golden", name: "Golden", role: "Support" }
      ]
    },
    rethink: {
      id: "rethink", name: "ReThink", tag: "RTK", game: "cs2",
      color: "#4aa3ff", logo: "assets/teams/rethink.png",
      players: [
        { id: "hechtikal", name: "hechtikal", role: "IGL" },
        { id: "zest", name: "zest", role: "AWPer" },
        { id: "grus", name: "Grus", role: "Rifler" },
        { id: "bird", name: "bird", role: "Rifler" },
        { id: "kwezz", name: "kwezz", role: "Support" }
      ]
    },
    fingerscrossed: {
      id: "fingerscrossed", name: "Fingers Crossed", tag: "FCX", game: "cs2",
      color: "#fa7d00", logo: "assets/teams/fingerscrossed.png",
      players: [
        { id: "smogger", name: "smogger", role: "Rifler" },
        { id: "raparn", name: "raparn", role: "IGL" },
        { id: "jamppi", name: "Jamppi", role: "AWPer" },
        { id: "xkacpersky", name: "xKacpersky", role: "Rifler" },
        { id: "innocent", name: "innocent", role: "Support" }
      ]
    },
    apronred: {
      id: "apronred", name: "Apron Red", tag: "APR", game: "brawl",
      color: "#e92027", logo: "assets/teams/apronred.png",
      players: [
        { id: "ruby", name: "Ruby", role: "Brawler" },
        { id: "tarmac", name: "Tarmac", role: "Brawler" },
        { id: "flare", name: "Flare", role: "Brawler" }
      ]
    },
    taxiway: {
      id: "taxiway", name: "Taxiway", tag: "TAX", game: "brawl",
      color: "#f0c14b", logo: "assets/teams/taxiway.png",
      players: [
        { id: "hold", name: "Hold", role: "Brawler" },
        { id: "short", name: "Short", role: "Brawler" },
        { id: "pushback", name: "Pushback", role: "Brawler" }
      ]
    }
  };

  var MATCHES = [
    { time: "16:00", flight: "LZ201", a: "metizport", b: "acend", gate: "A12", status: "LIVE", map: "nuke", best: "BO3" },
    { time: "16:45", flight: "LZ202", a: "youngninjas", b: "phantom", gate: "B04", status: "BOARDING", map: "mirage", best: "BO3" },
    { time: "17:30", flight: "LZ203", a: "aab", b: "lilmix", gate: "C01", status: "GATE OPEN", map: "inferno", best: "BO1" },
    { time: "18:15", flight: "LZ204", a: "rethink", b: "fingerscrossed", gate: "D08", status: "ON TIME", map: "dust2", best: "BO3" },
    { time: "19:00", flight: "LZ300", a: "metizport", b: "youngninjas", gate: "A01", status: "ON TIME", map: "ancient", best: "BO3" },
    { time: "20:30", flight: "LZ400", a: "apronred", b: "taxiway", gate: "T2", status: "ON TIME", map: "", best: "BO3" }
  ];

  var MAPS = [
    { id: "dust2", name: "Dust II", shot: "assets/maps/dust2.jpg", logo: "assets/maps/dust2_logo.png" },
    { id: "anubis", name: "Anubis", shot: "assets/maps/anubis.jpg", logo: "assets/maps/anubis_logo.png" },
    { id: "ancient", name: "Ancient", shot: "assets/maps/ancient.jpg", logo: "assets/maps/ancient_logo.png" },
    { id: "mirage", name: "Mirage", shot: "assets/maps/mirage.jpg", logo: "assets/maps/mirage_logo.png" },
    { id: "cache", name: "Cache", shot: "assets/maps/cache.jpg", logo: "assets/maps/cache_logo.png" },
    { id: "nuke", name: "Nuke", shot: "assets/maps/nuke.jpg", logo: "assets/maps/nuke_logo.png" },
    { id: "inferno", name: "Inferno", shot: "assets/maps/inferno.jpg", logo: "assets/maps/inferno_logo.png" }
  ];

  function list(game) {
    return Object.keys(TEAMS).map(function (k) { return TEAMS[k]; })
      .filter(function (t) { return !game || t.game === game; });
  }

  function team(id) { return TEAMS[id] || null; }

  function playerPhoto(teamId, playerId) {
    return "assets/players/" + playerId + ".png";
  }

  function fakeStats(seed) {
    var n = 0;
    String(seed || "p").split("").forEach(function (c) { n = (n * 33 + c.charCodeAt(0)) >>> 0; });
    function mix(a, b) { n = (n * 1664525 + 1013904223) >>> 0; return a + (n % ((b - a) * 10)) / 10; }
    return {
      rating: mix(0.92, 1.28).toFixed(2),
      adr: Math.round(mix(68, 98)),
      kd: mix(0.88, 1.45).toFixed(2),
      hs: Math.round(mix(28, 52)),
      maps: Math.round(mix(48, 210)),
      kast: Math.round(mix(68, 82))
    };
  }

  function player(teamId, playerId) {
    var t = team(teamId);
    if (!t) return null;
    var i, p;
    if (playerId && playerId.indexOf("|") >= 0) {
      var parts = playerId.split("|");
      teamId = parts[0]; playerId = parts[1];
      t = team(teamId) || t;
    }
    for (i = 0; i < t.players.length; i++) {
      if (t.players[i].id === playerId) {
        p = t.players[i];
        break;
      }
    }
    if (!p) p = t.players[0];
    var st = p.stats || fakeStats(p.id + t.id);
    return {
      id: p.id, name: p.name, role: p.role,
      teamId: t.id, teamName: t.name, tag: t.tag,
      photo: playerPhoto(t.id, p.id),
      logo: t.logo, color: t.color,
      rating: st.rating, adr: st.adr, kd: st.kd, hs: st.hs, maps: st.maps, kast: st.kast
    };
  }

  function resolvePlayer(teamId, raw) {
    var pid = raw || "";
    if (pid.indexOf("|") >= 0) {
      var parts = pid.split("|");
      if (parts[0] && parts[0] !== teamId) {
        return player(teamId, "");
      }
      return player(parts[0], parts[1]);
    }
    return player(teamId, pid);
  }

  function teamItems(game) {
    return list(game).map(function (t) {
      return { text: t.name + "  (" + t.tag + ")", value: t.id };
    });
  }

  function playerItems(game) {
    var items = [];
    list(game).forEach(function (t) {
      t.players.forEach(function (p) {
        items.push({ text: t.tag + "  ·  " + p.name, value: t.id + "|" + p.id });
      });
    });
    return items;
  }

  function mapItems() {
    return MAPS.map(function (m) { return { text: m.name, value: m.id }; });
  }

  function map(id) {
    var i;
    for (i = 0; i < MAPS.length; i++) if (MAPS[i].id === id) return MAPS[i];
    return MAPS[0];
  }

  function matchItems() {
    return MATCHES.map(function (m, i) {
      var a = team(m.a); var b = team(m.b);
      return {
        text: m.time + "  " + (a ? a.tag : m.a) + " vs " + (b ? b.tag : m.b),
        value: String(i)
      };
    });
  }

  window.LZDB = {
    TEAMS: TEAMS,
    MATCHES: MATCHES,
    MAPS: MAPS,
    list: list,
    team: team,
    player: player,
    resolvePlayer: resolvePlayer,
    teamItems: teamItems,
    playerItems: playerItems,
    mapItems: mapItems,
    map: map,
    matchItems: matchItems,
    match: function (i) { return MATCHES[parseInt(i, 10)] || MATCHES[0]; }
  };
})();
