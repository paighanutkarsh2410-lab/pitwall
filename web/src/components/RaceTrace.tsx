import { useEffect, useState } from "react";
import { shade, teamColour } from "../format";
import { RECORDING, recordedTrace } from "../recording";
import type { Board, Strategy, Trace } from "../types";

const W = 900;
const H = 280;
const PAD = { l: 44, r: 112, t: 14, b: 26 };

/** A round step for the gap axis: 5, 10, 20 or 30 s between lines. */
function step(cap: number): number {
  return cap <= 25 ? 5 : cap <= 60 ? 10 : cap <= 120 ? 20 : 30;
}

/**
 * The race trace: every car's gap to the leader at the end of each lap, the leader along the
 * top. Flat lines are steady gaps; a drop is a pit stop; the pack closing up together is a
 * safety car (shaded). The followed team is drawn bold and labelled; the field is quiet behind.
 */
export function RaceTrace({ board, team, run, strategy }: { board: Board; team: string | null; run: string; strategy: Strategy | null }) {
  const [trace, setTrace] = useState<Trace | null>(null);
  const lap = board.lap;
  useEffect(() => {
    if (!RECORDING) return;
    let cancelled = false;
    recordedTrace(lap)
      .then((t) => !cancelled && setTrace(t))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [lap]);
  useEffect(() => {
    if (RECORDING) return;
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
  // The lap axis grows with the race: early on, the laps run so far fill the chart instead of
  // a sliver at its left edge; from about half distance it shows the whole race.
  const lapsShown = lap / total > 0.45 ? total : Math.min(total, Math.max(lap + 4, 12));
  const byCar = new Map(board.cars.map((c) => [String(c.car), c]));
  const ours = board.cars.filter((c) => team != null && c.team === team).map((c) => String(c.car));

  // The gap axis is set by the cars worth reading, not by a car a lap down or in the pits:
  // the followed team's cars and the top eight now. Anything further back runs off the bottom.
  const latest = (pts: [number, number][]) => pts[pts.length - 1]?.[1] ?? 0;
  const entries = Object.entries(trace?.cars ?? {});
  const front = entries
    .map(([, pts]) => latest(pts))
    .sort((a, b) => a - b)
    .slice(0, 8);
  const watched = entries.filter(([car]) => ours.includes(car)).flatMap(([, pts]) => pts.slice(-6).map((p) => p[1]));
  const want = Math.max(10, ...front, ...watched) * 1.12;
  const every = step(want);
  const cap = Math.ceil(want / every) * every;

  const x = (l: number) => PAD.l + ((l - 1) / Math.max(lapsShown - 1, 1)) * (W - PAD.l - PAD.r);
  const y = (gap: number) => PAD.t + (gap / cap) * (H - PAD.t - PAD.b);
  const plotRight = W - PAD.r;
  const lapEvery = lapsShown <= 15 ? 1 : lapsShown <= 30 ? 5 : 10;
  const lapTicks = Array.from({ length: lapsShown }, (_, i) => i + 1).filter((l) => l === 1 || l % lapEvery === 0);
  const gapTicks = Array.from({ length: cap / every + 1 }, (_, i) => i * every);

  // Safety car and VSC laps, as shaded bands.
  const neutral = (strategy?.neutralised_laps ?? []).filter((l) => l <= lapsShown);

  // The field first (quiet), then the followed team on top.
  const field = entries.filter(([car]) => !ours.includes(car));
  const team_ = ours.map((car) => [car, trace?.cars[car]] as const).filter((e): e is readonly [string, [number, number][]] => !!e[1]);

  // Labels at the line ends for the followed cars, pushed apart so they never overlap.
  const labels = team_
    .map(([car, pts], i) => {
      const info = byCar.get(car);
      const last = pts[pts.length - 1];
      // The place at the end of that lap, from the same numbers as the line (not the live order,
      // which may already have moved on mid-lap).
      const place = 1 + entries.filter(([, other]) => (other.find((p) => p[0] === last[0])?.[1] ?? Infinity) < last[1]).length;
      return { car, info, i, place, gap: last[1], at: Math.min(y(last[1]), H - PAD.b - 4) + 4, lap: last[0] };
    })
    .sort((a, b) => a.at - b.at);
  for (let i = 1; i < labels.length; i++) labels[i].at = Math.max(labels[i].at, labels[i - 1].at + 14);

  const colourOf = (car: string, i: number) => {
    const c = teamColour(byCar.get(car)?.colour);
    return i === 0 ? c : shade(c, 0.55);
  };

  return (
    <section className="panel trace" aria-label="Race trace">
      <header className="panel-head">
        <h2>Race trace · gap to leader</h2>
        <span className="dim small">
          Leader along the top · <span className="sc-key" /> safety car
        </span>
      </header>
      {entries.length === 0 ? (
        <p className="dim small empty">The trace draws itself as laps are completed.</p>
      ) : (
        <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Gap to the leader per lap">
          <defs>
            <clipPath id="trace-plot">
              <rect x={PAD.l} y={PAD.t - 4} width={plotRight - PAD.l + 2} height={H - PAD.t - PAD.b + 4} />
            </clipPath>
          </defs>
          {neutral.map((l) => (
            <rect key={l} x={x(l - 0.5)} width={x(2) - x(1)} y={PAD.t} height={H - PAD.t - PAD.b} className="sc-band" />
          ))}
          {gapTicks.map((t) => (
            <g key={`g${t}`}>
              <line x1={PAD.l} x2={plotRight} y1={y(t)} y2={y(t)} className={t === 0 ? "grid zero" : "grid"} />
              <text x={PAD.l - 8} y={y(t) + 3.5} textAnchor="end" className="axis">
                {t === 0 ? "P1" : `+${t}s`}
              </text>
            </g>
          ))}
          {lapTicks.map((l) => (
            <g key={`l${l}`}>
              <line x1={x(l)} x2={x(l)} y1={H - PAD.b} y2={H - PAD.b + 4} className="grid" />
              <text x={x(l)} y={H - 8} textAnchor="middle" className="axis">
                {l}
              </text>
            </g>
          ))}
          <text x={plotRight} y={H - 8} dx={14} className="axis">
            {lapsShown < total ? `of ${total} →` : "laps"}
          </text>
          {board.lap > 0 && board.lap <= lapsShown && (
            <line x1={x(board.lap)} x2={x(board.lap)} y1={PAD.t} y2={H - PAD.b} className="now-line" />
          )}
          <g clipPath="url(#trace-plot)">
            {field.map(([car, pts]) => (
              <polyline key={car} className="theirs" points={pts.map(([l, g]) => `${x(l).toFixed(1)},${y(g).toFixed(1)}`).join(" ")} />
            ))}
            {team_.map(([car, pts], i) => {
              const stops = (strategy?.cars[car]?.stints ?? []).filter((s) => s.lap_start > 1).map((s) => s.lap_start - 1);
              return (
                <g key={car} className="ours">
                  <polyline points={pts.map(([l, g]) => `${x(l).toFixed(1)},${y(g).toFixed(1)}`).join(" ")} stroke={colourOf(car, i)} />
                  {stops.map((l) => {
                    const p = pts.find(([pl]) => pl === l);
                    return p ? <circle key={l} cx={x(p[0])} cy={y(p[1])} r={4} className="pit-dot" stroke={colourOf(car, i)} /> : null;
                  })}
                </g>
              );
            })}
          </g>
          {labels.map(({ car, info, i, place, gap, at, lap: l }) => (
            <g key={car}>
              <text x={x(l) + 9} y={at} className="label" fill={colourOf(car, i)}>
                P{place} {info?.code}
                <tspan className="label-gap" dx={6}>
                  {gap < 0.05 ? "lead" : `+${gap.toFixed(1)}`}
                </tspan>
              </text>
            </g>
          ))}
        </svg>
      )}
    </section>
  );
}
