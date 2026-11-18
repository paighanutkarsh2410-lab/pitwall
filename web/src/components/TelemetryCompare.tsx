import { useEffect, useRef } from "react";
import { teamColour } from "../format";
import type { BoardCar, Sample } from "../types";

const DRS_OPEN = new Set([10, 12, 14]);

/** Two cars' speed, throttle and brake over the last minute, overlaid; plus live gauges. */
export function TelemetryCompare({ cars, samples }: { cars: BoardCar[]; samples: Record<string, Sample[]> }) {
  const canvas = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const el = canvas.current;
    const ctx = el?.getContext("2d");
    if (!el || !ctx) return;
    const ratio = window.devicePixelRatio || 1;
    const w = el.clientWidth;
    const h = el.clientHeight;
    el.width = w * ratio;
    el.height = h * ratio;
    ctx.scale(ratio, ratio);
    ctx.clearRect(0, 0, w, h);
    const all = cars.flatMap((c) => samples[String(c.car)] ?? []);
    if (all.length < 2) return;
    // A shared time axis: the newest sample of either car is the right edge.
    const end = Math.max(...all.map((s) => s[0]));
    const start = end - 50_000;
    const x = (t: number) => ((t - start) / (end - start)) * w;
    const bands = { speed: [4, h * 0.56], throttle: [h * 0.62, h * 0.18], brake: [h * 0.84, h * 0.13] } as const;
    ctx.strokeStyle = "rgba(255,255,255,0.06)";
    for (const [top, height] of Object.values(bands)) ctx.strokeRect(0.5, top + 0.5, w - 1, height);
    cars.forEach((car, i) => {
      const data = (samples[String(car.car)] ?? []).filter((s) => s[0] >= start);
      if (data.length < 2) return;
      const colour = teamColour(car.colour);
      const line = (pick: (s: Sample) => number, max: number, [top, height]: readonly [number, number]) => {
        ctx.beginPath();
        data.forEach((s, j) => {
          const y = top + height - (pick(s) / max) * height;
          if (j) ctx.lineTo(x(s[0]), y);
          else ctx.moveTo(x(s[0]), y);
        });
        ctx.strokeStyle = colour;
        ctx.globalAlpha = i === 0 ? 1 : 0.85;
        ctx.setLineDash(i === 0 ? [] : [5, 3]);
        ctx.lineWidth = 1.6;
        ctx.stroke();
      };
      line((s) => s[1], 360, bands.speed);
      line((s) => s[2], 100, bands.throttle);
      line((s) => (s[3] ? 100 : 0), 100, bands.brake);
    });
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
  }, [cars, samples]);

  return (
    <section className="panel compare" aria-label="Telemetry comparison">
      <header className="panel-head">
        <h2>Telemetry</h2>
        <span className="legend small">
          {cars.map((c, i) => (
            <span key={c.car} style={{ color: teamColour(c.colour) }}>
              {i === 0 ? "━━" : "╍╍"} {c.code}
            </span>
          ))}
        </span>
      </header>
      <div className="gauge-rows">
        {cars.map((c) => {
          const s = (samples[String(c.car)] ?? []).at(-1);
          return (
            <div key={c.car} className="gauge-row" style={{ "--team": teamColour(c.colour) } as React.CSSProperties}>
              <span className="code">{c.code}</span>
              <span className="mono speed">{s ? s[1] : "–"}</span>
              <span className="dim small">km/h</span>
              <span className="mono">G{s ? s[4] : "–"}</span>
              <span className="mono dim">{s ? `${(s[5] / 1000).toFixed(1)}k` : "–"}</span>
              <span className="pedal">
                <span className="fill throttle" style={{ width: `${s ? s[2] : 0}%` }} />
              </span>
              <span className={`brake-dot${s && s[3] ? " on" : ""}`} title="Brake" />
              <span className={`drs-chip${s && DRS_OPEN.has(s[6]) ? " on" : ""}`}>DRS</span>
            </div>
          );
        })}
      </div>
      <div className="trace-canvas">
        <canvas ref={canvas} aria-label="Speed, throttle and brake, last 50 seconds" />
        <div className="bands small dim">
          <span>Speed</span>
          <span>Throttle</span>
          <span>Brake</span>
        </div>
      </div>
    </section>
  );
}
