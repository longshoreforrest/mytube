/* MyTube — katselusivun logiikka.
 *
 * Kolme tehtävää:
 *   1. laatuvalinta ilman että toisto hyppää alkuun,
 *   2. linkin jakaminen (WhatsApp / kopiointi),
 *   3. katselun mittaus MyPublicAnalyticsiin.
 *
 * Sivun <head> on asettanut ennen tätä:
 *   window.__MYTUBE__      = { id, kesto_s, renditiot: [{nimi, leveys, tiedosto, url}] }
 *   window.__MYPA_SITE__   = 'mytube'
 *   window.__MYPA_EXTRA__  = { video: '<id>' }   → kulkee JOKAISESSA eventissä
 * ja beacon (analytics.js) on jo inlinetty, joten window.mypa on olemassa.
 *
 * Mittaus ei saa koskaan rikkoa toistoa: jokainen kutsu menee track():n läpi,
 * joka on no-op jos beacon puuttuu.
 */
(function () {
  "use strict";

  var V = window.__MYTUBE__ || {};
  var video = document.getElementById("v");
  if (!video) return;

  function track(event, extra) {
    try {
      if (window.mypa && window.mypa.send) window.mypa.send(event, extra || {});
    } catch (e) {}
  }

  /* ---------- 1. Laatuvalinta ---------- */

  var sel = document.getElementById("qual");
  var rends = V.renditiot || [];

  // Oletuslaatu: kapea ruutu tai säästötila → pienin; muuten paras.
  function defaultRendition() {
    try {
      var c = navigator.connection;
      if (c && c.saveData) return rends[rends.length - 1];
      var w = window.innerWidth * (window.devicePixelRatio || 1);
      for (var i = rends.length - 1; i >= 0; i--) {
        if (rends[i].leveys >= w) return rends[i];
      }
    } catch (e) {}
    return rends[0];
  }

  var current = defaultRendition() || rends[0];

  function load(r, autoplay) {
    if (!r || r === current && video.currentSrc) return;
    // Toiston paikka ja tila säilytetään laadun yli — muuten vaihto tuntuisi
    // katkolta ja katsoja menettäisi kohdan johon oli päässyt.
    var t = video.currentTime;
    var playing = !video.paused && !video.ended;
    current = r;
    video.src = r.url;
    video.load();
    var restore = function () {
      video.removeEventListener("loadedmetadata", restore);
      if (t > 0.2) { try { video.currentTime = t; } catch (e) {} }
      if (playing || autoplay) video.play().catch(function () {});
    };
    video.addEventListener("loadedmetadata", restore);
  }

  if (current) {
    video.src = current.url;
    if (sel) sel.value = current.nimi;
  }

  if (sel) {
    sel.addEventListener("change", function () {
      var r = rends.filter(function (x) { return x.nimi === sel.value; })[0];
      if (!r) return;
      track("video_quality", { laatu: r.nimi, kohta_s: Math.round(video.currentTime) });
      load(r, false);
    });
  }

  /* ---------- 2. Jakaminen ---------- */

  var url = location.origin + location.pathname;
  var toast = document.getElementById("toast");
  var toastTimer = null;

  function say(msg) {
    if (!toast) return;
    toast.textContent = msg;
    toast.classList.add("on");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toast.classList.remove("on"); }, 2200);
  }

  var waBtn = document.getElementById("wa");
  if (waBtn) {
    waBtn.addEventListener("click", function () {
      track("video_share", { kanava: "whatsapp" });
      var text = (V.otsikko ? V.otsikko + "\n" : "") + url;
      window.open("https://wa.me/?text=" + encodeURIComponent(text), "_blank", "noopener");
    });
  }

  var copyBtn = document.getElementById("copy");
  if (copyBtn) {
    copyBtn.addEventListener("click", function () {
      track("video_share", { kanava: "kopio" });
      var done = function () { say("Linkki kopioitu"); };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(url).then(done, function () { prompt("Linkki:", url); });
      } else {
        prompt("Linkki:", url);
      }
    });
  }

  /* ---------- 3. Katselun mittaus ---------- */

  var seen = {};          // lähetetyt virstanpylväät (25/50/75)
  var maxPct = 0;         // pisin katsottu kohta prosentteina
  var watched = 0;        // todella toistettu aika sekunteina
  var lastTick = null;    // edellisen timeupdaten aikaleima
  var started = false;

  function duration() {
    return (video.duration && isFinite(video.duration)) ? video.duration : (V.kesto_s || 0);
  }

  video.addEventListener("play", function () {
    lastTick = Date.now();
    if (!started) {
      started = true;
      track("video_play", { laatu: current && current.nimi, kesto_s: Math.round(duration()) });
    } else {
      track("video_resume", { kohta_s: Math.round(video.currentTime) });
    }
  });

  video.addEventListener("pause", function () {
    lastTick = null;
    if (!video.ended) track("video_pause", { kohta_s: Math.round(video.currentTime) });
  });

  video.addEventListener("timeupdate", function () {
    // Toistettu aika lasketaan seinäkellosta, ei currentTimestä: kelaus
    // kasvattaisi currentTimeä ilman että kukaan katsoi mitään.
    var now = Date.now();
    if (lastTick !== null) {
      var dt = (now - lastTick) / 1000;
      if (dt > 0 && dt < 2) watched += dt;
      lastTick = now;
    }
    var d = duration();
    if (!d) return;
    var pct = Math.min(100, (video.currentTime / d) * 100);
    if (pct > maxPct) maxPct = pct;
    [25, 50, 75].forEach(function (m) {
      if (pct >= m && !seen[m]) {
        seen[m] = 1;
        track("video_progress", { pct: m });
      }
    });
  });

  video.addEventListener("ended", function () {
    lastTick = null;
    maxPct = 100;
    track("video_complete", { katsottu_s: Math.round(watched) });
  });

  // Yksi renditio voi puuttua tai olla vielä latautumatta julkaisun jälkeen.
  // Silloin ei näytetä mustaa ruutua vaan siirrytään seuraavaan laatuun.
  // Tämä on todellinen vika eikä varotoimi: ensimmäisessä julkaisussa
  // 1080p-tiedoston lataus katkesi, ja sivu jäi mykäksi vaikka 720p oli ehjä.
  var kokeillut = {};
  video.addEventListener("error", function () {
    var e = video.error;
    track("video_error", { koodi: e ? e.code : null, laatu: current && current.nimi });
    if (current) kokeillut[current.nimi] = 1;
    var vara = rends.filter(function (r) { return !kokeillut[r.nimi]; })[0];
    if (vara) {
      track("video_fallback", { mista: current && current.nimi, mihin: vara.nimi });
      if (sel) sel.value = vara.nimi;
      load(vara, false);
      return;
    }
    var p = document.querySelector(".player");
    if (p && !p.querySelector(".virhe")) {
      var d = document.createElement("div");
      d.className = "virhe";
      d.textContent = "Videota ei juuri nyt saada toistettua. Yritä hetken kuluttua uudelleen.";
      p.appendChild(d);
    }
  });

  // Yhteenveto lähtiessä. visibilitychange on ainoa tapahtuma johon puhelimen
  // selaimessa voi luottaa — 'unload' jää usein ajamatta.
  var sent = false;
  function summary() {
    if (sent || !started) return;
    sent = true;
    track("watch_end", {
      katsottu_s: Math.round(watched),
      kesto_s: Math.round(duration()),
      max_pct: Math.round(maxPct),
      laatu: current && current.nimi
    });
  }

  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "hidden") summary();
  });
  window.addEventListener("pagehide", summary);
})();
