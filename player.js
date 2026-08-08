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

  /* ---------- 4. Ajatusketju ---------- */

  var PLAY = "M8 5v14l11-7L8 5Z";
  var PAUSE = "M7 5h4v14H7zM13 5h4v14h-4z";
  var BARS = 54;

  var ajatukset = [].slice.call(document.querySelectorAll(".chain .item[id^='aj-']"))
    .filter(function (el) { return el.querySelector("audio"); })
    .map(function (el) {
      return { el: el, id: el.id.replace(/^aj-/, ""), audio: el.querySelector("audio") };
    });

  function korosta(el) {
    document.querySelectorAll(".chain .item").forEach(function (x) {
      x.classList.toggle("on", x === el);
    });
  }

  ajatukset.forEach(function (a) {
    var voice = a.el.querySelector(".voice");
    var btn = voice.querySelector(".play");
    var icon = btn.querySelector("svg");
    var bars = voice.querySelector(".bars");
    var tm = voice.querySelector(".tm");
    var lines = a.el.querySelector(".lines");
    var avaa = a.el.querySelector(".open");

    // Palkisto on kuvitus, ei aaltomuoto — sitä ei teeskennellä analyysiksi.
    // Sen tehtävä on näyttää edistyminen ja tarjota kelauspinta.
    for (var i = 0; i < BARS; i++) {
      var b = document.createElement("i");
      b.style.height = (30 + 20 * Math.sin(i * 0.9) * Math.sin(i * 0.31)).toFixed(0) + "%";
      bars.appendChild(b);
    }

    function kesto() {
      return (a.audio.duration && isFinite(a.audio.duration)) ? a.audio.duration : 1;
    }

    btn.addEventListener("click", function () {
      if (a.audio.paused) { pysaytaMuut(a); a.audio.play(); } else a.audio.pause();
    });

    bars.addEventListener("click", function (e) {
      var r = bars.getBoundingClientRect();
      a.audio.currentTime = ((e.clientX - r.left) / r.width) * kesto();
      pysaytaMuut(a);
      a.audio.play();
    });

    a.audio.addEventListener("play", function () {
      icon.innerHTML = '<path d="' + PAUSE + '"/>';
      korosta(a.el);
      if (!a.aloitettu) {
        a.aloitettu = true;
        track("thought_play", { ajatus: a.id });
      }
    });
    a.audio.addEventListener("pause", function () {
      icon.innerHTML = '<path d="' + PLAY + '"/>';
    });

    a.audio.addEventListener("timeupdate", function () {
      var d = kesto(), p = a.audio.currentTime / d;
      for (var i = 0; i < bars.children.length; i++) {
        bars.children[i].classList.toggle("done", i / BARS <= p);
      }
      tm.textContent = mmss(d - a.audio.currentTime);
      var cur = -1;
      lines.querySelectorAll(".line").forEach(function (el, i) {
        if (a.audio.currentTime >= parseFloat(el.dataset.t)) cur = i;
      });
      lines.querySelectorAll(".line").forEach(function (el, i) {
        el.classList.toggle("cur", i === cur);
      });
    });

    a.audio.addEventListener("ended", function () {
      track("thought_complete", { ajatus: a.id });
      jatkaKetju(a);
    });

    // Aikaleima on lähdeviite: napautus vie ääneen siihen kohtaan.
    a.el.querySelectorAll(".ts, .line").forEach(function (el) {
      el.addEventListener("click", function () {
        pysaytaMuut(a);
        a.audio.currentTime = parseFloat(el.dataset.t) || 0;
        a.audio.play();
      });
    });

    avaa.addEventListener("click", function () {
      var on = lines.getAttribute("data-on") === "1";
      lines.setAttribute("data-on", on ? "0" : "1");
      avaa.textContent = (on ? "▾ Näytä" : "▴ Piilota") + " sanatarkka litterointi";
      if (!on) track("transcript_open", { ajatus: a.id });
    });
  });

  function mmss(s) {
    s = Math.max(0, Math.round(s || 0));
    return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
  }

  function pysaytaMuut(paitsi) {
    if (paitsi !== "video") video.pause();
    ajatukset.forEach(function (x) { if (x !== paitsi) x.audio.pause(); });
  }

  var toVideo = document.getElementById("toVideo");
  if (toVideo) {
    toVideo.addEventListener("click", function () {
      document.querySelector(".player").scrollIntoView({ behavior: "smooth", block: "center" });
      pysaytaMuut("video");
      video.play().catch(function () {});
    });
  }

  /* Koko ketju yhtenä: video, sitten ajatukset järjestyksessä. Tämä on
     ominaisuuden koko pointti — WhatsAppista tuleva kuuntelija painaa
     kerran eikä koske puhelimeen enää. */
  var ketjuPaalla = false;
  var chainBtn = document.getElementById("chain");
  var chainTxt = document.getElementById("chainTxt");

  function chainLabel(on) {
    if (chainTxt) chainTxt.textContent = on ? "Pysäytä ketju" : "Toista koko ketju";
  }

  function jatkaKetju(edellinen) {
    if (!ketjuPaalla) return;
    var i = edellinen === "video" ? 0 : ajatukset.indexOf(edellinen) + 1;
    if (i >= ajatukset.length) {
      ketjuPaalla = false;
      chainLabel(false);
      korosta(null);
      track("chain_complete", {});
      return;
    }
    var seuraava = ajatukset[i];
    seuraava.audio.currentTime = 0;
    seuraava.audio.play().catch(function () {});
    seuraava.el.scrollIntoView({ behavior: "smooth", block: "center" });
  }

  video.addEventListener("ended", function () { jatkaKetju("video"); });
  video.addEventListener("play", function () { korosta(document.getElementById("aj-video")); });

  if (chainBtn) {
    chainBtn.addEventListener("click", function () {
      if (ketjuPaalla) {
        ketjuPaalla = false;
        chainLabel(false);
        pysaytaMuut(null);
        korosta(null);
        return;
      }
      ketjuPaalla = true;
      chainLabel(true);
      track("chain_play", { osia: ajatukset.length + 1 });
      pysaytaMuut("video");
      video.currentTime = 0;
      video.play().catch(function () {});
      document.querySelector(".player").scrollIntoView({ behavior: "smooth", block: "center" });
    });
  }
})();
