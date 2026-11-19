import { lapTime, teamColour, TYRES } from "../format";
import type { Board, Strategy } from "../types";

/**
 * Every car's stints laid along the race, in race order: one bar per set of tyres, marked with
 * the compound, with the tyres on now and their age, and the lap-time trend on them.
 */
export function StrategyPanel({ board, strategy, team }: { board: Board; strategy: Strategy | null; team: string | null }) {
  const total = Math.max(board.laps ?? 0, board.lap, 1);
  const every = total > 40 ? 10 : 5;
  const ticks = Array.from({ length: Math.floor(total / every) }, (_, i) => (i + 1) * every).filter((l) => l <= total - every * 0.5);
  const pct = (lap: number) => `${((lap - 1) / total) * 100}%`;
  const cars = [...board.cars].sort((a, b) => (a.position ?? 99) - (b.position ?? 99));
  const half = Math.ceil(cars.length / 2);
  const columns = [cars.slice(0, half), cars.slice(half)];

  const scale = (
    <div className="stint-row stint-scale" aria-hidden>
      <span />
      <div className="stint-track">
        <span className="tick" style={{ left: "0%" }}>
          1
        </span>
        {ticks.map((l) => (
          <span key={l} className="tick" style={{ left: pct(l) }}>
            {l}
          </span>
        ))}
        <span className="tick end">{total}</span>
      </div>
      <span className="small dim">Tyre</span>
      <span className="small dim deg" title="Lap-time change per lap on the current tyres, from clean laps">
        Trend
      </span>
    </div>
  );

  return (
    <section className="panel strategy" aria-label="Tyre strategy">
      <header className="panel-head">
        <h2>Strategy</h2>
        <span className="dim small">
          Pit loss {strategy?.pit_loss_ms ? `${(strategy.pit_loss_ms / 1000).toFixed(1)} s` : "–"} · trend: seconds per lap on these tyres
        </span>
      </header>
      <div className="stints">
        {columns.map((col, k) => (
          <div key={k} className="stint-col">
            {scale}
            {col.map((c) => {
              const s = strategy?.cars[String(c.car)];
              const deg = s?.deg_ms_per_lap;
              const now = TYRES[c.compound ?? ""];
              return (
                <div key={c.car} className={`stint-row${team != null && c.team === team ? " ours" : ""}`}>
                  <span className="code small" style={{ borderColor: teamColour(c.colour) }}>
                    <span className="pos">{c.position ?? "–"}</span>
                    {c.code}
                  </span>
                  <div className="stint-track">
                    {ticks.map((l) => (
                      <span key={l} className="gridline" style={{ left: pct(l) }} />
                    ))}
                    {(s?.stints ?? []).map((st) => {
                      const end = st.lap_end ?? board.lap;
                      const tyre = TYRES[st.compound];
                      const laps = Math.max(end - st.lap_start + 1, 0.5);
                      return (
                        <span
                          key={st.stint}
                          className="stint"
                          style={{ left: pct(st.lap_start), width: `${(laps / total) * 100}%`, background: tyre?.colour ?? "#666" }}
                          title={`${st.compound}, laps ${st.lap_start}–${end}, pace ${lapTime(st.pace_ms)}`}
                        >
                          {laps / total > 0.06 ? tyre?.label : ""}
                        </span>
                      );
                    })}
                    <span className="now" style={{ left: pct(board.lap + 1) }} />
                  </div>
                  <span className="tyre-now small" title={c.compound ?? undefined}>
                    {now && (
                      <span className="tyre-chip" style={{ color: now.colour, borderColor: now.colour }}>
                        {now.label}
                      </span>
                    )}
                    <span className="mono dim">{c.tyre_age ?? "–"}</span>
                  </span>
                  <span className={`mono small deg${deg != null && deg < 0 ? " faster" : ""}`}>
                    {deg == null ? "–" : `${deg > 0 ? "+" : ""}${(deg / 1000).toFixed(2)}`}
                  </span>
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </section>
  );
}
