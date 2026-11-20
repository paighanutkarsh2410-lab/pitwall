import { lapTime, teamColour, TYRES } from "../format";
import { pitWindow } from "../strategy";
import type { Board, Strategy } from "../types";

/**
 * Every car's race on tyres, in race order: one bar per set, the compound marked where the set
 * went on, a gap where the car stopped, and a hatched band where a stop would start to pay on the
 * tyres it has on now. Then the set on now, its age, and the lap-time trend on it. Before the
 * start, the tyres each car starts on.
 */
export function StrategyPanel({
  board,
  strategy,
  team,
  startTyres,
}: {
  board: Board;
  strategy: Strategy | null;
  team: string | null;
  startTyres: Record<string, string | null> | undefined;
}) {
  const total = Math.max(board.laps ?? 0, board.lap, 1);
  const every = total > 40 ? 10 : 5;
  const ticks = Array.from({ length: Math.floor(total / every) }, (_, i) => (i + 1) * every).filter((l) => l <= total - every * 0.5);
  const pct = (lap: number) => `${((lap - 1) / total) * 100}%`;
  const cars = [...board.cars].sort((a, b) => (a.position ?? a.start_position ?? 99) - (b.position ?? b.start_position ?? 99));
  const half = Math.ceil(cars.length / 2);
  const columns = [cars.slice(0, half), cars.slice(half)];
  const started = board.lap >= 1;
  const loss = strategy?.pit_loss_ms;

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
        <span className="dim small key">
          {loss ? `Pit loss ${(loss / 1000).toFixed(1)} s` : "Pit loss after the first stops"}
          <span className="window-key" /> stop pays · trend s/lap
        </span>
      </header>
      <div className="stints">
        {columns.map((col, k) => (
          <div key={k} className="stint-col">
            {scale}
            {col.map((c) => {
              const s = strategy?.cars[String(c.car)];
              const deg = s?.deg_ms_per_lap;
              const stints = s?.stints ?? [];
              const current = stints[stints.length - 1];
              // The window is for the set on now (the last stint; the feed closes it at the current lap).
              const found = started && !c.in_pit && board.lap < total - 3 ? pitWindow(current, deg, loss, total) : null;
              const window = found && found[1] > board.lap ? ([Math.max(found[0], board.lap + 1), found[1]] as [number, number]) : null;
              const compound = started ? c.compound : (startTyres?.[String(c.car)] ?? c.compound);
              const now = TYRES[compound ?? ""];
              return (
                <div key={c.car} className={`stint-row${team != null && c.team === team ? " ours" : ""}`}>
                  <span className="code small" style={{ borderColor: teamColour(c.colour) }}>
                    <span className="pos">{c.position ?? c.start_position ?? "–"}</span>
                    {c.code}
                  </span>
                  <div className="stint-track">
                    {ticks.map((l) => (
                      <span key={l} className="gridline" style={{ left: pct(l) }} />
                    ))}
                    {window && (
                      <span
                        className="window"
                        style={{ left: pct(window[0]), width: `${((window[1] - window[0] + 1) / total) * 100}%` }}
                        title={`A stop starts to pay around laps ${window[0]}–${window[1]}`}
                      />
                    )}
                    {stints.map((st) => {
                      const end = st.lap_end ?? board.lap;
                      const tyre = TYRES[st.compound];
                      const laps = Math.max(end - st.lap_start + 1, 0.5);
                      return (
                        <span
                          key={st.stint}
                          className={`stint ${st.compound.toLowerCase()}`}
                          style={{ left: pct(st.lap_start), width: `${(laps / total) * 100}%`, "--tyre": tyre?.colour ?? "#666" } as React.CSSProperties}
                          title={`${st.compound}, laps ${st.lap_start}–${end}, pace ${lapTime(st.pace_ms)}`}
                        >
                          {laps / total > 0.045 ? tyre?.label : ""}
                        </span>
                      );
                    })}
                    {started && <span className="now" style={{ left: pct(board.lap + 1) }} />}
                  </div>
                  <span className="tyre-now small" title={compound ?? undefined}>
                    {now ? (
                      <span className="tyre-chip" style={{ color: now.colour, borderColor: now.colour }}>
                        {now.label}
                      </span>
                    ) : (
                      <span className="tyre-chip unknown">?</span>
                    )}
                    <span className="mono dim">{started ? (c.tyre_age ?? "–") : "new"}</span>
                  </span>
                  <span className={`mono small deg${deg != null && deg < 0 ? " faster" : deg != null && deg > 80 ? " wearing" : ""}`}>
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
