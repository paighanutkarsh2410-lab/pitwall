import { useEffect, useRef } from "react";
import { shade, teamColour } from "../format";
import type { BoardCar, Sample } from "../types";

const DRS_OPEN = new Set([10, 12, 14]);
const WINDOW_MS = 50_000;

/** The two compared cars' colours: teammates share a colour, so the second is a lighter shade. */
function colours(cars: BoardCar[]): string[] {
  return cars.map((c, i) => {
    const base = teamColour(c.colour);
    return i > 0 && c.team === cars[0].team ? shade(base, 0.55) : base;
  });
}

/**
 * Two cars' speed, throttle and brake over the last 50 seconds, on one time axis, with live
 * readouts above. Speed has its own scale (100/200/300 km/h); throttle is a band from 0 to
 * 100 %; braking shows as solid blocks, one lane per car, so the two never hide each other.
 */
export function TelemetryCompare({ cars, samples }: { cars: BoardCar[]; samples: Record<string, Sample[]> }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const ink = colours(cars);

  useEffect(() => {
    const el = canvas.current;
    const ctx = el?.getContext("2d");
    if (!el || !ctx) return;
    const ratio = window.devicePixelRatio || 1;
    const w = el.clientWidth;
    const h = el.clientHeight;
    el.width = w * ratio;
    el.height = h * ratio;
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const L = 34; // room for the speed scale
    const plotW = w - L - 6;
    const brakeH = 9 * Math.max(cars.length, 1) + 4;
    const label = 14;
    const speed = { top: label, height: (h - label * 3 - brakeH - 14) * 0.68 };
    const throttle = { top: speed.top + speed.height + label + 4, height: (h - label * 3 - brakeH - 14) * 0.32 };
    const brake = { top: throttle.top + throttle.height + label + 4, height: brakeH };

    // The frame: band titles, the speed scale and its lines.
    ctx.font = "600 10px 'JetBrains Mono', monospace";
    ctx.textBaseline = "alphabetic";
    const title = (text: string, top: number, note = "") => {
      ctx.fillStyle = "rgba(244,243,241,0.62)";
      ctx.fillText(text.toUpperCase(), L, top - 4);
      if (note) {
        ctx.fillStyle = "rgba(244,243,241,0.35)";
        ctx.textAlign = "right";
        ctx.fillText(note, L + plotW, top - 4);
        ctx.textAlign = "left";
      }
    };
    title("Speed", speed.top, "km/h");
    title("Throttle", throttle.top, "%");
    title("Brake", brake.top);
    ctx.strokeStyle = "rgba(255,255,255,0.07)";
    ctx.lineWidth = 1;
    ctx.fillStyle = "rgba(244,243,241,0.38)";
    ctx.textAlign = "right";
    for (const v of [100, 200, 300]) {
      const y = Math.round(speed.top + speed.height - (v / 350) * speed.height) + 0.5;
      ctx.beginPath();
      ctx.moveTo(L, y);
      ctx.lineTo(L + plotW, y);
      ctx.stroke();
      ctx.fillText(String(v), L - 6, y + 3.5);
    }
    for (const band of [throttle, brake]) ctx.strokeRect(L + 0.5, band.top + 0.5, plotW - 1, band.height - 1);
    ctx.textAlign = "left";

    const all = cars.flatMap((c) => samples[String(c.car)] ?? []);
    if (all.length < 2) return;
    const end = Math.max(...all.map((s) => s[0]));
    const start = end - WINDOW_MS;
    const x = (t: number) => L + ((t - start) / WINDOW_MS) * plotW;
    // Seconds ago, along the bottom of the speed band.
    for (const ago of [40, 30, 20, 10]) {
      const gx = x(end - ago * 1000);
      ctx.fillStyle = "rgba(244,243,241,0.06)";
      ctx.fillRect(gx, speed.top, 1, speed.height);
      ctx.fillStyle = "rgba(244,243,241,0.3)";
      ctx.fillText(`-${ago}s`, gx + 3, speed.top + speed.height - 3);
    }

    cars.forEach((car, i) => {
      const data = (samples[String(car.car)] ?? []).filter((s) => s[0] >= start);
      if (data.length < 2) return;
      const colour = ink[i];
      const line = (pick: (s: Sample) => number, max: number, band: { top: number; height: number }, fill: boolean) => {
        ctx.beginPath();
        data.forEach((s, j) => {
          const y = band.top + band.height - (Math.min(pick(s), max) / max) * band.height;
          if (j) ctx.lineTo(x(s[0]), y);
          else ctx.moveTo(x(s[0]), y);
        });
        ctx.strokeStyle = colour;
        ctx.lineWidth = i === 0 ? 2 : 1.6;
        ctx.setLineDash(i === 0 ? [] : [5, 3]);
        ctx.stroke();
        ctx.setLineDash([]);
        if (fill) {
          ctx.lineTo(x(data[data.length - 1][0]), band.top + band.height);
          ctx.lineTo(x(data[0][0]), band.top + band.height);
          ctx.closePath();
          ctx.globalAlpha = 0.14;
          ctx.fillStyle = colour;
          ctx.fill();
          ctx.globalAlpha = 1;
        }
      };
      line((s) => s[1], 350, speed, i === 0);
      line((s) => s[2], 100, throttle, i === 0);
      // Braking: solid blocks in this car's own lane.
      const laneTop = brake.top + 2 + i * 9;
      ctx.fillStyle = colour;
      for (let j = 1; j < data.length; j++) {
        if (data[j - 1][3]) ctx.fillRect(x(data[j - 1][0]), laneTop, Math.max(1, x(data[j][0]) - x(data[j - 1][0])), 7);
      }
    });
  }, [cars, samples, ink]);

  return (
    <section className="panel compare" aria-label="Telemetry comparison">
      <header className="panel-head">
        <h2>Telemetry</h2>
        <span className="legend small">
          {cars.map((c, i) => (
            <span key={c.car} className="legend-item" style={{ color: ink[i] }}>
              <span className={`swatch${i ? " dashed" : ""}`} />
              {c.code}
            </span>
          ))}
        </span>
      </header>
      <div className="gauge-rows">
        {cars.map((c, i) => {
          const s = (samples[String(c.car)] ?? []).at(-1);
          return (
            <div key={c.car} className="gauge-row" style={{ "--team": ink[i] } as React.CSSProperties}>
              <span className="code">{c.code}</span>
              <span className="mono speed">{s ? s[1] : "–"}</span>
              <span className="dim small">km/h</span>
              <span className="mono">G{s ? s[4] : "–"}</span>
              <span className="mono dim">{s ? `${(s[5] / 1000).toFixed(1)}k` : "–"}</span>
              <span className="pedal" title="Throttle">
                <span className="fill throttle" style={{ width: `${s ? s[2] : 0}%` }} />
              </span>
              <span className={`brake-dot${s && s[3] ? " on" : ""}`} title="Brake" />
              <span className={`drs-chip${s && DRS_OPEN.has(s[6]) ? " on" : ""}`}>DRS</span>
            </div>
          );
        })}
      </div>
      <div className="trace-canvas">
        <canvas ref={canvas} aria-label="Speed, throttle and brake over the last 50 seconds" />
      </div>
    </section>
  );
}
