/* MyTube — ketjusivun logiikka.
 *
 * Sivu on ketju: videoita ja ajatuksia aikajärjestyksessä, uusin ensin.
 * Jokainen merkintä on oma soittimensa, ja koko ketjun voi soittaa yhtenä.
 *
 * Neljä tehtävää:
 *   1. laatuvalinta videoittain ilman että toisto hyppää alkuun,
 *   2. ääniviestin palkisto ja litteroinnin synkka,
 *   3. koko ketjun soitto ylhäältä alas,
 *   4. mittaus MyPublicAnalyticsiin.
 *
 * Sivun <head> on asettanut ennen tätä window.__MYTUBE__ = { id, otsikko,
 * osat: [...] } ja beacon on inlinetty, joten window.mypa on olemassa.
 *
 * Mittaus ei saa koskaan rikkoa toistoa: kaikki kutsut menevät track():n
 * läpi, joka on no-op jos beacon puuttuu.
 */
(function () {
  "use strict";

  var V = window.__MYTUBE__ || {};
  var OSAT = V.osat || [];

  function track(event, extra) {
    try {
      if (window.mypa && window.mypa.send) window.mypa.send(event, extra || {});
    } catch (e) {}
  }

  function mmss(s) {
    s = Math.max(0, Math.round(s || 0));
    return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
  }

  var PLAY = "M8 5v14l11-7L8 5Z";
  var PAUSE = "M7 5h4v14H7zM13 5h4v14h-4z";
  var BARS = 54;

  var osaTiedot = {};
  OSAT.forEach(function (o) { osaTiedot[o.id] = o; });

  /* ------------------------------------------------ merkinnät DOMista
   * Järjestys on DOM-järjestys, eli sama kuin mitä silmä näkee. Ketju
   * soitetaan siinä järjestyksessä — muu olisi yllättävää, kun sivu
   * vierii ylhäältä alas.
   */
  var osat = [].slice.call(document.querySelectorAll(".chain .item.ent")).map(function (el) {
    var tyyppi = el.dataset.tyyppi;
    var media = el.querySelector(tyyppi === "video" ? "video" : "audio");
    return { el: el, id: el.dataset.id, tyyppi: tyyppi, media: media, tiedot: osaTiedot[el.dataset.id] || {} };
  }).filter(function (o) { return o.media; });

  function korosta(osa) {
    osat.forEach(function (o) { o.el.classList.toggle("on", o === osa); });
  }

  function pysaytaMuut(paitsi) {
    osat.forEach(function (o) { if (o !== paitsi && !o.media.paused) o.media.pause(); });
  }

  /* ---------------------------------------------------------- 1. video */

  function teeVideo(osa) {
    var rends = (osa.tiedot.renditiot || []).slice();
    var sel = osa.el.querySelector(".qual");
    var current = null;

    // Oletuslaatu: kapea ruutu tai säästötila → pienin riittävä.
    function oletus() {
      try {
        var c = navigator.connection;
        if (c && c.saveData) return rends[rends.length - 1];
        var w = window.innerWidth * (window.devicePixelRatio || 1);
        for (var i = rends.length - 1; i >= 0; i--) if (rends[i].leveys >= w) return rends[i];
      } catch (e) {}
      return rends[0];
    }

    function lataa(r) {
      if (!r) return;
      // Toiston paikka ja tila säilytetään laadun yli — muuten vaihto
      // tuntuisi katkolta ja katsoja menettäisi kohdan johon oli päässyt.
      var t = osa.media.currentTime;
      var soi = !osa.media.paused && !osa.media.ended;
      current = r;
      osa.media.src = r.url;
      osa.media.load();
      var palauta = function () {
        osa.media.removeEventListener("loadedmetadata", palauta);
        if (t > 0.2) { try { osa.media.currentTime = t; } catch (e) {} }
        if (soi) osa.media.play().catch(function () {});
      };
      osa.media.addEventListener("loadedmetadata", palauta);
    }

    current = oletus();
    // preload="none" on HTML:ssä: src asetetaan heti, mutta mitään ei
    // ladata ennen kuin katsoja painaa toistoa. Ketjussa on useita
    // videoita, eikä niitä saa hakea verkosta kaikkia yhtä aikaa.
    if (current) osa.media.src = current.url;
    if (sel && current) sel.value = current.nimi;

    if (sel) {
      sel.addEventListener("change", function () {
        var r = rends.filter(function (x) { return x.nimi === sel.value; })[0];
        if (!r) return;
        track("video_quality", { video: osa.id, laatu: r.nimi, kohta_s: Math.round(osa.media.currentTime) });
        lataa(r);
      });
    }

    // Yksi renditio voi puuttua tai olla vielä latautumatta julkaisun
    // jälkeen — iso tiedosto nousee verkkoon hitaasti. Silloin ei näytetä
    // mustaa ruutua vaan siirrytään seuraavaan laatuun.
    var kokeillut = {};
    osa.media.addEventListener("error", function () {
      var e = osa.media.error;
      track("video_error", { video: osa.id, koodi: e ? e.code : null, laatu: current && current.nimi });
      if (current) kokeillut[current.nimi] = 1;
      var vara = rends.filter(function (r) { return !kokeillut[r.nimi]; })[0];
      if (vara) {
        track("video_fallback", { video: osa.id, mista: current && current.nimi, mihin: vara.nimi });
        if (sel) sel.value = vara.nimi;
        lataa(vara);
        return;
      }
      var p = osa.el.querySelector(".player");
      if (p && !p.querySelector(".virhe")) {
        var d = document.createElement("div");
        d.className = "virhe";
        d.textContent = "Tätä videota ei juuri nyt saada toistettua. Yritä hetken kuluttua uudelleen.";
        p.appendChild(d);
      }
    });

    /* mittaus */
    var nahty = {}, maxPct = 0, katsottu = 0, tikki = null, aloitettu = false;
    function kesto() {
      return (osa.media.duration && isFinite(osa.media.duration))
        ? osa.media.duration : (osa.tiedot.kesto_s || 0);
    }

    osa.media.addEventListener("play", function () {
      pysaytaMuut(osa);
      korosta(osa);
      tikki = Date.now();
      if (!aloitettu) {
        aloitettu = true;
        track("video_play", { video: osa.id, laatu: current && current.nimi, kesto_s: Math.round(kesto()) });
      } else {
        track("video_resume", { video: osa.id, kohta_s: Math.round(osa.media.currentTime) });
      }
    });

    osa.media.addEventListener("pause", function () {
      tikki = null;
      if (!osa.media.ended) track("video_pause", { video: osa.id, kohta_s: Math.round(osa.media.currentTime) });
    });

    osa.media.addEventListener("timeupdate", function () {
      // Katsottu aika lasketaan seinäkellosta, ei currentTimestä: kelaus
      // kasvattaisi sitä ilman että kukaan katsoi mitään.
      var now = Date.now();
      if (tikki !== null) {
        var dt = (now - tikki) / 1000;
        if (dt > 0 && dt < 2) katsottu += dt;
        tikki = now;
      }
      var d = kesto();
      if (!d) return;
      var pct = Math.min(100, (osa.media.currentTime / d) * 100);
      if (pct > maxPct) maxPct = pct;
      [25, 50, 75].forEach(function (m) {
        if (pct >= m && !nahty[m]) { nahty[m] = 1; track("video_progress", { video: osa.id, pct: m }); }
      });
    });

    osa.media.addEventListener("ended", function () {
      tikki = null;
      maxPct = 100;
      track("video_complete", { video: osa.id, katsottu_s: Math.round(katsottu) });
      jatka(osa);
    });

    osa.yhteenveto = function () {
      if (!aloitettu) return null;
      return { video: osa.id, katsottu_s: Math.round(katsottu), kesto_s: Math.round(kesto()), max_pct: Math.round(maxPct) };
    };
  }

  /* -------------------------------------------------------- 2. ajatus */

  function teeAjatus(osa) {
    var voice = osa.el.querySelector(".voice");
    var btn = voice.querySelector(".play");
    var icon = btn.querySelector("svg");
    var bars = voice.querySelector(".bars");
    var tm = voice.querySelector(".tm");
    var lines = osa.el.querySelector(".lines");
    var avaa = osa.el.querySelector(".open");

    // Palkisto on kuvitus, ei aaltomuoto — sitä ei teeskennellä analyysiksi.
    // Sen tehtävä on näyttää edistyminen ja tarjota kelauspinta.
    for (var i = 0; i < BARS; i++) {
      var b = document.createElement("i");
      b.style.height = (30 + 20 * Math.sin(i * 0.9) * Math.sin(i * 0.31)).toFixed(0) + "%";
      bars.appendChild(b);
    }

    function kesto() {
      return (osa.media.duration && isFinite(osa.media.duration))
        ? osa.media.duration : (osa.tiedot.kesto_s || 1);
    }

    btn.addEventListener("click", function () {
      if (osa.media.paused) { pysaytaMuut(osa); osa.media.play(); } else osa.media.pause();
    });

    bars.addEventListener("click", function (e) {
      var r = bars.getBoundingClientRect();
      pysaytaMuut(osa);
      osa.media.currentTime = ((e.clientX - r.left) / r.width) * kesto();
      osa.media.play();
    });

    var aloitettu = false;
    osa.media.addEventListener("play", function () {
      pysaytaMuut(osa);
      icon.innerHTML = '<path d="' + PAUSE + '"/>';
      korosta(osa);
      if (!aloitettu) { aloitettu = true; track("thought_play", { ajatus: osa.id }); }
    });
    osa.media.addEventListener("pause", function () {
      icon.innerHTML = '<path d="' + PLAY + '"/>';
    });

    osa.media.addEventListener("timeupdate", function () {
      var d = kesto(), p = osa.media.currentTime / d;
      for (var i = 0; i < bars.children.length; i++) {
        bars.children[i].classList.toggle("done", i / BARS <= p);
      }
      tm.textContent = mmss(d - osa.media.currentTime);
      var cur = -1, rivit = lines.querySelectorAll(".line");
      rivit.forEach(function (el, i) { if (osa.media.currentTime >= parseFloat(el.dataset.t)) cur = i; });
      rivit.forEach(function (el, i) { el.classList.toggle("cur", i === cur); });
    });

    osa.media.addEventListener("ended", function () {
      track("thought_complete", { ajatus: osa.id });
      jatka(osa);
    });

    // Aikaleima on lähdeviite: napautus vie ääneen siihen kohtaan.
    osa.el.querySelectorAll(".ts, .line").forEach(function (el) {
      el.addEventListener("click", function () {
        pysaytaMuut(osa);
        osa.media.currentTime = parseFloat(el.dataset.t) || 0;
        osa.media.play();
      });
    });

    avaa.addEventListener("click", function () {
      var on = lines.getAttribute("data-on") === "1";
      lines.setAttribute("data-on", on ? "0" : "1");
      avaa.textContent = (on ? "▾ Näytä" : "▴ Piilota") + " sanatarkka litterointi";
      if (!on) track("transcript_open", { ajatus: osa.id });
    });

    osa.yhteenveto = function () { return null; };
  }

  osat.forEach(function (o) { (o.tyyppi === "video" ? teeVideo : teeAjatus)(o); });

  /* ------------------------------------------------------- 3. koko ketju */

  var ketjuPaalla = false;
  var chainBtn = document.getElementById("chain");
  var chainTxt = document.getElementById("chainTxt");

  function label(on) { if (chainTxt) chainTxt.textContent = on ? "Pysäytä" : "Toista kaikki"; }

  function soita(osa) {
    osa.media.currentTime = 0;
    osa.media.play().catch(function () {});
    osa.el.scrollIntoView({ behavior: "smooth", block: "center" });
  }

  function jatka(edellinen) {
    if (!ketjuPaalla) return;
    var i = osat.indexOf(edellinen) + 1;
    if (i >= osat.length) {
      ketjuPaalla = false;
      label(false);
      korosta(null);
      track("chain_complete", {});
      return;
    }
    soita(osat[i]);
  }

  if (chainBtn) {
    chainBtn.addEventListener("click", function () {
      if (ketjuPaalla) {
        ketjuPaalla = false;
        label(false);
        pysaytaMuut(null);
        korosta(null);
        return;
      }
      if (!osat.length) return;
      ketjuPaalla = true;
      label(true);
      track("chain_play", { osia: osat.length });
      soita(osat[0]);
    });
  }

  /* ------------------------------------------------------- 4. jakaminen */

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
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(url).then(
          function () { say("Linkki kopioitu"); },
          function () { prompt("Linkki:", url); }
        );
      } else prompt("Linkki:", url);
    });
  }

  /* Yhteenveto lähtiessä. visibilitychange on ainoa tapahtuma johon
     puhelimen selaimessa voi luottaa — 'unload' jää usein ajamatta. */
  var lahetetty = false;
  function summary() {
    if (lahetetty) return;
    lahetetty = true;
    osat.forEach(function (o) {
      var y = o.yhteenveto && o.yhteenveto();
      if (y) track("watch_end", y);
    });
  }
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "hidden") summary();
  });
  window.addEventListener("pagehide", summary);
})();
