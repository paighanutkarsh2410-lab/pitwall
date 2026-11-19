// Prepares a car model for the web: shrinks it, and optionally removes its logos.
//
//   node scripts/prepare-model.mjs <source.glb> <target.glb> [--plain]
//
// Also measures which way the car's nose points (the rear wing is the tallest part of an F1 car,
// so the higher end is the back) and returns the yaw that turns the nose to -X, the page's
// convention, along with the model's own credit from the file (Sketchfab writes title, author,
// licence and source into it).
//
// By default the livery is kept exactly as modelled. With --plain, every logo pixel of a baked
// livery is repainted with the paint around it (the livery's base colour, measured, or carbon),
// leaving shape, normal and roughness detail untouched. Either way: unused vertex data goes,
// textures become 2048 px WebP, and geometry is quantized and meshopt-compressed.

import { NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS, EXTMeshoptCompression } from "@gltf-transform/extensions";
import { dedup, meshopt, prune, quantize, textureCompress } from "@gltf-transform/functions";
import { MeshoptEncoder } from "meshoptimizer";
import sharp from "sharp";
import { pathToFileURL } from "node:url";



/** Carbon and rubber: near-black and unsaturated. */
const isCarbon = (r, g, b) => Math.max(r, g, b) < 40 && Math.max(r, g, b) - Math.min(r, g, b) < 18;
/** Roughly navy: used only to measure the livery's actual navy. */
const roughlyNavy = (r, g, b) => b > r + 12 && b >= g && Math.max(r, g, b) < 110 && r < 60;
const MARK_GROW = 3; // px: anti-aliased logo edges are repainted too

async function repaint(png) {
  const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width: W, height: H } = info;
  const B = 16; // blocks of 16x16 px decide what paint a mark sits on
  const bw = Math.ceil(W / B);
  const bh = Math.ceil(H / B);
  const sum = new Float64Array(bw * bh * 4); // r, g, b, count of background pixels per block
  // The livery's navy, measured: the median of every roughly-navy pixel. Paint is anything
  // within a small distance of it; a logo's soft edge, blending into the navy, is not.
  const navySamples = [[], [], []];
  for (let i = 0; i < W * H * 4; i += 4 * 7) {
    if (roughlyNavy(data[i], data[i + 1], data[i + 2])) for (let c = 0; c < 3; c++) navySamples[c].push(data[i + c]);
  }
  const navy = navySamples.map((v) => v.sort((a, b) => a - b)[v.length >> 1]);
  console.log(`  navy measured at rgb(${navy.join(", ")})`);
  const isNavy = (r, g, b) => Math.hypot(r - navy[0], g - navy[1], b - navy[2]) < 22;
  const cls = new Uint8Array(W * H);
  for (let p = 0; p < W * H; p++) {
    const i = p * 4;
    cls[p] = isCarbon(data[i], data[i + 1], data[i + 2]) ? 0 : isNavy(data[i], data[i + 1], data[i + 2]) ? 1 : 2;
  }
  // Grow the marks so their anti-aliased edges are repainted with them.
  for (let pass = 0; pass < MARK_GROW; pass++) {
    const grown = cls.slice();
    for (let y = 1; y < H - 1; y++) {
      for (let x = 1; x < W - 1; x++) {
        const p = y * W + x;
        if (cls[p] !== 2 && (cls[p - 1] === 2 || cls[p + 1] === 2 || cls[p - W] === 2 || cls[p + W] === 2)) grown[p] = 2;
      }
    }
    cls.set(grown);
  }
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      const c = cls[y * W + x];
      if (c !== 2) {
        const k = (((y / B) | 0) * bw + ((x / B) | 0)) * 4;
        sum[k] += data[i];
        sum[k + 1] += data[i + 1];
        sum[k + 2] += data[i + 2];
        sum[k + 3] += 1;
      }
    }
  }
  // Blocks that are all mark (inside a big logo) take the paint of their neighbours, spreading
  // inward until every block has a colour.
  const paint = new Float32Array(bw * bh * 3);
  const known = new Uint8Array(bw * bh);
  for (let k = 0; k < bw * bh; k++) {
    if (sum[k * 4 + 3] > 0) {
      for (let c = 0; c < 3; c++) paint[k * 3 + c] = sum[k * 4 + c] / sum[k * 4 + 3];
      known[k] = 1;
    }
  }
  for (let pass = 0; pass < 64; pass++) {
    let filled = 0;
    const next = known.slice();
    for (let by = 0; by < bh; by++) {
      for (let bx = 0; bx < bw; bx++) {
        const k = by * bw + bx;
        if (known[k]) continue;
        let n = 0;
        const acc = [0, 0, 0];
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nx = bx + dx;
          const ny = by + dy;
          if (nx < 0 || ny < 0 || nx >= bw || ny >= bh) continue;
          const j = ny * bw + nx;
          if (!known[j]) continue;
          for (let c = 0; c < 3; c++) acc[c] += paint[j * 3 + c];
          n++;
        }
        if (n) {
          for (let c = 0; c < 3; c++) paint[k * 3 + c] = acc[c] / n;
          next[k] = 1;
          filled++;
        }
      }
    }
    known.set(next);
    if (!filled) break;
  }
  // Repaint the marks, sampling the block paint bilinearly so no block edges show.
  let marks = 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (cls[y * W + x] !== 2) continue;
      marks++;
      const fx = Math.min(bw - 1.001, Math.max(0, x / B - 0.5));
      const fy = Math.min(bh - 1.001, Math.max(0, y / B - 0.5));
      const x0 = fx | 0;
      const y0 = fy | 0;
      const tx = fx - x0;
      const ty = fy - y0;
      const i = (y * W + x) * 4;
      for (let c = 0; c < 3; c++) {
        const p = (bx, by) => paint[(by * bw + bx) * 3 + c];
        const top = p(x0, y0) * (1 - tx) + p(x0 + 1, y0) * tx;
        const bottom = p(x0, y0 + 1) * (1 - tx) + p(x0 + 1, y0 + 1) * tx;
        data[i + c] = Math.round(top * (1 - ty) + bottom * ty);
      }
    }
  }
  console.log(`  repainted ${marks.toLocaleString()} of ${(W * H).toLocaleString()} pixels (${((100 * marks) / (W * H)).toFixed(1)}%)`);
  return sharp(data, { raw: { width: W, height: H, channels: 4 } }).png().toBuffer();
}

/** World-space positions of every vertex in the scene, sampled (every nth vertex). */
function samplePositions(doc, every = 7) {
  const out = [];
  const v = [0, 0, 0];
  for (const node of doc.getRoot().listNodes()) {
    const mesh = node.getMesh();
    if (!mesh) continue;
    const m = node.getWorldMatrix();
    for (const prim of mesh.listPrimitives()) {
      const pos = prim.getAttribute("POSITION");
      if (!pos) continue;
      for (let i = 0; i < pos.getCount(); i += every) {
        pos.getElement(i, v);
        out.push([
          m[0] * v[0] + m[4] * v[1] + m[8] * v[2] + m[12],
          m[1] * v[0] + m[5] * v[1] + m[9] * v[2] + m[13],
          m[2] * v[0] + m[6] * v[1] + m[10] * v[2] + m[14],
        ]);
      }
    }
  }
  return out;
}

/** The yaw that turns this car's nose to -X: the higher end of its long axis is the rear wing. */
function noseYaw(doc) {
  const pts = samplePositions(doc);
  const min = [0, 1, 2].map((i) => Math.min(...pts.map((p) => p[i])));
  const max = [0, 1, 2].map((i) => Math.max(...pts.map((p) => p[i])));
  const axis = max[0] - min[0] > max[2] - min[2] ? 0 : 2;
  const len = max[axis] - min[axis];
  const top = (from, to) => Math.max(...pts.filter((p) => p[axis] >= from && p[axis] <= to).map((p) => p[1]));
  const lowEnd = top(min[axis], min[axis] + len * 0.15);
  const highEnd = top(max[axis] - len * 0.15, max[axis]);
  const noseAtMax = lowEnd > highEnd; // the rear wing is at the low end, so the nose is at the high end
  // Rotations about Y that take the nose direction to -X.
  if (axis === 2) return { yaw: noseAtMax ? -Math.PI / 2 : Math.PI / 2, axis: "z", noseAtMax, ends: [lowEnd, highEnd] };
  return { yaw: noseAtMax ? Math.PI : 0, axis: "x", noseAtMax, ends: [lowEnd, highEnd] };
}

/**
 * Some exports mark every material as bare metal (metallic 1, no metalness map), paint and
 * tyres included: three.js then draws the car as dark chrome, the livery lost and the studio
 * lights reflected as hot spots. When nearly every material is like that, the flag is an export
 * error, so each material gets the finish its name says it has. A model that mixes metal and
 * paint deliberately is left as it is.
 */
function fixBareMetal(doc) {
  const materials = doc.getRoot().listMaterials();
  const bare = materials.filter((m) => m.getMetallicFactor() >= 0.99 && !m.getMetallicRoughnessTexture());
  if (!materials.length || bare.length / materials.length < 0.95) return 0;
  const finish = [
    [/mirror/i, 1, 0.05],
    [/chrome/i, 1, 0.15],
    [/glass|clearled|led/i, 0, 0.08],
    [/paint/i, 0, 0.3],
    [/carbon/i, 0, 0.42],
    [/tyre|tire|wheel/i, 0, 0.78],
    [/decal|number|drivercolor|lcd/i, 0, 0.38],
  ];
  for (const m of bare) {
    const [, metal, rough] = finish.find(([re]) => re.test(m.getName())) ?? [null, 0, Math.max(m.getRoughnessFactor(), 0.5)];
    m.setMetallicFactor(metal);
    m.setRoughnessFactor(rough);
  }
  return bare.length;
}

export async function prepare(source, target, { plain = false } = {}) {
  await MeshoptEncoder.ready;
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ "meshopt.encoder": MeshoptEncoder });
  const doc = await io.read(source);
  const extras = doc.getRoot().getAsset().extras ?? {};
  const orientation = noseYaw(doc);

  if (plain) {
    console.log("Removing the logos from the livery");
    for (const material of doc.getRoot().listMaterials()) {
      const base = material.getBaseColorTexture();
      if (base) base.setImage(await repaint(base.getImage()));
    }
  }

  const fixed = fixBareMetal(doc);
  if (fixed) console.log(`Every material was bare metal (an export error): gave ${fixed} materials their real finish`);

  console.log("Dropping vertex data no material reads");
  const usedSets = new Set([0]);
  for (const material of doc.getRoot().listMaterials()) {
    for (const info of [material.getBaseColorTextureInfo(), material.getNormalTextureInfo(), material.getOcclusionTextureInfo(),
      material.getEmissiveTextureInfo(), material.getMetallicRoughnessTextureInfo()]) {
      if (info) usedSets.add(info.getTexCoord());
    }
  }
  for (const mesh of doc.getRoot().listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      for (const name of ["TEXCOORD_1", "TEXCOORD_2", "TEXCOORD_3", "TANGENT"]) {
        if (name.startsWith("TEXCOORD") && usedSets.has(Number(name.slice(-1)))) continue;
        if (prim.getAttribute(name)) prim.setAttribute(name, null);
      }
    }
  }

  console.log("Compressing");
  await doc.transform(
    dedup(),
    prune(),
    textureCompress({ encoder: sharp, targetFormat: "webp", resize: [2048, 2048], quality: 88 }),
    quantize(),
    meshopt({ encoder: MeshoptEncoder, level: "medium" }),
  );
  doc.createExtension(EXTMeshoptCompression).setRequired(true);
  await io.write(target, doc);
  console.log(`Wrote ${target}`);
  return { ...orientation, extras };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [source, target] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  if (!source || !target) throw new Error("usage: prepare-model.mjs <source.glb> <target.glb> [--plain]");
  console.log(await prepare(source, target, { plain: process.argv.includes("--plain") }));
}
