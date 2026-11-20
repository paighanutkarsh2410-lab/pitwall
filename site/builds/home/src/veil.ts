/**
 * The smoke the page changes in. After the burnout, the cloud billows out from where the rear
 * tyres were until it covers the screen; the winner's card is switched on behind it, and then the
 * smoke thins and lifts in patches, so the card comes out of the smoke rather than replacing the
 * car. Drawn on a 2D canvas over the page and driven entirely by two numbers the scroll sets
 * (cover and clear, 0 to 1), so it plays backwards as well as forwards.
 */
export function smokeVeil(canvas: HTMLCanvasElement) {
  const g = canvas.getContext("2d")!;

  // Soft, uneven blots in three greys, so the cloud has depth instead of one flat tone.
  const blot = (tone: number) => {
    const c = document.createElement("canvas");
    c.width = c.height = 256;
    const x = c.getContext("2d")!;
    for (let i = 0; i < 12; i++) {
      const px = 128 + (Math.random() - 0.5) * 80;
      const py = 128 + (Math.random() - 0.5) * 80;
      const r = 50 + Math.random() * 70;
      const grad = x.createRadialGradient(px, py, 0, px, py, r);
      grad.addColorStop(0, `rgba(${tone},${tone + 2},${tone + 7},0.6)`);
      grad.addColorStop(1, `rgba(${tone},${tone + 2},${tone + 7},0)`);
      x.fillStyle = grad;
      x.fillRect(0, 0, 256, 256);
    }
    return c;
  };
  const blots = [blot(150), blot(176), blot(204)];

  // Puffs spread over the whole screen (a jittered grid, so there are no holes), each with the
  // order it arrives in (set from the origin each time) and the moment it starts to clear.
  type Puff = { u: number; v: number; r: number; tex: number; spin: number; clearAt: number; drift: number };
  const puffs: Puff[] = [];
  const cols = 8, rows = 6;
  for (let i = 0; i < cols; i++) {
    for (let j = 0; j < rows; j++) {
      for (let k = 0; k < 2; k++) {
        puffs.push({
          u: (i + Math.random()) / cols,
          v: (j + Math.random()) / rows,
          r: 0.12 + Math.random() * 0.12,
          tex: Math.floor(Math.random() * blots.length),
          spin: Math.random() * Math.PI * 2,
          clearAt: Math.random() * 0.45,
          drift: (Math.random() - 0.5) * 2,
        });
      }
    }
  }

  const smooth = (e0: number, e1: number, x: number) => {
    const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
    return t * t * (3 - 2 * t);
  };
  let drawn = false;

  return {
    /**
     * cover: the cloud rolling over the screen from (ox, oy), in px from the top left.
     * clear: the cloud thinning and lifting away from the page underneath.
     */
    draw(cover: number, clear: number, ox: number, oy: number) {
      const visible = cover > 0.001 && clear < 0.999;
      canvas.style.visibility = visible ? "visible" : "hidden";
      if (!visible) {
        if (drawn) g.clearRect(0, 0, canvas.width, canvas.height);
        drawn = false;
        return;
      }
      const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
      const w = canvas.clientWidth, h = canvas.clientHeight;
      if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
        canvas.width = Math.round(w * dpr);
        canvas.height = Math.round(h * dpr);
      }
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.clearRect(0, 0, w, h);
      drawn = true;
      const span = Math.hypot(Math.max(ox, w - ox), Math.max(oy, h - oy));
      const big = Math.max(w, h);

      // Underneath the puffs, a solid haze once the screen is nearly covered: the moment the
      // card is switched on, nothing of the page shows through.
      const haze = smooth(0.6, 0.95, cover) * (1 - smooth(0, 0.55, clear));
      if (haze > 0) {
        g.globalAlpha = haze;
        g.fillStyle = "rgb(174,176,182)";
        g.fillRect(0, 0, w, h);
      }

      for (const p of puffs) {
        const fx = p.u * w, fy = p.v * h;
        // Arrival: the nearer the origin, the sooner; each puff rolls out from the tyres.
        const d = Math.hypot(fx - ox, fy - oy) / span;
        const into = smooth(d * 0.55, d * 0.55 + 0.45, cover);
        if (into <= 0) continue;
        // Clearing: in patches, each lifting and spreading as it thins.
        const out = smooth(p.clearAt, p.clearAt + 0.5, clear);
        const alpha = into * Math.pow(1 - out, 2.5);
        if (alpha <= 0.003) continue;
        const x = ox + (fx - ox) * (0.35 + 0.65 * into) + p.drift * out * 0.12 * w;
        const y = oy + (fy - oy) * (0.35 + 0.65 * into) - out * 0.18 * h;
        const s = p.r * big * (0.45 + 0.55 * into) * (1 + out * 0.7) * 2;
        g.globalAlpha = Math.min(1, alpha * 1.15);
        g.save();
        g.translate(x, y);
        g.rotate(p.spin + out * 0.6);
        g.drawImage(blots[p.tex], -s / 2, -s / 2, s, s);
        g.restore();
      }
      g.globalAlpha = 1;
    },
  };
}
