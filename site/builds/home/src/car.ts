import * as THREE from "three";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/addons/libs/meshopt_decoder.module.js";

/**
 * The car. Convention for everything that uses it: the car is 5.6 m long, sits on y = 0, and its
 * nose points along -X. `body` is what shakes when the engine revs; `wheels` spin about their axle.
 *
 * models/rb19.glb is redgrund's "Oracle Red Bull F1 Car RB19 2023" (Sketchfab, CC BY 4.0),
 * re-coloured without its logos. Until that file is in place, a stand-in is built from primitives.
 */
export interface Car {
  root: THREE.Group;
  body: THREE.Group;
  wheels: THREE.Object3D[];
  standIn: boolean;
  credit: string;
}

const LENGTH = 5.6;
// The source model lies along Z; this turns its nose to -X.
const MODEL_YAW = -Math.PI / 2;
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
 * A tyre's tread sits outboard of the bodywork at about half its own height, so triangles out
 * there, between 0.2 m and 0.55 m up, cluster at the two axles. Each wheel is then every
 * outboard triangle within a tyre's radius of its axle centre. Those triangles leave the body
 * mesh (its index shrinks) and join a mesh of their own sharing the same vertex buffers.
 */
function separateWheels(root: THREE.Group, body: THREE.Object3D): THREE.Object3D[] {
  const meshes: THREE.Mesh[] = [];
  body.traverse((o) => {
    if ((o as THREE.Mesh).isMesh && (o as THREE.Mesh).geometry.index) meshes.push(o as THREE.Mesh);
  });
  const toRoot = new THREE.Matrix4().copy(root.matrixWorld).invert();
  const v = new THREE.Vector3();
  const centroid = (pos: THREE.BufferAttribute, m: THREE.Matrix4, a: number, b: number, c: number) => {
    const out = new THREE.Vector3();
    for (const k of [a, b, c]) out.add(v.fromBufferAttribute(pos, k).applyMatrix4(m));
    return out.divideScalar(3);
  };

  // 1. Where are the axles? Outboard tread triangles, split into front (x < 0) and rear.
  const front: number[] = [];
  const rear: number[] = [];
  let maxZ = 0;
  const box = new THREE.Box3().setFromObject(body);
  const halfWidth = Math.max(Math.abs(box.min.z), Math.abs(box.max.z));
  const outboard = halfWidth * 0.72;
  for (const mesh of meshes) {
    const m = new THREE.Matrix4().multiplyMatrices(toRoot, mesh.matrixWorld);
    const pos = mesh.geometry.getAttribute("position") as THREE.BufferAttribute;
    const index = mesh.geometry.index!;
    for (let t = 0; t < index.count; t += 3) {
      const c = centroid(pos, m, index.getX(t), index.getX(t + 1), index.getX(t + 2));
      if (Math.abs(c.z) > outboard && c.y > 0.2 && c.y < 0.55 && Math.abs(c.x) < LENGTH * 0.42) {
        (c.x < 0 ? front : rear).push(c.x);
        maxZ = Math.max(maxZ, Math.abs(c.z));
      }
    }
  }
  if (front.length < 50 || rear.length < 50) return [];
  const median = (a: number[]) => a.sort((p, q) => p - q)[a.length >> 1];
  const axles = [median(front), median(rear)];
  const radius = 0.36; // an F1 tyre is about 0.72 m across

  // 2. Each wheel: outboard triangles within a tyre's radius of its axle centre.
  const groups = new Map<string, { mesh: THREE.Mesh; matrix: THREE.Matrix4; tris: number[] }[]>();
  for (const mesh of meshes) {
    const m = new THREE.Matrix4().multiplyMatrices(toRoot, mesh.matrixWorld);
    const pos = mesh.geometry.getAttribute("position") as THREE.BufferAttribute;
    const index = mesh.geometry.index!;
    const keep: number[] = [];
    const taken = new Map<string, number[]>();
    for (let t = 0; t < index.count; t += 3) {
      const a = index.getX(t), b = index.getX(t + 1), c3 = index.getX(t + 2);
      const c = centroid(pos, m, a, b, c3);
      let wheel: string | null = null;
      if (Math.abs(c.z) > outboard * 0.92) {
        for (const [i, ax] of axles.entries()) {
          if (Math.hypot(c.x - ax, c.y - radius) < radius * 1.04) wheel = `${i ? "R" : "F"}${c.z < 0 ? "L" : "R"}`;
        }
      }
      if (wheel) {
        if (!taken.has(wheel)) taken.set(wheel, []);
        taken.get(wheel)!.push(a, b, c3);
      } else keep.push(a, b, c3);
    }
    if (!taken.size) continue;
    mesh.geometry.setIndex(keep);
    for (const [wheel, tris] of taken) {
      if (!groups.has(wheel)) groups.set(wheel, []);
      groups.get(wheel)!.push({ mesh, matrix: m, tris });
    }
  }

  // 3. A pivot per wheel at its axle centre, holding the wheel's triangles.
  const wheels: THREE.Object3D[] = [];
  for (const [wheel, parts] of groups) {
    const pivot = new THREE.Group();
    pivot.name = `wheel_${wheel}`;
    pivot.position.set(axles[wheel[0] === "F" ? 0 : 1], radius, (wheel[1] === "L" ? -1 : 1) * (maxZ * 0.9));
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

export async function loadCar(url = "models/rb19.glb"): Promise<Car> {
  try {
    const head = await fetch(url, { method: "HEAD" });
    if (!head.ok) return standIn();
    const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
    const gltf = await loader.loadAsync(url);
    const root = new THREE.Group();
    const body = fit(gltf.scene, MODEL_YAW);
    root.add(body);
    root.updateMatrixWorld(true);
    // The wheels are fused into the body meshes; split them out so they can turn on their axles.
    const wheels = separateWheels(root, body);
    shadowed(root);
    return {
      root,
      body,
      wheels,
      standIn: false,
      credit: '3D model: "Oracle Red Bull F1 Car RB19 2023" by redgrund (Sketchfab, CC BY 4.0), shown without logos.',
    };
  } catch (error) {
    console.warn("RB19 model did not load; using the stand-in", error);
    return standIn();
  }
}
