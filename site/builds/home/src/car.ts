import * as THREE from "three";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/addons/libs/meshopt_decoder.module.js";

/**
 * The car. Convention for everything that uses it: the car is 5.6 m long, sits on y = 0, and its
 * nose points along -X. `body` is what shakes when the engine revs; `wheels` spin about their axle.
 *
 * models/rb19.glb is redgrund's "Oracle Red Bull F1 Car RB19 2023" (Sketchfab, CC BY 4.0), in
 * its original livery. Until that file is in place, a stand-in is built from primitives.
 */
export interface Car {
  root: THREE.Group;
  body: THREE.Group;
  wheels: THREE.Object3D[];
  standIn: boolean;
  credit: string;
}

const LENGTH = 5.6;
const NAVY = 0x1a2340;
const RED = 0xc8102e;
const YELLOW = 0xffc906;

function paint(colour: number, clearcoat = 1): THREE.MeshPhysicalMaterial {
  return new THREE.MeshPhysicalMaterial({ color: colour, roughness: 0.38, metalness: 0.25, clearcoat, clearcoatRoughness: 0.08 });
}

function shadowed<T extends THREE.Object3D>(o: T): T {
  o.traverse((c) => {
    if ((c as THREE.Mesh).isMesh) {
      c.castShadow = true;
      c.receiveShadow = true;
    }
  });
  return o;
}

/** A rough RB19 silhouette from primitives: enough to build and judge the scene before the model arrives. */
function standIn(): Car {
  const root = new THREE.Group();
  const body = new THREE.Group();
  root.add(body);
  const navy = paint(NAVY);
  const red = paint(RED);
  const yellow = paint(YELLOW);
  const carbon = new THREE.MeshPhysicalMaterial({ color: 0x0d0e10, roughness: 0.45, metalness: 0.4, clearcoat: 0.6 });
  const add = (geo: THREE.BufferGeometry, mat: THREE.Material, x: number, y: number, z: number, rz = 0) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    m.rotation.z = rz;
    body.add(m);
    return m;
  };

  // Nose: a cone lying along X, yellow tip.
  const nose = new THREE.CylinderGeometry(0.1, 0.27, 1.9, 24);
  nose.rotateZ(Math.PI / 2);
  add(nose, navy, -1.85, 0.36, 0);
  const tip = new THREE.SphereGeometry(0.105, 20, 12);
  add(tip, yellow, -2.8, 0.36, 0);
  // Monocoque, sidepods, engine cover, airbox.
  add(new RoundedBoxGeometry(2.3, 0.5, 0.75, 4, 0.2), navy, -0.25, 0.48, 0);
  add(new RoundedBoxGeometry(1.9, 0.42, 1.55, 4, 0.18), navy, 0.55, 0.42, 0);
  add(new RoundedBoxGeometry(1.6, 0.18, 1.56, 3, 0.07), red, 0.6, 0.21, 0);
  add(new RoundedBoxGeometry(1.7, 0.55, 0.55, 4, 0.22), navy, 1.2, 0.74, 0);
  add(new RoundedBoxGeometry(0.42, 0.5, 0.36, 4, 0.15), navy, 0.05, 1.03, 0);
  // Halo.
  const halo = new THREE.TorusGeometry(0.42, 0.035, 10, 40, Math.PI);
  halo.rotateY(Math.PI / 2);
  halo.rotateX(Math.PI / 2);
  add(halo, carbon, -0.45, 0.88, 0);
  // Front wing with endplates, rear wing with endplates.
  add(new RoundedBoxGeometry(0.55, 0.05, 2.0, 2, 0.02), carbon, -2.75, 0.13, 0);
  add(new RoundedBoxGeometry(0.45, 0.04, 1.96, 2, 0.02), red, -2.6, 0.2, 0, -0.15);
  for (const z of [-1, 1]) add(new RoundedBoxGeometry(0.6, 0.28, 0.03, 2, 0.01), carbon, -2.72, 0.22, z * 0.99);
  add(new RoundedBoxGeometry(0.38, 0.05, 1.0, 2, 0.02), carbon, 2.55, 0.98, 0);
  add(new RoundedBoxGeometry(0.3, 0.04, 1.0, 2, 0.02), red, 2.45, 1.08, 0, -0.2);
  for (const z of [-1, 1]) add(new RoundedBoxGeometry(0.6, 0.62, 0.03, 2, 0.01), navy, 2.55, 0.85, z * 0.51);
  // Floor edge.
  add(new RoundedBoxGeometry(3.6, 0.04, 1.5, 2, 0.02), carbon, 0.6, 0.06, 0);

  // Wheels: tyre, rim, a yellow-banded sidewall (soft compound), on their own groups so they spin.
  const wheels: THREE.Object3D[] = [];
  const rubber = new THREE.MeshStandardMaterial({ color: 0x111112, roughness: 0.82 });
  const rim = new THREE.MeshStandardMaterial({ color: 0x2a2c30, roughness: 0.3, metalness: 0.9 });
  const band = new THREE.MeshStandardMaterial({ color: 0xf2d000, roughness: 0.6 });
  for (const [x, zs, r, w] of [[-1.75, 0.8, 0.36, 0.34], [1.75, 0.8, 0.37, 0.42]] as const) {
    for (const side of [-1, 1]) {
      const wheel = new THREE.Group();
      const tyre = new THREE.Mesh(new THREE.CylinderGeometry(r, r, w, 48, 1), rubber);
      tyre.rotation.x = Math.PI / 2;
      const disc = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.62, r * 0.62, w + 0.01, 32), rim);
      disc.rotation.x = Math.PI / 2;
      const stripe = new THREE.Mesh(new THREE.TorusGeometry(r * 0.8, 0.012, 6, 48), band);
      stripe.position.z = side * (w / 2 + 0.002);
      wheel.add(tyre, disc, stripe);
      wheel.position.set(x, r, side * zs);
      root.add(wheel);
      wheels.push(wheel);
    }
  }
  shadowed(root);
  return { root, body, wheels, standIn: true, credit: "" };
}

/** Fits a loaded model to the convention: 5.6 m long, on the floor, nose along -X. */
function fit(object: THREE.Object3D, yawToNoseMinusX: number): THREE.Group {
  const holder = new THREE.Group();
  object.rotation.y = yawToNoseMinusX;
  holder.add(object);
  const box = new THREE.Box3().setFromObject(holder);
  const size = box.getSize(new THREE.Vector3());
  const scale = LENGTH / Math.max(size.x, size.z);
  object.scale.multiplyScalar(scale);
  const fitted = new THREE.Box3().setFromObject(holder);
  const centre = fitted.getCenter(new THREE.Vector3());
  object.position.x -= centre.x;
  object.position.z -= centre.z;
  object.position.y -= fitted.min.y;
  return holder;
}

/**
 * Finds the four wheels in a model where they are part of the body meshes, and moves each into
 * its own group pivoting on its axle (car space: nose along -X, axles along Z, floor at y = 0).
 *
 * 1. The axles: a tyre's tread sits outboard of the bodywork at about half its own height, so
 *    triangles out there, between 0.2 m and 0.55 m up, cluster at the front and rear axles.
 * 2. The wheels: each mesh is split into connected pieces (triangles sharing vertices). A piece
 *    joins a wheel only if all of it lies inside that wheel's cylinder: a tyre, a rim, a hub nut.
 *    A piece reaching outside it (a suspension arm, a wing endplate, a brake duct fixed to the
 *    upright) stays with the body. So a tyre is never half taken, which would leave a torn,
 *    sawtooth edge once the taken half turns.
 *    Of those, only pieces centred on the axle turn (tyre, rim, nut); an off-centre one inside the
 *    wheel (a duct vane, a tether) would swing around the axle, so it stays still.
 * 3. The pivots: each wheel turns about the centre of its tyre, measured, not assumed.
 */
function separateWheels(root: THREE.Group, body: THREE.Object3D): THREE.Object3D[] {
  const meshes: THREE.Mesh[] = [];
  body.traverse((o) => {
    if ((o as THREE.Mesh).isMesh && (o as THREE.Mesh).geometry.index) meshes.push(o as THREE.Mesh);
  });
  const toRoot = new THREE.Matrix4().copy(root.matrixWorld).invert();
  const v = new THREE.Vector3();

  // Every mesh's vertices in car space, computed once.
  const spaces = meshes.map((mesh) => {
    const m = new THREE.Matrix4().multiplyMatrices(toRoot, mesh.matrixWorld);
    const pos = mesh.geometry.getAttribute("position") as THREE.BufferAttribute;
    const xyz = new Float32Array(pos.count * 3);
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).applyMatrix4(m);
      xyz[i * 3] = v.x;
      xyz[i * 3 + 1] = v.y;
      xyz[i * 3 + 2] = v.z;
    }
    return { mesh, matrix: m, xyz };
  });

  // 1. The axles.
  const front: number[] = [];
  const rear: number[] = [];
  let maxZ = 0;
  const box = new THREE.Box3().setFromObject(body);
  const halfWidth = Math.max(Math.abs(box.min.z), Math.abs(box.max.z));
  const outboard = halfWidth * 0.72;
  for (const { mesh, xyz } of spaces) {
    const index = mesh.geometry.index!;
    for (let t = 0; t < index.count; t += 3) {
      let x = 0, y = 0, z = 0;
      for (let k = 0; k < 3; k++) {
        const i = index.getX(t + k) * 3;
        x += xyz[i];
        y += xyz[i + 1];
        z += xyz[i + 2];
      }
      x /= 3;
      y /= 3;
      z /= 3;
      if (Math.abs(z) > outboard && y > 0.2 && y < 0.55 && Math.abs(x) < LENGTH * 0.42) {
        (x < 0 ? front : rear).push(x);
        maxZ = Math.max(maxZ, Math.abs(z));
      }
    }
  }
  if (front.length < 50 || rear.length < 50) return [];
  const median = (a: number[]) => a.sort((p, q) => p - q)[a.length >> 1];
  const axles = [median(front), median(rear)];
  const REACH = 0.47; // a tyre's radius (about 0.36 m) with room for the axle estimate being off
  const inner = maxZ - 0.55; // a wheel's inboard face is well within this of the car's outer edge

  // 2. Connected pieces wholly inside a wheel's cylinder, and centred on its axle.
  type Piece = { wheel: string; box: THREE.Box3 };
  const found = spaces.map(({ mesh, xyz }) => {
    const index = mesh.geometry.index!;
    const n = xyz.length / 3;
    // Union-find over the vertices the triangles join.
    const parent = new Int32Array(n);
    for (let i = 0; i < n; i++) parent[i] = i;
    const find = (i: number): number => {
      while (parent[i] !== i) {
        parent[i] = parent[parent[i]];
        i = parent[i];
      }
      return i;
    };
    for (let t = 0; t < index.count; t += 3) {
      const a = find(index.getX(t));
      for (const k of [1, 2]) {
        const b = find(index.getX(t + k));
        if (a !== b) parent[b] = a;
      }
    }
    // Which wheel each piece fits inside ("" for none), and its extent.
    const pieces = new Map<number, Piece>();
    for (let i = 0; i < n; i++) {
      const r = find(i);
      const piece = pieces.get(r);
      if (piece?.wheel === "") continue;
      const x = xyz[i * 3], y = xyz[i * 3 + 1], z = xyz[i * 3 + 2];
      let wheel = "";
      if (Math.abs(z) > inner) {
        for (const [k, ax] of axles.entries()) {
          if (Math.hypot(x - ax, y - 0.36) < REACH) wheel = `${k ? "R" : "F"}${z < 0 ? "L" : "R"}`;
        }
      }
      if (!piece) pieces.set(r, { wheel, box: new THREE.Box3().expandByPoint(v.set(x, y, z)) });
      else if (piece.wheel !== wheel) piece.wheel = "";
      else piece.box.expandByPoint(v.set(x, y, z));
    }
    return { find, pieces };
  });
  // Each wheel's centre, from its tyre-sized pieces (or everything it found, if none).
  const centres = new Map<string, THREE.Vector3>();
  for (const big of [true, false]) {
    const boxes = new Map<string, THREE.Box3>();
    for (const { pieces } of found) {
      for (const { wheel, box } of pieces.values()) {
        if (!wheel || centres.has(wheel) || (big && box.max.y - box.min.y < 0.5)) continue;
        if (!boxes.has(wheel)) boxes.set(wheel, new THREE.Box3());
        boxes.get(wheel)!.union(box);
      }
    }
    for (const [wheel, box] of boxes) centres.set(wheel, box.getCenter(new THREE.Vector3()));
  }
  // A piece turns with its wheel only if it is centred on the axle, as a tyre, rim or nut is.
  const centred = (p: Piece) => {
    const c = centres.get(p.wheel);
    if (!c) return false;
    const m = p.box.getCenter(new THREE.Vector3());
    return Math.hypot(m.x - c.x, m.y - c.y) < 0.07;
  };
  const groups = new Map<string, { mesh: THREE.Mesh; matrix: THREE.Matrix4; tris: number[] }[]>();
  spaces.forEach(({ mesh, matrix }, s_) => {
    const { find, pieces } = found[s_];
    const index = mesh.geometry.index!;
    const keep: number[] = [];
    const taken = new Map<string, number[]>();
    for (let t = 0; t < index.count; t += 3) {
      const a = index.getX(t), b = index.getX(t + 1), c = index.getX(t + 2);
      const piece = pieces.get(find(a));
      if (!piece?.wheel || !centred(piece)) {
        keep.push(a, b, c);
        continue;
      }
      if (!taken.has(piece.wheel)) taken.set(piece.wheel, []);
      taken.get(piece.wheel)!.push(a, b, c);
    }
    if (!taken.size) return;
    mesh.geometry.setIndex(keep);
    for (const [wheel, tris] of taken) {
      if (!groups.has(wheel)) groups.set(wheel, []);
      groups.get(wheel)!.push({ mesh, matrix, tris });
    }
  });

  // 3. A pivot per wheel at the measured centre of what it took.
  const wheels: THREE.Object3D[] = [];
  for (const [wheel, parts] of groups) {
    const pivot = new THREE.Group();
    pivot.name = `wheel_${wheel}`;
    pivot.position.copy(centres.get(wheel)!);
    const offset = new THREE.Matrix4().makeTranslation(-pivot.position.x, -pivot.position.y, -pivot.position.z);
    for (const { mesh, matrix, tris } of parts) {
      const geometry = new THREE.BufferGeometry();
      for (const [name, attr] of Object.entries(mesh.geometry.attributes)) geometry.setAttribute(name, attr);
      geometry.setIndex(tris);
      const part = new THREE.Mesh(geometry, mesh.material);
      part.matrixAutoUpdate = false;
      part.matrix.multiplyMatrices(offset, matrix);
      pivot.add(part);
    }
    root.add(pivot);
    wheels.push(pivot);
  }
  return wheels;
}

/** A car as public/models/cars.json describes it (written by scripts/prepare-cars.mjs). */
export interface CarInfo {
  id: string;
  name: string;
  team: string;
  season: number;
  model: string;
  yaw: number;
  borrowed: boolean;
  credit: { title: string; author: string; url: string; license: string };
}

export async function loadCars(): Promise<CarInfo[]> {
  try {
    const r = await fetch("models/cars.json");
    return r.ok ? (await r.json()).cars : [];
  } catch {
    return [];
  }
}

const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
const loaded = new Map<string, Promise<THREE.Group>>(); // model file -> its scene, loaded once

/** Starts loading a model without waiting for it, so a car is ready by the time it's chosen. */
export function preload(info: CarInfo): void {
  if (!loaded.has(info.model)) loaded.set(info.model, loader.loadAsync(info.model).then((g) => g.scene));
}

export async function loadCar(info: CarInfo | undefined): Promise<Car> {
  if (!info) return standIn();
  try {
    preload(info);
    // Each car gets its own copy: the wheel split edits the meshes, so cloned geometry is needed.
    const scene = (await loaded.get(info.model)!).clone(true);
    scene.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.isMesh) mesh.geometry = mesh.geometry.clone();
    });
    const root = new THREE.Group();
    const body = fit(scene, info.yaw);
    root.add(body);
    root.updateMatrixWorld(true);
    // The wheels are fused into the body meshes; split them out so they can turn on their axles.
    const wheels = separateWheels(root, body);
    shadowed(root);
    const c = info.credit;
    const borrowed = info.borrowed ? ` (shown with the ${c.title} model)` : "";
    return {
      root,
      body,
      wheels,
      standIn: false,
      credit: `${info.name}${borrowed}: 3D model "${c.title}" by ${c.author} (Sketchfab, ${c.license}). Team and sponsor marks belong to their owners.`,
    };
  } catch (error) {
    console.warn(`${info.name} did not load; using the stand-in`, error);
    return standIn();
  }
}

/**
 * The car before a race is chosen: no livery, no team. Every panel becomes the same deep gloss
 * black, so only the studio's light strips and the rim light draw its shape. Swaps this copy's
 * materials only; the loaded model and other cars keep theirs.
 */
const SHADOW = new THREE.MeshPhysicalMaterial({ color: 0x08080a, metalness: 0.75, roughness: 0.3, clearcoat: 1, clearcoatRoughness: 0.12 });
export function silhouette(car: Car): Car {
  car.root.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) (o as THREE.Mesh).material = SHADOW;
  });
  return car;
}
