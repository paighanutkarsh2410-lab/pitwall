import * as THREE from "three";

/**
 * Tyre smoke for the burnout: soft puffs released at the rear tyres' contact patches. Each puff
 * is thrown back and out by the spinning tyre, slows in the air, rises, swells and thins out over
 * about three seconds, so the cloud hangs where the car was after it has gone.
 *
 * All the puffs are one instanced mesh, drawn in a single call: camera-facing squares placed,
 * sized, turned and faded per puff in the vertex shader. (As separate sprites they were up to
 * three hundred draw calls a frame.) Every puff is the same grey, so the order they are drawn in
 * makes no difference and they need no sorting.
 */
export function tyreSmoke(scene: THREE.Scene) {
  // A puff: a soft round blot with a little uneven texture, so the cloud doesn't look like discs.
  const texture = (() => {
    const c = document.createElement("canvas");
    c.width = c.height = 128;
    const g = c.getContext("2d")!;
    for (let i = 0; i < 9; i++) {
      const x = 64 + (Math.random() - 0.5) * 34;
      const y = 64 + (Math.random() - 0.5) * 34;
      const r = 26 + Math.random() * 30;
      const grad = g.createRadialGradient(x, y, 0, x, y, r);
      grad.addColorStop(0, "rgba(255,255,255,0.32)");
      grad.addColorStop(1, "rgba(255,255,255,0)");
      g.fillStyle = grad;
      g.fillRect(0, 0, 128, 128);
    }
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  })();

  const COUNT = 300;
  // Per puff: where it is (xyz), and its size, turn and opacity.
  const where = new THREE.InstancedBufferAttribute(new Float32Array(COUNT * 3), 3).setUsage(THREE.DynamicDrawUsage);
  const look = new THREE.InstancedBufferAttribute(new Float32Array(COUNT * 3), 3).setUsage(THREE.DynamicDrawUsage);
  const geometry = new THREE.InstancedBufferGeometry();
  const quad = new THREE.PlaneGeometry(1, 1);
  geometry.index = quad.index;
  geometry.setAttribute("position", quad.getAttribute("position"));
  geometry.setAttribute("uv", quad.getAttribute("uv"));
  geometry.setAttribute("where", where);
  geometry.setAttribute("look", look);
  geometry.instanceCount = COUNT;

  const material = new THREE.ShaderMaterial({
    uniforms: { map: { value: texture }, colour: { value: new THREE.Color(0xa4a6ad) } },
    vertexShader: /* glsl */ `
      attribute vec3 where;
      attribute vec3 look; // size, turn, opacity
      varying vec2 vUv;
      varying float vAlpha;
      void main() {
        vUv = uv;
        vAlpha = look.z;
        vec4 centre = modelViewMatrix * vec4(where, 1.0);
        float c = cos(look.y), s = sin(look.y);
        vec2 corner = mat2(c, s, -s, c) * position.xy * look.x;
        // A spent puff collapses to nothing, so it costs no pixels.
        gl_Position = projectionMatrix * vec4(centre.xy + corner * step(0.002, look.z), centre.zw);
      }`,
    fragmentShader: /* glsl */ `
      uniform sampler2D map;
      uniform vec3 colour;
      varying vec2 vUv;
      varying float vAlpha;
      void main() {
        vec4 t = texture2D(map, vUv);
        gl_FragColor = vec4(colour * t.rgb, t.a * vAlpha);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
    transparent: true,
    depthWrite: false,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.frustumCulled = false;
  mesh.renderOrder = 2;
  mesh.visible = false;
  scene.add(mesh);

  type Puff = { pos: THREE.Vector3; vel: THREE.Vector3; age: number; life: number; peak: number; size: number; turn: number; rot: number; live: boolean };
  const puffs: Puff[] = Array.from({ length: COUNT }, () => ({
    pos: new THREE.Vector3(),
    vel: new THREE.Vector3(),
    age: 0,
    life: 0,
    peak: 0,
    size: 1,
    turn: 0,
    rot: 0,
    live: false,
  }));
  let next = 0;
  let anyLive = false;
  const owed = new Map<THREE.Object3D, number>();
  const at = new THREE.Vector3();

  return {
    /** Releases puffs from each wheel, as many as `amount` (0 to 1) calls for in `dt` seconds. */
    emit(amount: number, dt: number, wheels: THREE.Object3D[]) {
      if (amount <= 0.02) return;
      for (const wheel of wheels) {
        let n = (owed.get(wheel) ?? 0) + amount * 75 * dt;
        wheel.getWorldPosition(at);
        while (n >= 1) {
          n -= 1;
          const p = puffs[next];
          next = (next + 1) % COUNT;
          p.pos.set(at.x + 0.2 + Math.random() * 0.2, 0.12 + Math.random() * 0.12, at.z + (Math.random() - 0.5) * 0.3);
          p.vel.set(0.7 + Math.random() * 1.5, 0.08 + Math.random() * 0.25, (Math.random() - 0.5) * 0.8 + Math.sign(at.z) * 0.25);
          p.age = 0;
          p.life = 2.2 + Math.random() * 1.6;
          p.peak = (0.28 + Math.random() * 0.2) * Math.min(1, amount * 1.4);
          p.size = 0.5 + Math.random() * 0.45;
          p.turn = (Math.random() - 0.5) * 0.8;
          p.rot = Math.random() * Math.PI * 2;
          p.live = true;
          anyLive = true;
        }
        owed.set(wheel, n);
      }
    },
    /** Moves, swells and thins every live puff. */
    update(dt: number) {
      if (!anyLive) {
        mesh.visible = false;
        return;
      }
      mesh.visible = true;
      anyLive = false;
      const w = where.array as Float32Array;
      const l = look.array as Float32Array;
      puffs.forEach((p, i) => {
        if (p.live) {
          p.age += dt;
          if (p.age >= p.life) p.live = false;
        }
        if (!p.live) {
          l[i * 3 + 2] = 0;
          return;
        }
        anyLive = true;
        const k = p.age / p.life;
        p.vel.multiplyScalar(1 - Math.min(1, 1.1 * dt)); // the air slows it
        p.vel.y += 0.07 * dt; // warm, it rises
        p.pos.addScaledVector(p.vel, dt);
        p.rot += p.turn * dt;
        w[i * 3] = p.pos.x;
        w[i * 3 + 1] = p.pos.y;
        w[i * 3 + 2] = p.pos.z;
        l[i * 3] = p.size + p.age * 1.5;
        l[i * 3 + 1] = p.rot;
        l[i * 3 + 2] = p.peak * Math.min(1, p.age / 0.18) * (1 - k) * (1 - k * 0.4);
      });
      where.needsUpdate = true;
      look.needsUpdate = true;
    },
  };
}
