// Prepares a car model for the web: shrinks it, and optionally removes its logos.
//
//   node scripts/prepare-model.mjs <source.glb> <target.glb> [--plain]
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

const [source, target] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const plain = process.argv.includes("--plain");
if (!source || !target) throw new Error("usage: prepare-model.mjs <source.glb> <target.glb> [--plain]");

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

await MeshoptEncoder.ready;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ "meshopt.encoder": MeshoptEncoder });
const doc = await io.read(source);

if (plain) {
  console.log("Removing the logos from the livery");
  for (const material of doc.getRoot().listMaterials()) {
    const base = material.getBaseColorTexture();
    if (base) base.setImage(await repaint(base.getImage()));
  }
}

console.log("Dropping vertex data the material never reads");
for (const mesh of doc.getRoot().listMeshes()) {
  for (const prim of mesh.listPrimitives()) {
    for (const name of ["TEXCOORD_1", "TEXCOORD_2", "TEXCOORD_3", "TANGENT"]) {
      const attr = prim.getAttribute(name);
      if (attr) prim.setAttribute(name, null);
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
