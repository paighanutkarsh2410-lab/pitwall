import * as THREE from "three";

/**
 * Tyre smoke for the burnout: soft puffs released at the rear tyres' contact patches. Each puff
 * is thrown back and out by the spinning tyre, slows in the air, rises, swells and thins out over
 * about three seconds, so the cloud hangs where the car was after it has gone.
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

  type Puff = { sprite: THREE.Sprite; age: number; life: number; vel: THREE.Vector3; peak: number; size: number; turn: number };
  const puffs: Puff[] = [];
  const group = new THREE.Group();
  scene.add(group);
  for (let i = 0; i < 300; i++) {
    const material = new THREE.SpriteMaterial({ map: texture, color: 0xa4a6ad, transparent: true, depthWrite: false, opacity: 0 });
    const sprite = new THREE.Sprite(material);
    sprite.visible = false;
    group.add(sprite);
    puffs.push({ sprite, age: 0, life: 0, vel: new THREE.Vector3(), peak: 0, size: 1, turn: 0 });
  }
  let next = 0;
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
          next = (next + 1) % puffs.length;
          p.sprite.position.set(at.x + 0.2 + Math.random() * 0.2, 0.12 + Math.random() * 0.12, at.z + (Math.random() - 0.5) * 0.3);
          p.vel.set(0.7 + Math.random() * 1.5, 0.08 + Math.random() * 0.25, (Math.random() - 0.5) * 0.8 + Math.sign(at.z) * 0.25);
          p.age = 0;
          p.life = 2.2 + Math.random() * 1.6;
          p.peak = (0.28 + Math.random() * 0.2) * Math.min(1, amount * 1.4);
          p.size = 0.5 + Math.random() * 0.45;
          p.turn = (Math.random() - 0.5) * 0.8;
          p.sprite.material.rotation = Math.random() * Math.PI * 2;
          p.sprite.visible = true;
        }
        owed.set(wheel, n);
      }
    },
    /** Moves, swells and thins every live puff. */
    update(dt: number) {
      for (const p of puffs) {
        if (!p.sprite.visible) continue;
        p.age += dt;
        if (p.age >= p.life) {
          p.sprite.visible = false;
          continue;
        }
        const k = p.age / p.life;
        p.vel.multiplyScalar(1 - Math.min(1, 1.1 * dt)); // the air slows it
        p.vel.y += 0.07 * dt; // warm, it rises
        p.sprite.position.addScaledVector(p.vel, dt);
        const s = p.size + p.age * 1.5;
        p.sprite.scale.set(s, s, 1);
        p.sprite.material.rotation += p.turn * dt;
        p.sprite.material.opacity = p.peak * Math.min(1, p.age / 0.18) * (1 - k) * (1 - k * 0.4);
      }
    },
  };
}
