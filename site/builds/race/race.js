/* Pitwall · the race. This page's own behaviour; the engine (scrollcraft.js) is untouched.

   The signature move: page scroll is the race clock. Each shot owns a range of laps
   (data-laps="from to"); the shot under the middle of the screen, and how far through it you
   are, gives the lap. The timing tower shows the real order and gaps at that lap, from
   data/2024-sao-paulo/story.json (written by scripts/record_race.py through Pitwall's own
   timing code). Nothing here is invented: no number on this page is typed by hand in JS. */
(function () {
  "use strict";

  var DATA = "data/2024-sao-paulo/story.json";
  var HERO_CAR = 1;
  var reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  var NS = "http://www.w3.org/2000/svg";

  var story, drivers = {}, statusByLap = [];
  var shots = [].slice.call(document.querySelectorAll(".shot[data-laps]"));
  var tower = document.querySelector(".tower");
  var rowsEl = tower.querySelector(".tower__rows");
  var rows = {};
  var lapOut = document.querySelector(".gfx-lap__n");
  var towerLap = tower.querySelector(".tower__lap b");
  var statusEl = document.querySelector(".gfx-status");
  var statusText = statusEl.querySelector(".gfx-status__text");
  var lights = [].slice.call(document.querySelectorAll(".gantry__light"));
  var morphShot = document.querySelector(".shot--morph");
  var peakShots = [".shot--restart", ".shot--ocon", ".shot--pass"].map(function (s) { return document.querySelector(s); });
  var morphCars = [];
  var last = { lap: null, status: null, peak: null, on: null };

  function el(tag, attrs, parent) {
    var node = document.createElementNS(NS, tag);
    for (var k in attrs) node.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(node);
    return node;
  }
  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
  function ease(t) { return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2; }

  // ---- The circuit, from the cars' own positions -----------------------------------------
  // The outline is in the race's own coordinates (metres-ish). Fit it into 0..100, flipping y
  // (the data's y points up), and keep that transform for the cars.
  var fit;
  function makeFit(points) {
    var xs = points.map(function (p) { return p[0]; }), ys = points.map(function (p) { return p[1]; });
    var minX = Math.min.apply(0, xs), maxX = Math.max.apply(0, xs);
    var minY = Math.min.apply(0, ys), maxY = Math.max.apply(0, ys);
    var scale = 88 / Math.max(maxX - minX, maxY - minY);
    var ox = (100 - (maxX - minX) * scale) / 2, oy = (100 - (maxY - minY) * scale) / 2;
    return function (x, y) { return [ox + (x - minX) * scale, oy + (maxY - y) * scale]; };
  }
  function drawCircuit() {
    var pts = story.track.points;
    fit = makeFit(pts);
    var d = pts.map(function (p, i) { var q = fit(p[0], p[1]); return (i ? "L" : "M") + q[0].toFixed(2) + " " + q[1].toFixed(2); }).join("") + "Z";
    [].forEach.call(document.querySelectorAll(".circuit__line"), function (path) { path.setAttribute("d", d); });
  }

  // ---- The starting grid (shot 1, middle plane) -------------------------------------------
  function gridOrder() {
    return Object.keys(story.grid)
      .filter(function (car) { return story.grid[car]; })
      .sort(function (a, b) { return story.grid[a] - story.grid[b]; })
      .map(Number);
  }
  function slot(i) { return { x: 40 + (i % 2) * 190, y: 22 + Math.floor(i / 2) * 49 + (i % 2) * 24 }; }
  function drawGrid() {
    var svg = document.querySelector(".grid");
    gridOrder().forEach(function (car, i) {
      var s = slot(i), info = drivers[car];
      var g = el("g", { "class": car === HERO_CAR ? "is-hero" : "", transform: "translate(" + s.x + " " + s.y + ")" }, svg);
      el("path", { "class": "grid__slot", d: "M0 0 H120 M0 0 V18" }, g);
      el("rect", { x: 8, y: 5, width: 4, height: 14, fill: "#" + info.colour }, g);
      var code = el("text", { x: 20, y: 17 }, g); code.textContent = info.code;
      var pos = el("text", { "class": "grid__pos", x: 118, y: 17, "text-anchor": "end" }, g); pos.textContent = "P" + (i + 1);
    });
  }

  // ---- Lap one: the grid morphs into the race (shot 2) ------------------------------------
  function drawMorph() {
    var group = document.querySelector(".morph__cars");
    var after = story.laps[1].xy; // every car, as the leader starts lap 2
    gridOrder().forEach(function (car, i) {
      var to = after[String(car)];
      if (!to) return;
      var info = drivers[car], end = fit(to[0], to[1]);
      var start = [6 + (i % 2) * 7, 8 + Math.floor(i / 2) * 8.6 + (i % 2) * 4.3];
      var g = el("g", { "class": "morph__car" + (car === HERO_CAR ? " is-hero" : "") }, group);
      el("circle", { r: car === HERO_CAR ? 2.1 : 1.5, fill: "#" + info.colour }, g);
      if (car === HERO_CAR || i < 3) {
        var t = el("text", { x: 2.6, y: 1 }, g); t.textContent = info.code;
      }
      morphCars.push({ g: g, from: start, to: end });
    });
  }
  function renderMorph() {
    if (!morphCars.length) return;
    var r = morphShot.getBoundingClientRect(), vh = innerHeight;
    var p = clamp((vh - r.top) / (r.height + vh), 0, 1);
    var t = ease(clamp((p - 0.22) / 0.4, 0, 1));
    if (reduce) t = p > 0.4 ? 1 : 0;
    morphCars.forEach(function (c) {
      var x = c.from[0] + (c.to[0] - c.from[0]) * t, y = c.from[1] + (c.to[1] - c.from[1]) * t;
      c.g.setAttribute("transform", "translate(" + x.toFixed(2) + " " + y.toFixed(2) + ")");
    });
  }

  // ---- The lap chart (shot 3): every car's position, laps 1 to 27 -------------------------
  function drawLapChart() {
    var svg = document.querySelector(".lapchart__svg");
    var laps = story.laps.slice(0, 27), byCar = {};
    laps.forEach(function (lap, li) {
      lap.order.forEach(function (car, pi) { (byCar[car] = byCar[car] || []).push([li, pi]); });
    });
    var leader = story.laps[5].order[0];
    Object.keys(byCar).map(Number).sort(function (a, b) { return a === HERO_CAR ? 1 : b === HERO_CAR ? -1 : 0; }).forEach(function (car) {
      var pts = byCar[car].map(function (p) { return (p[0] / 26 * 1000).toFixed(1) + "," + (12 + p[1] / 19 * 376).toFixed(1); }).join(" ");
      el("polyline", { points: pts, stroke: "#" + drivers[car].colour, "class": car === HERO_CAR ? "is-hero" : car === leader ? "is-leader" : "" }, svg);
    });
  }

  // ---- Track status per lap, from race control's own messages ---------------------------
  function buildStatus() {
    var marks = [];
    story.events.forEach(function (e) {
      var m = (e.message || "").toUpperCase(), s = null;
      if (m.indexOf("VIRTUAL SAFETY CAR DEPLOYED") === 0) s = "vsc";
      else if (m.indexOf("VIRTUAL SAFETY CAR ENDING") === 0) s = "green";
      else if (m.indexOf("SAFETY CAR DEPLOYED") === 0) s = "sc";
      else if (m.indexOf("SAFETY CAR IN THIS LAP") === 0) s = "green+1";
      else if (m === "RED FLAG") s = "red";
      else if (m === "ROLLING START") s = "green";
      else if (m === "CHEQUERED FLAG") s = "flag";
      if (s) marks.push([e.lap, s]);
    });
    var current = "green";
    for (var lap = 0; lap <= 70; lap++) {
      marks.forEach(function (mk) {
        if (mk[1] === "green+1" ? mk[0] + 1 === lap : mk[0] === lap) current = mk[1] === "green+1" ? "green" : mk[1];
      });
      statusByLap[lap] = lap < 1 ? "pre" : current;
    }
  }
  var STATUS_TEXT = { pre: "Grid", green: "Green", vsc: "Virtual safety car", sc: "Safety car", red: "Red flag", flag: "Chequered" };

  // ---- The tower ------------------------------------------------------------------------
  function buildTower() {
    story.session.drivers.forEach(function (d) {
      var li = document.createElement("li");
      li.className = "tower__row" + (d.number === HERO_CAR ? " is-hero" : "");
      li.style.setProperty("--team", "#" + d.colour);
      li.innerHTML = '<span class="tower__pos"></span><span class="tower__team"></span><span class="tower__code"></span><span class="tower__gap"></span>';
      li.querySelector(".tower__code").textContent = d.code;
      rowsEl.appendChild(li);
      rows[d.number] = li;
    });
    tower.hidden = false;
  }
  function gapText(g, i) {
    if (i === 0) return "Leader";
    if (g === null || g === undefined) return "";
    if (typeof g === "string") return g.replace("LAPS", "laps").replace("LAP", "lap");
    return "+" + g.toFixed(3);
  }
  function setLap(lapFloat) {
    var lap = clamp(Math.floor(lapFloat + 1e-6), 0, 69);
    if (lap === last.lap) return;
    last.lap = lap;
    lapOut.textContent = lap;
    towerLap.textContent = lap;
    var entry = story.laps[clamp(lap, 1, 69) - 1];
    var seen = {};
    entry.order.forEach(function (car, i) {
      var row = rows[car];
      if (!row) return;
      seen[car] = true;
      row.style.setProperty("--i", i);
      row.classList.remove("is-out");
      row.querySelector(".tower__pos").textContent = i + 1;
      row.querySelector(".tower__gap").textContent = gapText(entry.gaps[String(car)], i);
    });
    var n = entry.order.length;
    Object.keys(rows).forEach(function (car) {
      if (seen[car]) return;
      var row = rows[car];
      row.style.setProperty("--i", n++);
      row.classList.add("is-out");
      row.querySelector(".tower__pos").textContent = "";
      row.querySelector(".tower__gap").textContent = "Out";
    });
    var status = statusByLap[lap];
    if (status !== last.status) {
      last.status = status;
      statusEl.setAttribute("data-status", status);
      statusText.textContent = STATUS_TEXT[status];
    }
  }

  // ---- The clock: which shot is under the middle of the screen, and how far through ------
  function frame() {
    var vh = innerHeight, mid = vh * 0.5, lap = -1, current = null;
    for (var i = 0; i < shots.length; i++) {
      var r = shots[i].getBoundingClientRect();
      if (r.top <= mid && r.bottom > mid) {
        var range = shots[i].getAttribute("data-laps").split(" ").map(Number);
        var local = clamp((mid - r.top) / r.height, 0, 1);
        lap = range[0] + (range[1] - range[0]) * local;
        current = shots[i];
        break;
      }
    }
    if (current === null && shots.length && shots[shots.length - 1].getBoundingClientRect().bottom <= mid) lap = 69;


    if (story) {
      var on = lap >= 0.02 && !(current && current.classList.contains("shot--handoff"));
      if (on !== last.on) { last.on = on; tower.classList.toggle("is-on", on); }
      if (lap >= 0) setLap(lap);
      else if (last.lap !== 0) { last.lap = null; setLap(0); }
      var peak = peakShots.indexOf(current) !== -1;
      if (peak !== last.peak) {
        last.peak = peak;
        tower.classList.toggle("is-unfurled", peak);
        document.body.classList.toggle("is-peak", peak);
      }
      renderMorph();
    }
  }
  // ---- The start: five lights on their own clock, as at a real start, then out -----------
  // Scroll is the race clock from lap one; the start sequence runs once, on arrival.
  function startLights() {
    if (reduce) return; // they are already out
    lights.forEach(function (light, i) {
      setTimeout(function () { light.classList.add("is-lit"); }, 700 + i * 650);
    });
    setTimeout(function () {
      lights.forEach(function (light) { light.classList.remove("is-lit"); });
      document.body.classList.add("is-lights-out");
    }, 700 + 4 * 650 + 1100);
  }
  startLights();

  var queued = false;
  function onScroll() { if (!queued) { queued = true; requestAnimationFrame(function () { queued = false; frame(); }); } }
  addEventListener("scroll", onScroll, { passive: true });
  addEventListener("resize", onScroll);

  fetch(DATA)
    .then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); })
    .then(function (data) {
      story = data;
      story.session.drivers.forEach(function (d) { drivers[d.number] = d; });
      drawCircuit();
      drawGrid();
      drawMorph();
      drawLapChart();
      buildStatus();
      buildTower();
      document.body.classList.remove("is-loading");
      frame();
    })
    .catch(function (err) {
      document.body.classList.remove("is-loading");
      tower.hidden = true;
      console.error("Race data did not load:", err);
    });
  frame();
})();
