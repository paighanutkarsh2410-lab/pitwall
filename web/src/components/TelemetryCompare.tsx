import { useEffect, useRef } from "react";
import { pairColours } from "../format";
import type { BoardCar, Sample } from "../types";

const DRS_OPEN = new Set([10, 12, 14]);
const WINDOW_MS = 20_000;
const RPM_MAX = 13_000;

/**
 * Two cars head to head: a dial each (speed in the middle, revs round the rim, the gear under
 * it), throttle and brake as bars, and the last 20 seconds of speed, throttle and braking on one
 * time axis. The first car in its team colour, the second in white or its own team's colour.
 */
export function TelemetryCompare({ cars, samples }: { cars: BoardCar[]; samples: Record<string, Sample[]> }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const ink = pairColours(cars);

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

    const L = 30;
    const plotW = w - L - 6;
    const lane = 8;
    const brakeH = lane * Math.max(cars.length, 1) + 6;
    const label = 13;
    const free = h - label * 3 - brakeH - 12;
    const speed = { top: label, height: free * 0.66 };
    const throttle = { top: speed.top + speed.height + label + 4, height: free * 0.34 };
    const brake = { top: throttle.top + throttle.height + label + 4, height: brakeH };

    ctx.font = "600 9.5px 'JetBrains Mono', monospace";
    const title = (text: string, top: number, note = "") => {
      ctx.fillStyle = "rgba(244,243,241,0.55)";
      ctx.textAlign = "left";
      ctx.fillText(text.toUpperCase(), L, top - 4);
      if (note) {
        ctx.fillStyle = "rgba(244,243,241,0.32)";
        ctx.textAlign = "right";
        ctx.fillText(note, L + plotW, top - 4);
      }
    };
    title("Speed", speed.top, "km/h");
    title("Throttle", throttle.top, "%");
    title("Brake", brake.top);
    ctx.strokeStyle = "rgba(255,255,255,0.07)";
    ctx.lineWidth = 1;
    ctx.fillStyle = "rgba(244,243,241,0.36)";
    ctx.textAlign = "right";
    for (const v of [100, 200, 300]) {
      const y = Math.round(speed.top + speed.height - (v / 350) * speed.height) + 0.5;
      ctx.beginPath();
      ctx.moveTo(L, y);
      ctx.lineTo(L + plotW, y);
      ctx.stroke();
      ctx.fillText(String(v), L - 5, y + 3.5);
    }
    for (const band of [throttle, brake]) ctx.strokeRect(L + 0.5, band.top + 0.5, plotW - 1, band.height - 1);

    const all = cars.flatMap((c) => samples[String(c.car)] ?? []);
    if (all.length < 2) return;
    const end = Math.max(...all.map((s) => s[0]));
    const start = end - WINDOW_MS;
    const x = (t: number) => L + ((t - start) / WINDOW_MS) * plotW;
    ctx.textAlign = "left";
    for (const ago of [15, 10, 5]) {
      const gx = x(end - ago * 1000);
      ctx.fillStyle = "rgba(244,243,241,0.06)";
      ctx.fillRect(gx, speed.top, 1, speed.height);
      ctx.fillStyle = "rgba(244,243,241,0.3)";
      ctx.fillText(`-${ago}s`, gx + 3, speed.top + speed.height - 3);
    }

    cars.forEach((car, i) => {
      const data = (samples[String(car.car)] ?? []).filter((s) => s[0] >= start - 1000);
      if (data.length < 2) return;
      const colour = ink[i];
      const line = (pick: (s: Sample) => number, max: number, band: { top: number; height: number }, fill: boolean) => {
        ctx.save();
        ctx.beginPath();
        ctx.rect(L, band.top, plotW, band.height);
        ctx.clip();
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
          ctx.globalAlpha = 0.13;
          ctx.fillStyle = colour;
          ctx.fill();
          ctx.globalAlpha = 1;
        }
        ctx.restore();
      };
      line((s) => s[1], 350, speed, i === 0);
      line((s) => s[2], 100, throttle, i === 0);
      const laneTop = brake.top + 3 + i * lane;
      ctx.fillStyle = colour;
      for (let j = 1; j < data.length; j++) {
        const a = Math.max(x(data[j - 1][0]), L);
        if (data[j - 1][3] && a < L + plotW) ctx.fillRect(a, laneTop, Math.max(1, x(data[j][0]) - a), lane - 2);
      }
    });
  }, [cars, samples, ink]);

  return (
    <section className="panel compare" aria-label="Telemetry head to head">
      <header className="panel-head">
        <h2>Telemetry · head to head</h2>
        <span className="legend small">
          {cars.map((c, i) => (
            <span key={c.car} className="legend-item" style={{ color: ink[i] }}>
              <span className={`swatch${i ? " dashed" : ""}`} />
              {c.code}
            </span>
          ))}
        </span>
      </header>
      <div className="dials">
        {cars.map((c, i) => (
          <Dial key={c.car} car={c} sample={(samples[String(c.car)] ?? []).at(-1)} colour={ink[i]} />
        ))}
      </div>
      <div className="trace-canvas">
        <canvas ref={canvas} aria-label="Speed, throttle and brake over the last 20 seconds" />
      </div>
    </section>
  );
}

/** One car's live readout: the dial, then throttle and brake bars and DRS. */
function Dial({ car, sample, colour }: { car: BoardCar; sample: Sample | undefined; colour: string }) {
  const [, speed = 0, throttle = 0, brake = 0, gear = 0, rpm = 0, drs = 0] = sample ?? [];
  // A 240° arc, open at the bottom, filled with the revs.
  const r = 46;
  const c = 2 * Math.PI * r;
  const arc = c * (240 / 360);
  const filled = arc * Math.min(rpm / RPM_MAX, 1);
  const shift = rpm > RPM_MAX * 0.88;
  return (
    <div className="dial" style={{ "--team": colour } as React.CSSProperties}>
      <div className="dial-head">
        <span className="code" style={{ color: colour }}>
          {car.code}
        </span>
        <span className="dim small">P{car.position ?? "–"}</span>
        <span className={`drs-chip${DRS_OPEN.has(drs) ? " on" : ""}`}>DRS</span>
      </div>
      <svg viewBox="0 0 120 108" className="dial-face" aria-label={`${car.code}: ${speed} km/h, gear ${gear}, ${rpm} rpm`}>
        <g transform="rotate(150 60 60)">
          <circle cx="60" cy="60" r={r} className="dial-track" strokeDasharray={`${arc} ${c}`} />
          <circle cx="60" cy="60" r={r} className={`dial-rpm${shift ? " shift" : ""}`} stroke={colour} strokeDasharray={`${filled} ${c}`} />
        </g>
        <text x="60" y="57" textAnchor="middle" className="dial-speed">
          {sample ? speed : "–"}
        </text>
        <text x="60" y="68" textAnchor="middle" className="dial-unit">
          km/h
        </text>
        <text x="60" y="104" textAnchor="middle" className="dial-gear">
          {sample ? (gear === 0 ? "N" : gear) : "–"}
        </text>
        <text x="60" y="80" textAnchor="middle" className="dial-rev">
          {sample ? `${(rpm / 1000).toFixed(1)}k rpm` : ""}
        </text>
      </svg>
      <div className="pedals">
        <span className="pedal-label dim small">THR</span>
        <span className="pedal">
          <span className="fill throttle" style={{ width: `${throttle}%` }} />
        </span>
        <span className="pedal-label dim small">BRK</span>
        <span className="pedal">
          <span className="fill brake" style={{ width: brake ? "100%" : "0%" }} />
        </span>
      </div>
    </div>
  );
}
