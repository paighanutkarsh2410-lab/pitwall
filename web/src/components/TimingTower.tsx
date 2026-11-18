import { useState } from "react";
import { gap, lapTime, TYRES } from "../format";
import type { Board } from "../types";
import { TeamMark } from "./TeamMark";

export function TimingTower({
  board,
  selected,
  onSelect,
  logos,
}: {
  board: Board;
  selected: number | null;
  onSelect: (car: number) => void;
  logos: Record<string, string>;
}) {
  const [mode, setMode] = useState<"interval" | "leader">("interval");
  return (
    <section className="panel tower" aria-label="Timing tower">
      <header className="panel-head">
        <h2>Timing</h2>
        <div className="toggle" role="group" aria-label="Gap shown">
          <button aria-pressed={mode === "interval"} onClick={() => setMode("interval")}>
            Interval
          </button>
          <button aria-pressed={mode === "leader"} onClick={() => setMode("leader")}>
            Leader
          </button>
        </div>
      </header>
      <table>
        <thead>
          <tr>
            <th className="num">P</th>
            <th>Driver</th>
            <th className="num">{mode === "interval" ? "Int" : "Gap"}</th>
            <th className="num">Last lap</th>
            <th>Tyre</th>
            <th className="num" title="Pit stops">
              Pit
            </th>
          </tr>
        </thead>
        <tbody>
          {board.cars.map((c) => {
            const tyre = c.compound ? TYRES[c.compound] : null;
            const leader = c.position === 1;
            const lapClass = c.fastest_lap && c.personal_best ? "fastest" : c.personal_best ? "pb" : "";
            return (
              <tr
                key={c.car}
                className={c.car === selected ? "selected" : undefined}
                onClick={() => onSelect(c.car)}
                tabIndex={0}
                onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && onSelect(c.car)}
                aria-selected={c.car === selected}
              >
                <td className="num pos">{c.position ?? "–"}</td>
                <td className="driver">
                  <TeamMark team={c.team} colour={c.colour} logos={logos} />
                  <span className="code">{c.code}</span>
                  {c.in_pit && <span className="tag pit">PIT</span>}
                  {c.fastest_lap && <span className="tag fl" title="Fastest lap">FL</span>}
                </td>
                <td className="num mono">{gap(mode === "interval" ? c.interval : c.gap_to_leader, leader)}</td>
                <td className={`num mono ${lapClass}`}>{lapTime(c.last_lap_ms)}</td>
                <td>
                  {tyre ? (
                    <span className="tyre" title={`${c.compound}, ${c.tyre_age} laps`}>
                      <span className="tyre-dot" style={{ borderColor: tyre.colour, color: tyre.colour }}>
                        {tyre.label}
                      </span>
                      <span className="mono dim">{c.tyre_age}</span>
                    </span>
                  ) : (
                    <span className="dim">–</span>
                  )}
                </td>
                <td className="num mono dim">{c.pits || ""}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}
