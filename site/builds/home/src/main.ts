import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import * as THREE from "three";
import { type Car, type CarInfo, loadCar, loadCars, preload } from "./car";
import { Telemetry } from "./rev";
import { createStage } from "./stage";
import "./style.css";

gsap.registerPlugin(ScrollTrigger);

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
const hero = $<HTMLElement>(".hero");
const picker = $<HTMLDialogElement>(".picker");

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
  const box = $<HTMLElement>(".picker__seasons");
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
        picker.close();
        choose(race);
      });
      li.append(b);
      ol.append(li);
    });
    box.append(col);
  }
  $(".pick").addEventListener("click", () => {
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
  $<HTMLElement>('[data-bind="count"]').textContent = playable.length ? `${playable.length} races` : "";
  const params = new URLSearchParams(location.search);
  const latest = [...playable].sort((a, b) => b.date.localeCompare(a.date))[0];
  let race = playable.find((r) => r.id === params.get("race")) ?? playable.find((r) => r.id === "2024-sao-paulo") ?? latest;

  // Framing. Desktop: the car fills the right half, nose towards the camera's left.
  // Phone: the car takes the top half of the screen.
  const isPhone = () => window.innerWidth < 860;
  const frame = () => {
    stage.resize();
    if (isPhone()) {
      stage.camera.position.set(0, 3.2, 23);
      stage.camera.lookAt(0, -2.2, 0);
    } else {
      // Close on the front: the nose and front wheels fill the right half; the rest runs off-frame.
      stage.camera.position.set(0, 1.05, 6.4);
      stage.camera.lookAt(0.75, 0.42, 0);
    }
  };
  frame();
  window.addEventListener("resize", frame);

  // The car on stage, its telemetry, and where it is in the shot.
  let car: Car | null = null;
  let telemetry: Telemetry | null = null;
  const shot = { x: 0, yaw: 0, launch: 0, roll: 0, entry: 0 };
  const home = () => ({ x: isPhone() ? 0 : 2.85, yaw: THREE.MathUtils.degToRad(48) });
  Object.assign(shot, home());

  const hasRecording = async (id: string) => {
    try {
      return (await fetch(`data/${id}/manifest.json`, { method: "HEAD" })).ok;
    } catch {
      return false;
    }
  };

  /** Shows a race: its words at once; its car drives in once loaded (the old one drives off). */
  let turn = 0;
  const choose = async (next: Race, first = false) => {
    const mine = ++turn;
    race = next;
    const info = cars.find((c) => c.id === next.car);
    bind(next, info, await hasRecording(next.id));
    $$(".race").forEach((b) => b.setAttribute("aria-current", String(b.dataset.race === next.id)));
    if (!first) {
      history.replaceState(null, "", `?race=${next.id}`);
      window.scrollTo({ top: 0 });
    }
    telemetry = Telemetry.from(next.rev);
    if (info) preload(info);
    const leaving = car;
    const exit = leaving && !reduce ? gsap.to(shot, { entry: -16, duration: 0.75, ease: "power2.in" }) : null;
    const [arriving] = await Promise.all([loadCar(info), exit]);
    if (mine !== turn) return; // another race was chosen meanwhile
    if (leaving) stage.scene.remove(leaving.root);
    car = arriving;
    stage.scene.add(car.root);
    $<HTMLElement>(".foot__model").textContent = car.credit;
    console.info(`car: ${car.standIn ? "stand-in" : info?.id}, ${car.wheels.length} wheels`);
    // The new car rolls in from the right and brakes into place.
    if (reduce) shot.entry = 0;
    else gsap.fromTo(shot, { entry: 16 }, { entry: 0, duration: first ? 1.4 : 1.7, ease: "power3.out" });
  };

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

  // The scroll: pin the hero, then launch (squat, full revs) and roll across the page.
  if (!reduce) {
    const tl = gsap.timeline({
      scrollTrigger: { trigger: hero, start: "top top", end: "+=240%", pin: true, scrub: 0.6 },
    });
    tl.to(shot, { launch: 1, duration: 0.18, ease: "power2.in" }, 0)
      .to(".hero__copy", { xPercent: -40, opacity: 0, duration: 0.22, ease: "power2.in" }, 0.08)
      .to(".hero__ghost", { xPercent: -30, opacity: 0, duration: 0.3, ease: "power1.in" }, 0.1)
      .to(shot, { yaw: 0, duration: 0.3, ease: "power2.inOut" }, 0.18)
      .to(shot, { roll: 1, duration: 0.82, ease: "power2.in" }, 0.18)
      .to(".rev", { opacity: 0, duration: 0.1 }, 0.9);
  }

  buildPicker(playable, cars, (r) => void choose(r));
  if (race) await choose(race, true);

  const timer = new THREE.Timer();
  timer.connect(document);
  const tailWorld = new THREE.Vector3();
  const idle = { t: 0, speed: 0, throttle: 0, gear: 1, rpm: 4000 };
  let distance = 0;
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
    const base = home();

    // Which telemetry moment we are in: the grid loop, or the launch (driven by scroll).
    let sample = idle;
    if (telemetry) {
      if (shot.launch + shot.roll < 0.001) {
        const span = GRID_TO - GRID_FROM;
        sample = telemetry.at(GRID_FROM + ((t * 1000) % span));
      } else {
        sample = telemetry.at(Math.min(LAUNCH_TO, (shot.launch * 0.15 + shot.roll * 0.85) * LAUNCH_TO));
      }
    }
    const rev = THREE.MathUtils.clamp((sample.rpm - RPM_LOW) / (RPM_HIGH - RPM_LOW), 0, 1);

    // Revving: the chassis shivers on its springs, harder as the revs climb, and rocks back on
    // its suspension each time the driver blips the throttle (engine torque twisting the car).
    // The wheels stay put. Reduced motion keeps everything still; so does a car still arriving.
    const settled = 1 - Math.min(1, Math.abs(shot.entry) / 2);
    const shake = reduce ? 0 : rev * rev * (1 - shot.roll * 0.7) * settled;
    const blip = Math.max(0, (sample.rpm - lastRpm) / 900); // how hard the revs are rising
    lastRpm = sample.rpm;
    rock += (Math.min(1, blip) - rock) * 0.18;
    const torque = reduce ? 0 : rock * (1 - shot.roll) * settled;
    car.body.position.y =
      Math.sin(t * 92) * 0.011 * shake + Math.sin(t * 37) * 0.006 * shake + torque * 0.018 - shot.launch * 0.035 * (1 - shot.roll);
    car.body.rotation.x = Math.sin(t * 61) * 0.006 * shake + torque * 0.012; // rolls towards one side, as a V6 does
    car.body.rotation.z = Math.sin(t * 47) * 0.005 * shake + torque * 0.009 + shot.launch * 0.012 * (1 - shot.roll);
    // The camera feels it too, faintly, at the top of the rev range.
    const buzz = reduce ? 0 : Math.max(0, rev - 0.55) * (1 - shot.roll) * settled;
    stage.camera.position.y = (isPhone() ? 3.2 : 1.05) + Math.sin(t * 71) * 0.006 * buzz;

    // The roll: the car turns side-on and drives out to the left, faster and faster. A car
    // arriving or leaving after a pick slides along the same line (shot.entry).
    const exit = isPhone() ? -14 : -19;
    const x = base.x + (exit - base.x) * shot.roll + shot.entry;
    car.root.position.x = x;
    car.root.rotation.y = shot.launch === 0 && shot.roll === 0 ? base.yaw : shot.yaw;
    distance += Math.abs(x - lastX);
    lastX = x;
    for (const w of car.wheels) w.rotation.z = distance / 0.36;

    // Streaks, rim light and bloom follow the speed; the rim also pulses with the revs.
    const speed = Math.max(shot.roll, Math.min(1, Math.abs(shot.entry) / 10));
    for (const m of streaks.children as THREE.Mesh[]) {
      m.position.x += 0.6 + speed * 3.2;
      if (m.position.x > 22) m.position.x -= 44;
    }
    streakMats[0].opacity = speed * 0.7;
    streakMats[1].opacity = speed * 0.9;
    stage.rim.intensity = 14 + rev * 22 + speed * 40;
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
    gearOut.textContent = sample.speed < 1 && shot.roll === 0 ? "1" : String(sample.gear);
    speedOut.textContent = String(Math.round(sample.speed));
    fill.style.transform = `scaleX(${Math.min(1, sample.rpm / RPM_HIGH).toFixed(3)})`;

    stage.render();
  };
  tick();
}

main().catch((error) => console.error(error));
