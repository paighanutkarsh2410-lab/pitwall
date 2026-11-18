import { useEffect, useRef, useState } from "react";
import { lapTime, sector, teamColour, TYRES } from "../format";
import type { BoardCar, Lap, Sample } from "../types";

const DRS_OPEN = new Set([10, 12, 14]);

/** The watched car: live telemetry, its traces, and its laps from TimescaleDB. */
export function CarPanel({ car, samples, run }: { car: BoardCar; samples: Sample[]; run: string }) {
  const latest = samples[samples.length - 1];
  const [laps, setLaps] = useState<Lap[]>([]);

  useEffect(() => {
    let cancelled = false;
    const load = () =>
      fetch(`/api/laps/${car.car}`)
        .then((r) => (r.ok ? r.json() : []))
        .then((rows: Lap[]) => !cancelled && setLaps(rows))
        .catch(() => undefined);
    load();
    const timer = window.setInterval(load, 5000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [car.car, run]);

  const tyre = car.compound ? TYRES[car.compound] : null;
  return (
    <section className="panel car" aria-label={`${car.name} telemetry`}>
      <header className="panel-head car-head" style={{ borderColor: teamColour(car.colour) }}>
        <div>
          <h2>
            <span className="pos-chip">P{car.position ?? "–"}</span> {car.name || car.code}
          </h2>
          <p className="dim small">
            #{car.car} · {car.team}
            {tyre && (
              <>
                {" "}· <span style={{ color: tyre.colour }}>{car.compound?.toLowerCase()}</span>, {car.tyre_age} laps
              </>
            )}
          </p>
        </div>
      </header>

      <div className="gauges">
        <div className="gauge big">
          <span className="value mono">{latest ? latest[1] : "–"}</span>
          <span className="unit">km/h</span>
        </div>
        <div className="gauge">
          <span className="value mono">{latest ? latest[4] : "–"}</span>
          <span className="unit">gear</span>
        </div>
        <div className="gauge">
          <span className="value mono">{latest ? (latest[5] / 1000).toFixed(1) : "–"}</span>
          <span className="unit">k rpm</span>
        </div>
        <div className={`gauge drs${latest && DRS_OPEN.has(latest[6]) ? " on" : ""}`}>
          <span className="value">DRS</span>
        </div>
      </div>
      <div className="pedals">
        <Bar label="Throttle" value={latest ? latest[2] : 0} tone="throttle" />
        <Bar label="Brake" value={latest ? (latest[3] ? 100 : 0) : 0} tone="brake" />
      </div>

      <Traces samples={samples} />

      <div className="lap-row">
        <div>
          <span className="dim small">Last lap</span>
          <span className="mono">{lapTime(car.last_lap_ms)}</span>
        </div>
        <div>
          <span className="dim small">Best</span>
          <span className={`mono ${car.fastest_lap ? "fastest" : ""}`}>{lapTime(car.best_lap_ms)}</span>
        </div>
        <div>
          <span className="dim small">Sectors</span>
          <span className="mono">{car.sectors_ms.map(sector).join(" · ")}</span>
        </div>
      </div>
      <LapChart laps={laps} />
    </section>
  );
}

function Bar({ label, value, tone }: { label: string; value: number; tone: string }) {
  return (
    <div className="bar">
      <span className="dim small">{label}</span>
      <div className="bar-track">
        <div className={`bar-fill ${tone}`} style={{ width: `${Math.max(0, Math.min(100, value))}%` }} />
      </div>
    </div>
  );
}

/** Speed, throttle and brake over the last minute or so, drawn on a canvas. */
function Traces({ samples }: { samples: Sample[] }) {
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
    if (samples.length < 2) return;
    const t0 = samples[0][0];
    const span = Math.max(1, samples[samples.length - 1][0] - t0);
    const x = (t: number) => ((t - t0) / span) * w;
    const line = (pick: (s: Sample) => number, max: number, colour: string, top: number, height: number) => {
      ctx.beginPath();
      samples.forEach((s, i) => {
        const y = top + height - (pick(s) / max) * height;
        if (i) ctx.lineTo(x(s[0]), y);
        else ctx.moveTo(x(s[0]), y);
      });
      ctx.strokeStyle = colour;
      ctx.lineWidth = 1.6;
      ctx.stroke();
    };
    const css = getComputedStyle(el);
    line((s) => s[1], 360, css.getPropertyValue("--speed"), 4, h * 0.58);
    line((s) => s[2], 100, css.getPropertyValue("--throttle"), h * 0.66, h * 0.15);
    line((s) => (s[3] ? 100 : 0), 100, css.getPropertyValue("--brake"), h * 0.84, h * 0.14);
  }, [samples]);
  return (
    <div className="traces">
      <canvas ref={canvas} aria-label="Speed, throttle and brake traces" />
      <div className="trace-labels small">
        <span className="speed-label">Speed</span>
        <span className="throttle-label">Throttle</span>
        <span className="brake-label">Brake</span>
      </div>
    </div>
  );
}

/** Lap times so far: slow laps (safety car, pit stops) are clipped so the race pace reads. */
function LapChart({ laps }: { laps: Lap[] }) {
  const timed = laps.filter((l) => l.lap_time_ms != null) as (Lap & { lap_time_ms: number })[];
  if (timed.length < 2) return <p className="dim small empty">Lap times appear after a couple of laps.</p>;
  const sorted = [...timed].map((l) => l.lap_time_ms).sort((a, b) => a - b);
  const best = sorted[0];
  const cap = sorted[Math.floor(sorted.length * 0.8)] * 1.03;
  const W = 300;
  const H = 70;
  const maxLap = Math.max(...timed.map((l) => l.lap));
  const x = (lap: number) => (lap / Math.max(maxLap, 1)) * (W - 8) + 4;
  const y = (ms: number) => H - 6 - ((Math.min(ms, cap) - best) / Math.max(cap - best, 1)) * (H - 12);
  return (
    <figure className="lap-chart">
      <figcaption className="dim small">Lap times · {timed.length} laps</figcaption>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label="Lap time per lap">
        <polyline points={timed.map((l) => `${x(l.lap)},${y(l.lap_time_ms)}`).join(" ")} />
        {timed.map((l) => (
          <circle key={l.lap} cx={x(l.lap)} cy={y(l.lap_time_ms)} r={l.lap_time_ms === best ? 3 : 1.6} className={l.lap_time_ms === best ? "best" : ""}>
            <title>{`Lap ${l.lap}: ${lapTime(l.lap_time_ms)}`}</title>
          </circle>
        ))}
      </svg>
    </figure>
  );
}
