import { useMemo } from "react";
import { teamColour } from "../format";
import type { Board, Track } from "../types";

const SIZE = 1000;
const PAD = 60;

type Fit = (x: number, y: number) => [number, number];

function makeFit(points: [number, number][]): Fit | null {
  if (points.length < 2) return null;
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  const [minX, maxX, minY, maxY] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const scale = (SIZE - 2 * PAD) / Math.max(maxX - minX, maxY - minY, 1);
  const offX = (SIZE - (maxX - minX) * scale) / 2;
  const offY = (SIZE - (maxY - minY) * scale) / 2;
  return (x, y) => [offX + (x - minX) * scale, SIZE - (offY + (y - minY) * scale)];
}

/** The circuit, traced from a car's own positions, with every car on it. */
export function TrackMap({
  board,
  track,
  positions,
  team,
  focus,
  onSelect,
}: {
  board: Board;
  track: Track | null;
  positions: Record<string, [number, number]>;
  team: string | null;
  focus: number | null;
  onSelect: (car: number) => void;
}) {
  // Fit the outline into the square (y pointing up); until it's traced, fit the cars instead.
  const outlineFit = useMemo(() => (track ? makeFit(track.points) : null), [track]);
  const fit = outlineFit ?? makeFit(Object.values(positions));

  const path = useMemo(() => {
    if (!outlineFit || !track) return null;
    const d = track.points.map(([x, y], i) => `${i ? "L" : "M"}${outlineFit(x, y).map((v) => v.toFixed(1)).join(" ")}`);
    return `${d.join(" ")} Z`;
  }, [outlineFit, track]);

  const ours = (carTeam: string) => team != null && carTeam === team;
  // Team cars and the focused car drawn last, on top of the field.
  const cars = [...board.cars].reverse().sort((a, b) => Number(ours(a.team) || a.car === focus) - Number(ours(b.team) || b.car === focus));
  return (
    <section className="panel map" aria-label="Track map">
      <header className="panel-head">
        <h2>{board.session?.circuit ?? "Circuit"}</h2>
        {!track && <span className="dim small">Tracing the circuit from the cars…</span>}
      </header>
      <svg viewBox={`0 0 ${SIZE} ${SIZE}`} role="img" aria-label="Cars on the circuit">
        {path && (
          <>
            <path d={path} className="track-edge" />
            <path d={path} className="track-surface" />
          </>
        )}
        {fit &&
          cars.map((c) => {
            const p = positions[String(c.car)];
            if (!p) return null;
            const [x, y] = fit(p[0], p[1]);
            const isOurs = ours(c.team);
            const isFocus = c.car === focus;
            return (
              <g
                key={c.car}
                className={`car-dot${isOurs ? " ours" : " field"}${isFocus ? " focus" : ""}${c.in_pit ? " in-pit" : ""}`}
                style={{ transform: `translate(${x}px, ${y}px)` }}
                onClick={() => onSelect(c.car)}
              >
                <circle r={isOurs || isFocus ? 17 : 11} fill={teamColour(c.colour)} />
                <text y={-22} textAnchor="middle">
                  {c.code}
                </text>
              </g>
            );
          })}
      </svg>
    </section>
  );
}
