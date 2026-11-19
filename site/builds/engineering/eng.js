/* Pitwall · engineering. This page's own behaviour; the engine (scrollcraft.js) is untouched.

   The signature move: follow one event. In the pinned pipeline chapter the drawing draws itself
   (every stroke has pathLength=1, so one dash offset draws them all), then one real event,
   Verstappen's lap 44, travels the route; each stage it reaches lights its stamp, and each
   stamp carries that stage's measured number. */
(function () {
  "use strict";

  var reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  var chapters = [].slice.call(document.querySelectorAll(".chapter[data-chapter]"));
  var folioN = document.querySelector(".folio__n");
  var folioT = document.querySelector(".folio__t");
  var pipeline = document.querySelector(".chapter--pipeline");
  var svg = pipeline.querySelector(".drawing__svg");
  var event = svg.querySelector(".event");
  var stamped = [].slice.call(pipeline.querySelectorAll("[data-at]"));

  // The route, corner by corner: replayer (0) > trackside Redpanda > uplink (2) > link >
  // factory Redpanda > ingest (5) > ... > timing (8) > ... > pitwall-api > browser (12).
  var route = [[135, 120], [135, 300], [135, 480], [347, 480], [500, 480], [500, 300], [640, 300],
               [640, 200], [730, 200], [820, 200], [820, 300], [910, 300], [910, 500]];
  var cum = [0];
  for (var i = 1; i < route.length; i++) {
    cum.push(cum[i - 1] + Math.hypot(route[i][0] - route[i - 1][0], route[i][1] - route[i - 1][1]));
  }
  var total = cum[cum.length - 1];

  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
  function at(distance) {
    for (var k = 1; k < route.length; k++) {
      if (distance <= cum[k]) {
        var f = (distance - cum[k - 1]) / (cum[k] - cum[k - 1] || 1);
        return [route[k - 1][0] + (route[k][0] - route[k - 1][0]) * f, route[k - 1][1] + (route[k][1] - route[k - 1][1]) * f];
      }
    }
    return route[route.length - 1];
  }

  var lastChapter = null;
  function frame() {
    var vh = innerHeight;

    // The folio follows the chapter under the middle of the screen.
    for (var c = 0; c < chapters.length; c++) {
      var r = chapters[c].getBoundingClientRect();
      if (r.top <= vh * 0.5 && r.bottom > vh * 0.5) {
        var n = chapters[c].getAttribute("data-chapter");
        if (n !== lastChapter) {
          lastChapter = n;
          folioN.textContent = n;
          folioT.textContent = chapters[c].getAttribute("data-title");
          document.body.setAttribute("data-chapter", n);
        }
        break;
      }
    }

    // The drawing: progress through the pinned chapter.
    var pr = pipeline.getBoundingClientRect();
    var p = clamp(-pr.top / Math.max(1, pr.height - vh), 0, 1);
    var draw = reduce ? 1 : clamp(p / 0.22, 0, 1);
    var travel = reduce ? 1 : clamp((p - 0.24) / 0.66, 0, 1);
    svg.style.setProperty("--draw-off", (1 - draw).toFixed(4));
    var d = travel * total;
    var pos = at(d);
    event.setAttribute("transform", "translate(" + pos[0].toFixed(1) + " " + pos[1].toFixed(1) + ")");
    svg.style.setProperty("--event-o", draw >= 1 ? "1" : "0");
    stamped.forEach(function (el) {
      var index = +el.getAttribute("data-at");
      el.classList.toggle("is-reached", draw >= 1 && d >= cum[index] - 1);
    });
  }

  var queued = false;
  function onScroll() { if (!queued) { queued = true; requestAnimationFrame(function () { queued = false; frame(); }); } }
  addEventListener("scroll", onScroll, { passive: true });
  addEventListener("resize", onScroll);
  frame();
})();
