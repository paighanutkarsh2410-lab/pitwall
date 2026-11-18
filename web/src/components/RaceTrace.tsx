import { useEffect, useState } from "react";
import { teamColour } from "../format";
import type { Board, Trace } from "../types";

const W = 900;
const H = 260;
const PAD = { l: 38, r: 54, t: 10, b: 22 };

/**
 * The race trace: every car's gap to the leader at the end of each lap. Flat lines are steady
 * gaps; drops are pit stops; a pack bunching up is a safety car.
 */
export function RaceTrace({ board, team, run }: { board: Board; team: string | null; run: string }) {
  const [trace, setTrace] = useState<Trace | null>(null);
  useEffect(() => {
    let cancelled = false;
    const load = () =>
      fetch("/api/trace")
        .then((r) => (r.ok ? r.json() : null))
        .then((t: Trace | null) => !cancelled && t && setTrace(t))
        .catch(() => undefined);
    load();
    const timer = window.setInterval(load, 4000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [run]);

  const total = Math.max(board.laps ?? 0, trace?.laps ?? 0, 1);
  // Clip the gap axis so a lapped car doesn't flatten everyone else.
  const gaps = Object.values(trace?.cars ?? {}).flatMap((pts) => pts.map((p) => p[1])).sort((a, b) => a - b);
  const cap = Math.max(10, gaps.length ? gaps[Math.floor(gaps.length * 0.9)] : 10);
  const x = (lap: number) => PAD.l + ((lap - 1) / Math.max(total - 1, 1)) * (W - PAD.l - PAD.r);
  const y = (gap: number) => PAD.t + (Math.min(gap, cap) / cap) * (H - PAD.t - PAD.b);
  const byCar = new Map(board.cars.map((c) => [String(c.car), c]));
  const entries = Object.entries(trace?.cars ?? {}).sort(([a], [b]) => {
    const ours = (k: string) => (byCar.get(k)?.team === team ? 1 : 0);
    return ours(a) - ours(b); // team cars drawn last, on top
  });
  const ticks = [0, cap / 2, cap].map((v) => Math.round(v));

  return (
    <section className="panel trace" aria-label="Race trace">
      <header className="panel-head">
        <h2>Race trace · gap to leader</h2>
        <span className="dim small">Seconds behind the leader at the end of each lap</span>
      </header>
      {entries.length === 0 ? (
        <p className="dim small empty">The trace draws itself as laps are completed.</p>
      ) : (
        <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Gap to the leader per lap">
          {ticks.map((t) => (
            <g key={t}>
              <line x1={PAD.l} x2={W - PAD.r} y1={y(t)} y2={y(t)} className="grid" />
              <text x={PAD.l - 6} y={y(t) + 4} textAnchor="end" className="axis">
                {t}s
              </text>
            </g>
          ))}
          {board.lap > 0 && <line x1={x(board.lap)} x2={x(board.lap)} y1={PAD.t} y2={H - PAD.b} className="now-line" />}
          <text x={PAD.l} y={H - 6} className="axis">
            Lap 1
          </text>
          <text x={W - PAD.r} y={H - 6} textAnchor="end" className="axis">
            Lap {total}
          </text>
          {entries.map(([car, pts]) => {
            const info = byCar.get(car);
            const ours = team != null && info?.team === team;
            const last = pts[pts.length - 1];
            return (
              <g key={car} className={ours ? "ours" : "theirs"}>
                <polyline
                  points={pts.map(([lap, g]) => `${x(lap).toFixed(1)},${y(g).toFixed(1)}`).join(" ")}
                  stroke={teamColour(info?.colour)}
                />
                {ours && last && (
                  <text x={x(last[0]) + 6} y={y(last[1]) + 4} className="label" fill={teamColour(info?.colour)}>
                    {info?.code}
                  </text>
                )}
              </g>
            );
          })}
        </svg>
      )}
    </section>
  );
}
