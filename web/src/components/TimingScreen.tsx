import { useState } from "react";
import { gap, lapTime, sector, TYRES } from "../format";
import type { Board } from "../types";
import { TeamMark } from "./TeamMark";

/** The full timing screen, the way team timing monitors lay it out. */
export function TimingScreen({
  board,
  team,
  onSelect,
  logos,
}: {
  board: Board;
  team: string | null;
  onSelect: (car: number) => void;
  logos: Record<string, string>;
}) {
  const [mode, setMode] = useState<"interval" | "leader">("interval");
  return (
    <section className="panel timing" aria-label="Timing">
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
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th className="num">P</th>
              <th className="num" title="Places gained since the start">
                ±
              </th>
              <th>Driver</th>
              <th className="num">{mode === "interval" ? "Int" : "Gap"}</th>
              <th className="num">Last</th>
              <th className="num">S1</th>
              <th className="num">S2</th>
              <th className="num">S3</th>
              <th className="num">Best</th>
              <th>Tyre</th>
              <th className="num" title="Pit stops">
                Pit
              </th>
            </tr>
          </thead>
          <tbody>
            {board.cars.map((c) => {
              const tyre = c.compound ? TYRES[c.compound] : null;
              const ours = team != null && c.team === team;
              const moved = c.start_position != null && c.position != null ? c.start_position - c.position : null;
              const lapClass = c.fastest_lap && c.personal_best ? "purple" : c.personal_best ? "green" : "";
              return (
                <tr
                  key={c.car}
                  className={ours ? "ours" : undefined}
                  style={ours ? ({ "--team": `#${c.colour ?? "888"}` } as React.CSSProperties) : undefined}
                  onClick={() => onSelect(c.car)}
                >
                  <td className="num pos">{c.position ?? "–"}</td>
                  <td className={`num small moved ${moved && moved > 0 ? "up" : moved && moved < 0 ? "down" : ""}`}>
                    {moved ? `${moved > 0 ? "▲" : "▼"}${Math.abs(moved)}` : ""}
                  </td>
                  <td className="driver">
                    <TeamMark team={c.team} colour={c.colour} logos={logos} />
                    <span className="mono dim no">{c.car}</span>
                    <span className="code">{c.code}</span>
                    {c.in_pit && <span className="tag pit">PIT</span>}
                  </td>
                  <td className="num mono">{gap(mode === "interval" ? c.interval : c.gap_to_leader, c.position === 1)}</td>
                  <td className={`num mono ${lapClass}`}>{lapTime(c.last_lap_ms)}</td>
                  {[0, 1, 2].map((i) => (
                    <td key={i} className={`num mono sector ${c.sector_status?.[i] ?? ""}`}>
                      {sector(c.sectors_ms[i])}
                    </td>
                  ))}
                  <td className={`num mono ${c.fastest_lap ? "purple" : ""}`}>{lapTime(c.best_lap_ms)}</td>
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
      </div>
    </section>
  );
}
