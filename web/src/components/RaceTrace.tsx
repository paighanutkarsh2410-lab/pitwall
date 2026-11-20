import { useEffect, useRef, useState } from "react";
import { pairColours, teamColour, TYRES } from "../format";
import type { Board, BoardCar, Strategy, Trace } from "../types";

const PAD = { l: 44, r: 124, t: 14, b: 26 };
/** Beyond this place, the field is drawn as a faint band rather than as lines to read. */
const READABLE = 10;

type Mode = "gaps" | "places";

/** A round step for the gap axis: 5, 10, 20 or 30 s between lines. */
function step(cap: number): number {
  return cap <= 25 ? 5 : cap <= 60 ? 10 : cap <= 120 ? 20 : 30;
}

/**
 * The race lap by lap. Before the start it is the grid, with each car's starting tyres. From the
 * first lap it is a chart: gaps to the leader (flat is steady, a drop is a pit stop, the field
 * bunching is a safety car), or places, which read from lap one. The followed team is drawn bold
 * and labelled, its stops marked with the change of tyres; the front of the field is quiet behind
 * it, the back of the field fainter still.
 */
export function RaceTrace({ board, team, trace, strategy }: { board: Board; team: string | null; trace: Trace | null; strategy: Strategy | null }) {
  const [chosen, setMode] = useState<Mode | null>(null);
  const entries = Object.entries(trace?.cars ?? {});
  const started = entries.length > 0;
  // Gaps need a few laps to say anything; places read from the first.
  const mode: Mode = chosen ?? (board.lap >= 4 ? "gaps" : "places");

  return (
    <section className="panel trace" aria-label="Race trace">
      <header className="panel-head">
        <h2>{started ? (mode === "gaps" ? "Race trace · gap to leader" : "Race trace · places") : "Starting grid"}</h2>
        {started ? (
          <div className="head-tools">
            <span className="dim small key">
              <span className="sc-key" /> safety car
            </span>
            <div className="toggle" role="group" aria-label="Chart">
              <button aria-pressed={mode === "gaps"} onClick={() => setMode("gaps")}>
                Gaps
              </button>
              <button aria-pressed={mode === "places"} onClick={() => setMode("places")}>
                Places
              </button>
            </div>
          </div>
        ) : (
          <span className="dim small">Lights out at the scheduled start</span>
        )}
      </header>
      {started ? <Chart board={board} team={team} trace={trace!} strategy={strategy} mode={mode} /> : <Grid board={board} trace={trace} team={team} />}
    </section>
  );
}

/** The grid in its two staggered columns, pole on the left. */
function Grid({ board, trace, team }: { board: Board; trace: Trace | null; team: string | null }) {
  const slot = (c: BoardCar) => trace?.grid?.[String(c.car)] ?? c.start_position ?? c.position ?? 99;
  const cars = [...board.cars].sort((a, b) => slot(a) - slot(b));
  return (
    <ol className="grid-slots" aria-label="Starting grid">
      {cars.map((c) => {
        const compound = trace?.startTyres?.[String(c.car)] ?? c.compound;
        const tyre = compound ? TYRES[compound] : null;
        const at = slot(c);
        return (
          <li
            key={c.car}
            className={`${at % 2 === 0 ? "even" : "odd"}${team != null && c.team === team ? " ours" : ""}`}
            style={{ "--team": teamColour(c.colour) } as React.CSSProperties}
          >
            <span className="slot mono">{at < 99 ? at : "–"}</span>
            <span className="code">{c.code}</span>
            <span className="name dim small">{c.name}</span>
            {tyre ? (
              <span className="tyre-chip" style={{ color: tyre.colour, borderColor: tyre.colour }} title={`Starts on ${compound}`}>
                {tyre.label}
              </span>
            ) : (
              <span className="tyre-chip unknown" title="Starting tyres not known yet">
                ?
              </span>
            )}
          </li>
        );
      })}
    </ol>
  );
}

/** The size of an element, kept up to date: the chart is drawn in real pixels to fill its panel. */
function useSize<T extends HTMLElement>(): [React.RefObject<T | null>, { w: number; h: number }] {
  const ref = useRef<T>(null);
  const [size, setSize] = useState({ w: 900, h: 300 });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setSize({ w: Math.round(e.contentRect.width), h: Math.round(e.contentRect.height) }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, size];
}

function Chart(props: { board: Board; team: string | null; trace: Trace; strategy: Strategy | null; mode: Mode }) {
  const [ref, { w, h }] = useSize<HTMLDivElement>();
  return (
    <div className="trace-fill" ref={ref}>
      <ChartSvg {...props} W={Math.max(w, 320)} H={Math.max(h, 240)} />
    </div>
  );
}

function ChartSvg({ board, team, trace, strategy, mode, W, H }: { board: Board; team: string | null; trace: Trace; strategy: Strategy | null; mode: Mode; W: number; H: number }) {
  const lap = board.lap;
  const total = Math.max(board.laps ?? 0, trace.laps, 1);
  // The lap axis grows with the race: early on, the laps run so far fill the chart instead of a
  // sliver at its left edge; from about half distance it shows the whole race.
  const lapsShown = lap / total > 0.45 ? total : Math.min(total, Math.max(lap + 4, 12));
  const byCar = new Map(board.cars.map((c) => [String(c.car), c]));
  const oursCars = board.cars.filter((c) => team != null && c.team === team).slice(0, 2);
  const ours = oursCars.map((c) => String(c.car));
  const ink = pairColours(oursCars);
  const colourOf = (car: string) => ink[ours.indexOf(car)] ?? teamColour(byCar.get(car)?.colour);

  const series = mode === "gaps" ? trace.cars : (trace.positions ?? {});
  const entries = Object.entries(series);
  const latest = (pts: [number, number][]) => pts[pts.length - 1]?.[1] ?? Infinity;
  const field = board.cars.length || entries.length;

  // The vertical scale. Gaps: set by the cars worth reading (the top eight and the followed
  // team's recent laps), so a car a lap down or in the pits runs off the bottom instead of
  // squashing everyone. Places: one row per car.
  let cap: number;
  let ticks: number[];
  if (mode === "gaps") {
    const front = entries.map(([, pts]) => latest(pts)).filter(Number.isFinite).sort((a, b) => a - b).slice(0, 8);
    const watched = entries.filter(([car]) => ours.includes(car)).flatMap(([, pts]) => pts.slice(-6).map((p) => p[1]));
    const want = Math.max(10, ...front, ...watched) * 1.12;
    const every = step(want);
    cap = Math.ceil(want / every) * every;
    ticks = Array.from({ length: cap / every + 1 }, (_, i) => i * every);
  } else {
    cap = field;
    ticks = [1, 5, 10, 15, 20].filter((p) => p <= field);
  }
  const x = (l: number) => PAD.l + ((l - 1) / Math.max(lapsShown - 1, 1)) * (W - PAD.l - PAD.r);
  const y = mode === "gaps" ? (v: number) => PAD.t + (v / cap) * (H - PAD.t - PAD.b) : (p: number) => PAD.t + ((p - 1) / Math.max(cap - 1, 1)) * (H - PAD.t - PAD.b);
  const plotRight = W - PAD.r;
  const lapEvery = lapsShown <= 15 ? 1 : lapsShown <= 30 ? 5 : 10;
  const lapTicks = Array.from({ length: lapsShown }, (_, i) => i + 1).filter((l) => l === 1 || l % lapEvery === 0);
  const neutral = (strategy?.neutralised_laps ?? []).filter((l) => l <= lapsShown);
  const path = (pts: [number, number][]) => pts.map(([l, v]) => `${x(l).toFixed(1)},${y(v).toFixed(1)}`).join(" ");

  // The field behind the followed team: the front of it as quiet lines, the back as a faint band.
  const place = (car: string) => byCar.get(car)?.position ?? 99;
  const others = entries.filter(([car]) => !ours.includes(car));
  const front = others.filter(([car]) => place(car) <= READABLE);
  const back = others.filter(([car]) => place(car) > READABLE);
  const team_ = ours.map((car) => [car, series[car]] as const).filter((e): e is readonly [string, [number, number][]] => !!e[1]?.length);

  // Pit stops of the followed cars, with the change of tyres: "S→H".
  const stops = team_.flatMap(([car, pts]) => {
    const stints = strategy?.cars[car]?.stints ?? [];
    return stints.slice(1).flatMap((st, k) => {
      const at = pts.find(([l]) => l === st.lap_start - 1);
      if (!at || at[0] > lapsShown) return [];
      const from = TYRES[stints[k].compound]?.label ?? "?";
      const to = TYRES[st.compound]?.label ?? "?";
      return [{ car, lap: at[0], v: at[1], text: `${from}→${to}` }];
    });
  });

  // Labels at the line ends. Gaps: the followed cars, with place and gap. Places: every car, so
  // the chart reads like a running order; the followed cars stand out.
  const labelled = mode === "gaps" ? team_ : entries.map(([car, pts]) => [car, pts] as const);
  const labels = labelled
    .map(([car, pts]) => {
      const last = pts[pts.length - 1];
      const placeThen = mode === "places" ? last[1] : 1 + entries.filter(([, other]) => (other.find((p) => p[0] === last[0])?.[1] ?? Infinity) < last[1]).length;
      return { car, mine: ours.includes(car), place: placeThen, value: last[1], at: Math.min(y(last[1]), H - PAD.b - 4) + 3.5, lap: last[0] };
    })
    .sort((a, b) => a.at - b.at);
  const gapBetween = mode === "gaps" ? 14 : 0;
  for (let i = 1; i < labels.length; i++) labels[i].at = Math.max(labels[i].at, labels[i - 1].at + gapBetween);

  return (
    <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={mode === "gaps" ? "Gap to the leader per lap" : "Place per lap"} className={mode}>
      <defs>
        <clipPath id="trace-plot">
          <rect x={PAD.l} y={PAD.t - 6} width={plotRight - PAD.l + 2} height={H - PAD.t - PAD.b + 8} />
        </clipPath>
      </defs>
      {neutral.map((l) => (
        <rect key={l} x={x(l - 0.5)} width={x(2) - x(1)} y={PAD.t} height={H - PAD.t - PAD.b} className="sc-band" />
      ))}
      {ticks.map((t) => (
        <g key={`g${t}`}>
          <line x1={PAD.l} x2={plotRight} y1={y(t)} y2={y(t)} className={t === (mode === "gaps" ? 0 : 1) ? "grid zero" : "grid"} />
          <text x={PAD.l - 8} y={y(t) + 3.5} textAnchor="end" className="axis">
            {mode === "gaps" ? (t === 0 ? "P1" : `+${t}s`) : `P${t}`}
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
      {lap > 0 && lap <= lapsShown && <line x1={x(lap)} x2={x(lap)} y1={PAD.t} y2={H - PAD.b} className="now-line" />}
      <g clipPath="url(#trace-plot)">
        {back.map(([car, pts]) => (
          <polyline key={car} className="back" points={path(pts)} style={mode === "places" ? { stroke: teamColour(byCar.get(car)?.colour) } : undefined} />
        ))}
        {front.map(([car, pts]) => (
          <polyline key={car} className="theirs" points={path(pts)} style={mode === "places" ? { stroke: teamColour(byCar.get(car)?.colour) } : undefined} />
        ))}
        {team_.map(([car, pts]) => (
          <polyline key={car} className="mine" points={path(pts)} stroke={colourOf(car)} />
        ))}
        {stops.map((s) => (
          <g key={`${s.car}-${s.lap}`} className="stop">
            <circle cx={x(s.lap)} cy={y(s.v)} r={4.5} stroke={colourOf(s.car)} />
            <text x={x(s.lap)} y={y(s.v) - 9} textAnchor="middle" fill={colourOf(s.car)}>
              {s.text}
            </text>
          </g>
        ))}
      </g>
      {labels.map(({ car, mine, place: p, value, at, lap: l }) => {
        const info = byCar.get(car);
        return (
          <text key={car} x={x(Math.min(l, lapsShown)) + 9} y={at} className={mine ? "label mine" : "label"} fill={mine ? colourOf(car) : teamColour(info?.colour)}>
            {mode === "gaps" ? (
              <>
                P{p} {info?.code}
                <tspan className="label-gap" dx={6}>
                  {value < 0.05 ? "leads" : `+${value.toFixed(1)}`}
                </tspan>
              </>
            ) : (
              info?.code
            )}
          </text>
        );
      })}
    </svg>
  );
}
