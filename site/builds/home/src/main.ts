import gsap from "gsap";
import { ScrollToPlugin } from "gsap/ScrollToPlugin";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import * as THREE from "three";
import { type Car, type CarInfo, loadCar, loadCars, preload, silhouette } from "./car";
import { Telemetry } from "./rev";
import { tyreSmoke } from "./smoke";
import { createStage } from "./stage";
import { cssVars, THEMES, type Theme, themeFor } from "./theme";
import "./style.css";

gsap.registerPlugin(ScrollTrigger, ScrollToPlugin);

/** A race in public/races.json (written by scripts/race_catalogue.py from OpenF1). */
interface Race {
  id: string;
  year: number;
  date: string;
  name: string;
  circuit: string;
  country: string;
  laps: number | null;
  winner: { number: number; code: string; first: string; last: string; team: string; colour: string };
  car: string | null;
  grid: number | null;
  margin_s: number | null;
  best_lap_s: number | null;
  pit_stops: number;
  rev: number[][];
}

const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const $ = <T extends Element>(s: string) => document.querySelector(s) as T;
const $$ = (s: string) => Array.from(document.querySelectorAll<HTMLElement>(s));
const rpmOut = $<HTMLElement>(".rev__n");
const gearOut = $<HTMLElement>(".rev__g");
const speedOut = $<HTMLElement>(".rev__s");
const fill = $<HTMLElement>(".rev__fill");
const card = $<HTMLElement>(".card");
const cue = $<HTMLElement>(".cue__in");
const CHOICE_KEY = "pitwall.choice"; // shared with the pit wall: the race it opens on
const hero = $<HTMLElement>(".hero");
const picker = $<HTMLDialogElement>(".picker");
const wash = $<HTMLElement>(".wash");
const washWord = $<HTMLElement>(".wash__word");

const RPM_LOW = 4000;
const RPM_HIGH = 12500;
// The grid: the real revs while the driver waits for the lights, looped (ms before lights out).
const GRID_FROM = -3900;
const GRID_TO = -150;
// The launch: lights out to 9 s, played by scroll.
const LAUNCH_TO = 9000;

// ---- Words ---------------------------------------------------------------------------------

const ORDINALS = ["", "first", "second", "third", "fourth", "fifth", "sixth", "seventh", "eighth", "ninth", "tenth",
  "eleventh", "twelfth", "thirteenth", "fourteenth", "fifteenth", "sixteenth", "seventeenth", "eighteenth", "nineteenth", "twentieth"];
const lapTime = (s: number) => `${Math.floor(s / 60)}:${(s % 60).toFixed(3).padStart(6, "0")}`;
function story(race: Race): string {
  const from = race.grid === 1 ? "Won from pole" : race.grid ? `Won from ${ORDINALS[race.grid] ?? `P${race.grid}`} on the grid` : "Won";
  return race.margin_s != null ? `${from}, ${race.margin_s.toFixed(3)} s clear.` : `${from}.`;
}

function bind(race: Race, info: CarInfo | undefined, hasRecording: boolean) {
  const w = race.winner;
  const set = (key: string, text: string, html = false) =>
    $$(`[data-bind="${key}"]`).forEach((el) => (html ? (el.innerHTML = text) : (el.textContent = text)));
  set("kicker", `${race.year} ${race.name} · ${race.circuit}`);
  set("first", w.first);
  set("last", w.last);
  // Size the surname to its length, so VERSTAPPEN fits the left half as well as ALBON does.
  document.documentElement.style.setProperty("--name-chars", String(Math.max(5, w.last.length)));
  set("sub", story(race));
  set("ghost", info?.name ?? w.code);
  set("number", String(w.number));
  set("teamcar", `${w.team}${info ? ` · ${info.name}` : ""}`);
  set("grid", race.grid ? String(race.grid) : "–");
  set("margin", race.margin_s != null ? `${race.margin_s.toFixed(3)}<small>s</small>` : "–", true);
  set("best", race.best_lap_s ? lapTime(race.best_lap_s) : "–");
  set("pits", String(race.pit_stops));
  set("revsrc", race.rev.length ? `Car ${w.number}, real telemetry: the grid, then the launch.` : `Car ${w.number}. No launch telemetry for this race.`);
  const href = hasRecording ? `pitwall/?race=${race.id}&driver=${w.number}` : "pitwall/";
  $$('[data-bind-href="pitwall"]').forEach((a) => a.setAttribute("href", href));
  set("note", hasRecording ? "" : "This race's pit-wall replay is still being recorded; the pit wall opens on the race that is ready.");
  document.title = `Pitwall · ${w.first} ${w.last}, ${race.year} ${race.name}`;
  document.documentElement.style.setProperty("--team", `#${w.colour || "e10600"}`);
}

// ---- The picker ------------------------------------------------------------------------------

function buildPicker(races: Race[], cars: CarInfo[], choose: (race: Race) => void) {
  const seasons = new Map<number, Race[]>();
  for (const r of [...races].sort((a, b) => a.date.localeCompare(b.date))) {
    if (!seasons.has(r.year)) seasons.set(r.year, []);
    seasons.get(r.year)!.push(r);
  }
  // The same catalogue twice: on the page in the lobby, and in the picker once a race is chosen.
  for (const box of $$(".seasons")) {
  box.style.setProperty("--seasons", String(seasons.size));
  box.replaceChildren();
  for (const [year, list] of seasons) {
    const col = document.createElement("section");
    col.className = "season";
    col.innerHTML = `<h3 class="season__year">${year}<small>${list.length} races</small></h3><ol class="season__list"></ol>`;
    const ol = col.querySelector("ol")!;
    list.forEach((race, i) => {
      const info = cars.find((c) => c.id === race.car);
      const li = document.createElement("li");
      const b = document.createElement("button");
      b.type = "button";
      b.className = "race";
      b.dataset.race = race.id;
      b.style.setProperty("--team", `#${race.winner.colour || "888"}`);
      b.innerHTML = `<span class="race__round">${String(i + 1).padStart(2, "0")}</span>
        <span class="race__name"></span><span class="race__winner"></span>`;
      b.querySelector(".race__name")!.innerHTML = `${race.name.replace(/ Grand Prix$/, "")}<small></small>`;
      b.querySelector(".race__name small")!.textContent = `${race.circuit} · ${race.date}`;
      b.querySelector(".race__winner")!.innerHTML = `${race.winner.code}<span class="race__car"></span>`;
      b.querySelector(".race__car")!.textContent = info?.name ?? "";
      b.addEventListener("click", () => {
        if (picker.open) picker.close();
        choose(race);
      });
      li.append(b);
      ol.append(li);
    });
    box.append(col);
  }
  }
  for (const pick of $$(".pick")) pick.addEventListener("click", () => {
    picker.showModal();
    picker.querySelector<HTMLElement>('.race[aria-current="true"]')?.scrollIntoView({ block: "center" });
  });
  $(".picker__close").addEventListener("click", () => picker.close());
  picker.addEventListener("click", (e) => e.target === picker && picker.close()); // the backdrop
}

// ---- The page --------------------------------------------------------------------------------

async function main() {
  const stage = createStage($<HTMLCanvasElement>(".stage"));
  const [cars, races] = await Promise.all([
    loadCars(),
    fetch("races.json").then((r) => (r.ok ? r.json() : { races: [] })).then((d) => d.races as Race[]),
  ]);
  const playable = races.filter((r) => r.car);
  $$('[data-bind="count"]').forEach((el) => (el.textContent = playable.length ? `${playable.length} races` : ""));
  const years = playable.map((r) => r.year);
  if (years.length) $$('[data-bind="span"]').forEach((el) => (el.textContent = `${Math.min(...years)} – ${Math.max(...years)}`));
  const latest = [...playable].sort((a, b) => b.date.localeCompare(a.date))[0];
  // The race in the address (?race=...), or none: the page opens on every race, not one.
  const fromUrl = () => playable.find((r) => r.id === new URLSearchParams(location.search).get("race")) ?? null;
  let race: Race | null = fromUrl();
  // Before a race is chosen, the newest car stands in shadow.
  const lobbyCar = cars.find((c) => c.id === latest?.car);

  // Framing. Desktop: the car fills the right half, nose towards the camera's left.
  // Phone: the car takes the top half of the screen.
  const isPhone = () => window.innerWidth < 860;
  // How far the camera stands off: close enough that the car fills the frame. It pulls back as
  // the car turns side-on, just enough to keep the whole car in shot (a phone is narrow, so more).
  const DESK_Z = 5.6;
  const DESK_DOLLY = 3.1;
  const PHONE_Z = 20;
  const PHONE_DOLLY = 6.5;
  const frame = () => {
    stage.resize();
    if (isPhone()) {
      stage.camera.position.set(0, 3.2, PHONE_Z);
      stage.camera.lookAt(0, -2.2, 0);
    } else {
      // Close on the front: the nose and front wheels fill the right half; the rest runs off-frame.
      stage.camera.position.set(0, 1.05, DESK_Z);
      stage.camera.lookAt(0.75, 0.42, 0);
    }
  };
  frame();
  window.addEventListener("resize", frame);

  // The car on stage, its telemetry, and where it is in the shot.
  let car: Car | null = null;
  let telemetry: Telemetry | null = null;
  // The launch, in phases the scroll plays: rev (blips on the grid), turn and creep (side-on,
  // into the middle, the camera pulling back), burn (the burnout), launch (the squat) and roll
  // (away across the page). Each runs 0 to 1.
  const shot = { x: 0, yaw: 0, launch: 0, roll: 0, entry: 0, rev: 0, turn: 0, creep: 0, burn: 0 };
  const home = () => ({ x: isPhone() ? 0 : 2.85, yaw: THREE.MathUtils.degToRad(48) });
  Object.assign(shot, home());

  const hasRecording = async (id: string) => {
    try {
      return (await fetch(`data/${id}/manifest.json`, { method: "HEAD" })).ok;
    } catch {
      return false;
    }
  };

  // ---- The team grade -----------------------------------------------------------------
  let theme: Theme | null = null;
  const applyTheme = (t: Theme) => {
    for (const [name, value] of Object.entries(cssVars(t))) document.documentElement.style.setProperty(name, value);
    stage.setAccent(t.glow, t.rim);
    streakMats[1].color.setHex(t.streak).multiplyScalar(1.5);
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", t.deep);
    theme = t;
  };
  /** The wash: the new team's colour blooms out from the car over everything; at full cover the
   * grade changes underneath; then it fades, the team's name in script going with it. */
  let washing: gsap.core.Timeline | null = null;
  const washTo = (t: Theme, swap: () => void) => {
    const at = isPhone() ? ["50%", "26%"] : ["72%", "55%"];
    const light = `color-mix(in srgb, ${t.accent} 70%, white)`;
    for (const [k, v] of Object.entries({ "--wx": at[0], "--wy": at[1], "--wash-a": light, "--wash-b": t.accent, "--wash-c": t.deep, "--wash-ink": t.onAccent })) {
      wash.style.setProperty(k, v);
    }
    washWord.textContent = t.label;
    // A pick made while a wash is still running replaces it: only the latest choice lands.
    washing?.kill();
    washing = gsap
      .timeline()
      .set(wash, { visibility: "visible", opacity: 1, clipPath: `circle(0% at ${at[0]} ${at[1]})` })
      .fromTo(washWord, { scale: 0.8, opacity: 0, xPercent: 6 }, { scale: 1, opacity: 1, xPercent: 0, duration: 0.7, ease: "power3.out" }, 0.1)
      .to(wash, { clipPath: `circle(150% at ${at[0]} ${at[1]})`, duration: 0.65, ease: "power3.in" }, 0)
      .fromTo(wash, { "--wash-shift": "0%" }, { "--wash-shift": "-12%", duration: 1.6, ease: "none" }, 0)
      .add(() => {
        applyTheme(t);
        swap();
      }, 0.68)
      .to(washWord, { scale: 1.08, opacity: 0, duration: 0.5, ease: "power2.in" }, 1.05)
      .to(wash, { opacity: 0, duration: 0.6, ease: "power2.out" }, 1.15)
      .set(wash, { visibility: "hidden" });
    return washing;
  };

  /** Changes the page's grade, and its words under cover of the wash when the team changes. */
  const regrade = (t: Theme, swap: () => void, instant: boolean) => {
    if (instant || reduce || !theme) {
      applyTheme(t);
      swap();
    } else if (t !== theme) washTo(t, swap);
    else swap();
  };

  /** The page's two states: every race (the lobby), or one race (its winner, and the launch). */
  const setMode = (mode: "lobby" | "race") => {
    window.scrollTo({ top: 0 });
    if (document.body.dataset.mode === mode) return;
    document.body.dataset.mode = mode;
    if (mode === "race") enableLaunch();
    else disableLaunch();
    ScrollTrigger.refresh();
  };

  /** The old car drives off to the left; the new one rolls in from the right and brakes. */
  let turn = 0;
  const bringCar = async (info: CarInfo | undefined, dark: boolean, mine: number, first: boolean) => {
    if (info) preload(info);
    const leaving = car;
    const exit = leaving && !reduce ? gsap.to(shot, { entry: -16, duration: 0.75, ease: "power2.in" }) : null;
    gsap.killTweensOf(cue);
    gsap.to(cue, { opacity: 0, duration: 0.25 });
    const [arriving] = await Promise.all([loadCar(info), exit]);
    if (mine !== turn) return; // something else was chosen meanwhile
    if (leaving) stage.scene.remove(leaving.root);
    // The cue to scroll comes up as the winner's car brakes into place.
    if (!dark) gsap.fromTo(cue, { opacity: 0, y: 12 }, { opacity: 1, y: 0, duration: 0.7, ease: "power3.out", delay: reduce ? 0 : first ? 0.9 : 1.2 });
    car = dark ? silhouette(arriving) : arriving;
    stage.scene.add(car.root);
    $<HTMLElement>(".foot__model").textContent = car.credit;
    if (reduce) shot.entry = 0;
    else gsap.fromTo(shot, { entry: 16 }, { entry: 0, duration: first ? 1.4 : 1.7, ease: "power3.out" });
  };

  /** Shows a race: the page becomes its winner's, and the pit wall will open on it. */
  const choose = async (next: Race, first = false, push = true) => {
    const mine = ++turn;
    race = next;
    const info = cars.find((c) => c.id === next.car);
    const recorded = await hasRecording(next.id);
    if (mine !== turn) return;
    if (push && !first) history.pushState(null, "", `?race=${next.id}`);
    if (recorded) {
      try {
        localStorage.setItem(CHOICE_KEY, JSON.stringify({ race: next.id, driver: next.winner.number }));
      } catch {
        /* private mode: the pit wall just won't remember it */
      }
    }
    telemetry = Telemetry.from(next.rev);
    regrade(
      themeFor(next.winner.team),
      () => {
        bind(next, info, recorded);
        setMode("race");
      },
      first,
    );
    $$(".race").forEach((b) => b.setAttribute("aria-current", String(b.dataset.race === next.id)));
    await bringCar(info, false, mine, first);
  };

  /** The race chosen last time, offered again in the lobby. */
  const showResume = () => {
    const box = $<HTMLElement>(".resume");
    let saved: Race | undefined;
    try {
      const id = JSON.parse(localStorage.getItem(CHOICE_KEY) ?? "null")?.race;
      saved = playable.find((r) => r.id === id);
    } catch {
      saved = undefined;
    }
    box.hidden = !saved;
    if (!saved) return;
    const b = box.querySelector("button")!;
    b.textContent = `${saved.year} ${saved.name.replace(/ Grand Prix$/, "")} · ${saved.winner.code}`;
    b.onclick = () => void choose(saved);
  };

  /** Back to every race: the grade goes neutral and the newest car returns in shadow. */
  const toLobby = async (first = false, push = true) => {
    const mine = ++turn;
    race = null;
    telemetry = null;
    if (push && !first) history.pushState(null, "", location.pathname);
    regrade(
      THEMES.neutral,
      () => {
        setMode("lobby");
        $$('[data-bind="ghost"]').forEach((el) => (el.textContent = String(playable.length || "")));
        $$('[data-bind-href="pitwall"]').forEach((a) => a.setAttribute("href", "pitwall/"));
        document.title = "Pitwall · Every winner, every race";
        showResume();
      },
      first,
    );
    $$(".race").forEach((b) => b.setAttribute("aria-current", "false"));
    await bringCar(lobbyCar, true, mine, first);
  };

  // Home, the PITWALL mark and "All races" return to the lobby in place; so does the back button.
  for (const a of $$('.back, .bar__mark, .bar__tabs a[href="./"]')) {
    a.addEventListener("click", (e) => {
      e.preventDefault();
      if (race) void toLobby();
      else window.scrollTo({ top: 0, behavior: reduce ? "auto" : "smooth" });
    });
  }
  window.addEventListener("popstate", () => {
    const r = fromUrl();
    if (r) void choose(r, false, false);
    else void toLobby(false, false);
  });

  // Speed streaks: thin light bars that stream past as the car goes, red and white.
  // Each streak fades in from its tail to a bright head, so it reads as light smeared by speed.
  const taper = (() => {
    const c = document.createElement("canvas");
    c.width = 256;
    c.height = 1;
    const g = c.getContext("2d")!;
    const grad = g.createLinearGradient(0, 0, 256, 0);
    grad.addColorStop(0, "#000");
    grad.addColorStop(0.75, "#fff");
    grad.addColorStop(1, "#000");
    g.fillStyle = grad;
    g.fillRect(0, 0, 256, 1);
    return new THREE.CanvasTexture(c);
  })();
  const streaks = new THREE.Group();
  const streakMats = [0xffffff, 0xff2a14].map(
    (c) =>
      new THREE.MeshBasicMaterial({
        color: new THREE.Color(c).multiplyScalar(1.5),
        alphaMap: taper,
        transparent: true,
        opacity: 0,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
  );
  for (let i = 0; i < 34; i++) {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(3 + Math.random() * 7, 0.012 + Math.random() * 0.02), streakMats[i % 3 === 0 ? 1 : 0]);
    // Low and behind the car: light trailing past it, never glare across the bodywork.
    m.position.set((Math.random() - 0.5) * 44, 0.04 + Math.pow(Math.random(), 1.8) * 1.6, -3.2 + Math.random() * 1.9);
    streaks.add(m);
  }
  stage.scene.add(streaks);

  // The scroll, once a race is chosen: pin the hero, then launch (squat, full revs) and roll
  // across the page. The lobby has no launch; its page simply scrolls on to the catalogue.
  let launch: gsap.core.Timeline | null = null;
  function enableLaunch() {
    if (reduce || launch) return;
    launch = gsap.timeline({
      scrollTrigger: {
        trigger: hero,
        start: "top top",
        end: "+=300%",
        pin: true,
        scrub: 0.6,
        // A nudge is enough: the first bit of scroll either way plays the whole launch (or its
        // return) by itself, as if the page were pulled along by the car.
        onUpdate: (self) => {
          if (auto) return;
          if (self.direction > 0 && self.progress > 0.002 && self.progress < 0.97) carry(self.end, 1);
          else if (self.direction < 0 && self.progress < 0.998 && self.progress > 0.03) carry(self.start, -1);
        },
      },
    });
    launch
      .to(".cue", { opacity: 0, y: 20, duration: 0.05, ease: "power1.in" }, 0)
      .to(".hero__copy--race", { xPercent: -40, opacity: 0, duration: 0.14, ease: "power2.in" }, 0.02)
      .to(".hero__ghost", { xPercent: -30, opacity: 0, duration: 0.2, ease: "power1.in" }, 0.03)
      // A few hard revs where it stands.
      .to(shot, { rev: 1, duration: 0.12, ease: "power1.in" }, 0)
      // Side-on, into the middle; the camera pulls back to take in the whole car.
      .to(shot, { turn: 1, duration: 0.14, ease: "power2.inOut" }, 0.12)
      .to(shot, { creep: 1, duration: 0.15, ease: "power2.inOut" }, 0.12)
      // The burnout: brakes on, rear wheels lit up, smoke.
      .to(shot, { burn: 1, duration: 0.04, ease: "power2.out" }, 0.26)
      .to(shot, { burn: 0, duration: 0.04, ease: "power1.in" }, 0.46)
      // Brakes off: the squat, and away.
      .to(shot, { launch: 1, duration: 0.06, ease: "power2.in" }, 0.46)
      .to(shot, { roll: 1, duration: 0.52, ease: "power2.in" }, 0.48)
      .to(".rev", { opacity: 0, duration: 0.06, ease: "none" }, 0.93);
  }
  // The carry: the page scrolls itself through the launch. While it runs, the wheel, touch and
  // keys are held so they can't fight it; it takes about as long as a real launch to the first
  // corner, slower back.
  let auto: gsap.core.Tween | null = null;
  const hold = (e: Event) => {
    if (auto) e.preventDefault();
  };
  window.addEventListener("wheel", hold, { passive: false });
  window.addEventListener("touchmove", hold, { passive: false });
  window.addEventListener("keydown", (e) => {
    if (auto && ["ArrowDown", "ArrowUp", "PageDown", "PageUp", " ", "Home", "End"].includes(e.key)) e.preventDefault();
  });
  function carry(to: number, direction: 1 | -1) {
    auto = gsap.to(window, {
      scrollTo: { y: to, autoKill: false },
      // Forward at a steady rate, so each phase gets its share: about half a second of revs, half
      // a second turning in, under a second of burnout, two seconds away.
      duration: direction > 0 ? 3.9 : 2.2,
      ease: direction > 0 ? "none" : "power2.inOut",
      onComplete: () => {
        // Let the scrub settle before listening again, so the tail of the carry isn't read as a new nudge.
        gsap.delayedCall(0.7, () => (auto = null));
      },
    });
  }
  $(".cue").addEventListener("click", () => {
    if (launch?.scrollTrigger && !auto) carry(launch.scrollTrigger.end, 1);
    else if (reduce) card.scrollIntoView({ behavior: "auto" });
  });

  function disableLaunch() {
    if (!launch) return;
    launch.scrollTrigger?.kill(true);
    launch.progress(0).kill();
    launch = null;
    Object.assign(shot, { launch: 0, roll: 0, rev: 0, turn: 0, creep: 0, burn: 0 }, home());
    auto?.kill();
    auto = null;
    gsap.set([".hero__copy--race", ".hero__ghost", ".rev", ".cue"], { clearProps: "transform,opacity" });
  }

  buildPicker(playable, cars, (r) => void choose(r));
  if (race) await choose(race, true);
  else await toLobby(true);

  const timer = new THREE.Timer();
  timer.connect(document);
  const tailWorld = new THREE.Vector3();
  const idle = { t: 0, speed: 0, throttle: 0, gear: 1, rpm: 4000 };
  let distance = 0;
  let spin = 0;
  let gridClock = 0;
  const smoke = tyreSmoke(stage.scene);
  let lastRpm = 0;
  let rock = 0;
  let lastX = 0;
  let visible = true;
  new IntersectionObserver(([e]) => (visible = e.isIntersecting)).observe(hero);

  const tick = () => {
    requestAnimationFrame(tick);
    if (!visible || !car) return;
    timer.update();
    const t = timer.getElapsed();
    const dt = Math.min(timer.getDelta(), 0.05);
    const base = home();

    // Which telemetry moment we are in: the grid loop, or the launch (driven by scroll). Revving
    // and the burnout play the driver's real grid revs, faster: the numbers stay real.
    gridClock += dt * 1000 * (1 + shot.rev * 0.7 + shot.burn * 0.8);
    let sample = idle;
    if (telemetry) {
      if (shot.launch + shot.roll < 0.001) {
        const span = GRID_TO - GRID_FROM;
        sample = telemetry.at(GRID_FROM + (gridClock % span));
      } else {
        sample = telemetry.at(Math.min(LAUNCH_TO, (shot.launch * 0.15 + shot.roll * 0.85) * LAUNCH_TO));
      }
    }
    const rev = THREE.MathUtils.clamp((sample.rpm - RPM_LOW) / (RPM_HIGH - RPM_LOW), 0, 1);

    // Revving: the chassis shivers on its springs, harder as the revs climb, and rocks back on
    // its suspension each time the driver blips the throttle (engine torque twisting the car).
    // The wheels stay put. Reduced motion keeps everything still; so does a car still arriving.
    const settled = 1 - Math.min(1, Math.abs(shot.entry) / 2);
    const shake = reduce ? 0 : Math.min(1.6, rev * rev * (1 + shot.rev * 0.5 + shot.burn * 1.2)) * (1 - shot.roll * 0.7) * settled;
    const blip = Math.max(0, (sample.rpm - lastRpm) / 900); // how hard the revs are rising
    lastRpm = sample.rpm;
    rock += (Math.min(1, blip) - rock) * 0.18;
    const torque = reduce ? 0 : rock * (1 - shot.roll) * settled;
    car.body.position.y =
      Math.sin(t * 92) * 0.011 * shake + Math.sin(t * 37) * 0.006 * shake + torque * 0.018 - shot.launch * 0.035 * (1 - shot.roll);
    car.body.rotation.x = Math.sin(t * 61) * 0.006 * shake + torque * 0.012; // rolls towards one side, as a V6 does
    // The burnout sits the car down on its rear tyres; the launch squats it further.
    car.body.rotation.z =
      Math.sin(t * 47) * 0.005 * shake + torque * 0.009 + (shot.launch * 0.012 + shot.burn * 0.008) * (1 - shot.roll);
    // The camera feels it too, faintly, at the top of the rev range, more in the burnout. It pulls
    // back as the car turns side-on, so the whole car and its smoke are in frame.
    const buzz = reduce ? 0 : (Math.max(0, rev - 0.55) + shot.burn * 0.6) * (1 - shot.roll) * settled;
    stage.camera.position.y = (isPhone() ? 3.2 : 1.05) + Math.sin(t * 71) * 0.006 * buzz;
    stage.camera.position.z = isPhone() ? PHONE_Z + shot.creep * PHONE_DOLLY : DESK_Z + shot.creep * DESK_DOLLY;

    // The roll: the car turns side-on and drives out to the left, faster and faster. A car
    // arriving or leaving after a pick slides along the same line (shot.entry).
    const exit = isPhone() ? -14 : -19;
    const start = base.x + ((isPhone() ? -0.3 : 0.75) - base.x) * shot.creep;
    const x = start + (exit - start) * shot.roll + shot.entry;
    car.root.position.x = x;
    // In the lobby the car in shadow turns a little, slowly, so the light runs along its bodywork.
    // In the burnout the rear steps out and back, the car fighting its own wheelspin.
    const sway = race || reduce ? 0 : Math.sin(t * 0.35) * 0.12;
    const fishtail = (Math.sin(t * 7.3) * 0.035 + Math.sin(t * 13.1) * 0.012) * shot.burn;
    car.root.rotation.y = (base.yaw + sway) * (1 - shot.turn) + fishtail;
    distance += Math.abs(x - lastX);
    lastX = x;
    // Wheelspin: the rear wheels turn far faster than the car moves, in the burnout and off the line.
    const offTheLine = shot.launch * Math.max(0, 1 - shot.roll / 0.12);
    spin += dt * (shot.burn * 62 + offTheLine * 40);
    for (const w of car.wheels) w.rotation.z = distance / 0.36 + (w.name.startsWith("wheel_R") ? spin : 0);

    // Tyre smoke from the rear contact patches while they spin.
    const smoking = reduce ? 0 : Math.max(shot.burn, offTheLine * 0.8);
    smoke.emit(smoking, dt, car.wheels.filter((w) => w.name.startsWith("wheel_R")));
    smoke.update(dt);

    // Streaks, rim light and bloom follow the speed; the rim also pulses with the revs.
    const speed = Math.max(shot.roll, Math.min(1, Math.abs(shot.entry) / 10));
    for (const m of streaks.children as THREE.Mesh[]) {
      m.position.x += 0.6 + speed * 3.2;
      if (m.position.x > 22) m.position.x -= 44;
    }
    streakMats[0].opacity = speed * 0.7;
    streakMats[1].opacity = speed * 0.9;
    stage.rim.intensity = 14 + rev * 22 + speed * 40 + shot.burn * 18;
    stage.bloom.strength = 0.28 + rev * 0.12 + speed * 0.45;
    stage.camera.position.x = isPhone() ? 0 : -shot.roll * 1.2;

    // The card is uncovered behind the car: its left edge follows the car's tail on screen.
    if (!reduce) {
      tailWorld.set(x + 2.9, 0.5, 0).project(stage.camera);
      const tailPct = ((tailWorld.x + 1) / 2) * 100;
      const reveal = shot.roll > 0.02 ? THREE.MathUtils.clamp(tailPct, 0, 100) : 100;
      card.style.setProperty("--reveal", `${reveal.toFixed(2)}%`);
    }

    // The readout.
    rpmOut.textContent = Math.round(sample.rpm).toLocaleString("en-GB");
    gearOut.textContent = shot.roll === 0 ? "1" : String(sample.gear);
    speedOut.textContent = String(Math.round(sample.speed));
    fill.style.transform = `scaleX(${Math.min(1, sample.rpm / RPM_HIGH).toFixed(3)})`;

    stage.render();
  };
  tick();
}

main().catch((error) => console.error(error));
