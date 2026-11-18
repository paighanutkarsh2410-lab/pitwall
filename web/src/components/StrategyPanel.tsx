import { lapTime, teamColour, TYRES } from "../format";
import type { Board, Strategy } from "../types";

/** Every car's stints laid along the race, with the current stint's tyre trend. */
export function StrategyPanel({ board, strategy, selected }: { board: Board; strategy: Strategy | null; selected: number | null }) {
  const total = Math.max(board.laps ?? 0, board.lap, 1);
  return (
    <section className="panel strategy" aria-label="Tyre strategy">
      <header className="panel-head">
        <h2>Strategy</h2>
        <span className="dim small">
          Pit loss {strategy?.pit_loss_ms ? `${(strategy.pit_loss_ms / 1000).toFixed(1)} s` : "–"}
        </span>
      </header>
      <div className="stints">
        {board.cars.map((c) => {
          const s = strategy?.cars[String(c.car)];
          const deg = s?.deg_ms_per_lap;
          return (
            <div key={c.car} className={`stint-row${c.car === selected ? " selected" : ""}`}>
              <span className="code small" style={{ borderColor: teamColour(c.colour) }}>
                {c.code}
              </span>
              <div className="stint-track">
                {(s?.stints ?? []).map((st) => {
                  const end = st.lap_end ?? board.lap;
                  const tyre = TYRES[st.compound];
                  return (
                    <span
                      key={st.stint}
                      className="stint"
                      style={{
                        left: `${((st.lap_start - 1) / total) * 100}%`,
                        width: `${(Math.max(end - st.lap_start + 1, 0.5) / total) * 100}%`,
                        background: tyre?.colour ?? "#666",
                      }}
                      title={`${st.compound} laps ${st.lap_start}–${end}, pace ${lapTime(st.pace_ms)}`}
                    />
                  );
                })}
                <span className="now" style={{ left: `${(board.lap / total) * 100}%` }} />
              </div>
              <span className="mono small deg" title="Lap time change per lap on this set of tyres">
                {deg == null ? "" : `${deg > 0 ? "+" : ""}${(deg / 1000).toFixed(2)}s`}
              </span>
            </div>
          );
        })}
      </div>
      <p className="dim small note">
        Trend per lap on the current tyres, from clean laps only. Negative means the car is getting faster: a drying
        track or falling fuel load.
      </p>
    </section>
  );
}
