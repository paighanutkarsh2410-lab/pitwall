import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import * as THREE from "three";
import { loadCar } from "./car";
import { Telemetry } from "./rev";
import { createStage } from "./stage";
import "./style.css";

gsap.registerPlugin(ScrollTrigger);

const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const $ = <T extends Element>(s: string) => document.querySelector(s) as T;
const rpmOut = $<HTMLElement>(".rev__n");
const gearOut = $<HTMLElement>(".rev__g");
const speedOut = $<HTMLElement>(".rev__s");
const fill = $<HTMLElement>(".rev__fill");
const card = $<HTMLElement>(".card");
const hero = $<HTMLElement>(".hero");

const RPM_LOW = 4000;
const RPM_HIGH = 12000;
// The grid: the real revs while he waits for the lights, looped (ms before lights out).
const GRID_FROM = -3900;
const GRID_TO = -150;
// The launch: lights out to 9 s, played by scroll.
const LAUNCH_TO = 9000;

async function main() {
  const stage = createStage($<HTMLCanvasElement>(".stage"));
  const [car, telemetry] = await Promise.all([loadCar(), Telemetry.load()]);
  stage.scene.add(car.root);
  if (car.credit) $<HTMLElement>(".foot__model").textContent = car.credit;
  console.info(`car: ${car.standIn ? "stand-in" : "RB19"}, ${car.wheels.length} wheels`);

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
      stage.camera.position.set(0, 1.15, 8.2);
      stage.camera.lookAt(0.4, 0.45, 0);
    }
  };
  frame();
  window.addEventListener("resize", frame);

  // Where the car is in the shot, as the scroll moves it.
  const shot = { x: 0, yaw: 0, launch: 0, roll: 0 };
  const home = () => ({ x: isPhone() ? 0 : 3.1, yaw: THREE.MathUtils.degToRad(isPhone() ? 48 : 50) });
  Object.assign(shot, home());

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
  let launchT = 0; // telemetry time while launching
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

  const clock = new THREE.Clock();
  const tailWorld = new THREE.Vector3();
  let distance = 0;
  let lastX = 0;
  let visible = true;
  new IntersectionObserver(([e]) => (visible = e.isIntersecting)).observe(hero);

  const tick = () => {
    requestAnimationFrame(tick);
    if (!visible) return;
    const t = clock.getElapsedTime();
    const base = home();

    // Which telemetry moment we are in: the grid loop, or the launch (driven by scroll).
    let sample;
    if (shot.launch + shot.roll < 0.001) {
      const span = GRID_TO - GRID_FROM;
      sample = telemetry.at(GRID_FROM + ((t * 1000) % span));
    } else {
      launchT = Math.min(LAUNCH_TO, (shot.launch * 0.15 + shot.roll * 0.85) * LAUNCH_TO);
      sample = telemetry.at(launchT);
    }
    const rev = THREE.MathUtils.clamp((sample.rpm - RPM_LOW) / (RPM_HIGH - RPM_LOW), 0, 1);

    // Revving: the chassis shivers on its springs, harder as the revs climb. The wheels stay put.
    const shake = reduce ? 0 : rev * (1 - shot.roll * 0.7);
    car.body.position.y = Math.sin(t * 92) * 0.004 * shake + Math.sin(t * 37) * 0.002 * shake - shot.launch * 0.035 * (1 - shot.roll);
    car.body.rotation.x = Math.sin(t * 61) * 0.0022 * shake;
    car.body.rotation.z = Math.sin(t * 47) * 0.0018 * shake + shot.launch * 0.012 * (1 - shot.roll); // squat under launch

    // The roll: the car turns side-on and drives out to the left, faster and faster.
    const exit = isPhone() ? -14 : -19;
    const x = base.x + (exit - base.x) * shot.roll;
    car.root.position.x = x;
    car.root.rotation.y = shot.yaw === base.yaw && shot.launch === 0 ? base.yaw : shot.yaw;
    distance += Math.abs(x - lastX);
    lastX = x;
    for (const w of car.wheels) w.rotation.z = distance / 0.36;

    // Streaks, rim light and bloom follow the speed; the rim also pulses with the revs.
    const speed = shot.roll;
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
    fill.style.transform = `scaleX(${(sample.rpm / RPM_HIGH).toFixed(3)})`;

    stage.render();
  };
  tick();
}

main().catch((error) => console.error(error));
