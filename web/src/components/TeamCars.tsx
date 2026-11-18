import { lapTime, teamColour, TYRES } from "../format";
import { neighbours, rejoin } from "../strategy";
import type { Board, BoardCar, Strategy } from "../types";

/** One card per team car: where it is, who is around it, its pace, and the pit call. */
export function TeamCars({ board, cars, strategy }: { board: Board; cars: BoardCar[]; strategy: Strategy | null }) {
  if (cars.length === 0) return null;
  return (
    <div className="team-cars">
      {cars.map((c) => (
        <CarCard key={c.car} board={board} car={c} strategy={strategy} />
      ))}
    </div>
  );
}

function fmtGap(seconds: number | null | undefined): string {
  return seconds == null ? "–" : `${seconds.toFixed(1)} s`;
}

function CarCard({ board, car, strategy }: { board: Board; car: BoardCar; strategy: Strategy | null }) {
  const around = neighbours(board, car);
  const model = strategy?.cars[String(car.car)];
  const stint = model?.stints[model.stints.length - 1];
  const deg = model?.deg_ms_per_lap;
  const call = rejoin(board, car, strategy?.pit_loss_ms ?? null);
  const tyre = car.compound ? TYRES[car.compound] : null;
  return (
    <section className="panel car-card" style={{ "--team": teamColour(car.colour) } as React.CSSProperties} aria-label={car.name}>
      <header>
        <span className="big-pos mono">P{car.position ?? "–"}</span>
        <div>
          <h2>{car.name || car.code}</h2>
          <p className="dim small">
            #{car.car} · lap {car.lap}
            {car.in_pit && <span className="tag pit">IN PIT</span>}
          </p>
        </div>
      </header>

      <div className="around">
        <div>
          <span className="dim small">Ahead</span>
          <span className="mono">{around.ahead ? `${around.ahead.car.code} ${fmtGap(around.ahead.gap)}` : "Leading"}</span>
        </div>
        <div>
          <span className="dim small">Behind</span>
          <span className="mono">{around.behind ? `${around.behind.car.code} ${fmtGap(around.behind.gap)}` : "–"}</span>
        </div>
      </div>

      <div className="stats">
        <div>
          <span className="dim small">Last</span>
          <span className={`mono ${car.personal_best ? "green" : ""}`}>{lapTime(car.last_lap_ms)}</span>
        </div>
        <div>
          <span className="dim small">Best</span>
          <span className={`mono ${car.fastest_lap ? "purple" : ""}`}>{lapTime(car.best_lap_ms)}</span>
        </div>
        <div>
          <span className="dim small">Tyre</span>
          <span className="mono" style={{ color: tyre?.colour }}>
            {car.compound ? `${tyre?.label ?? "?"} · ${car.tyre_age} laps` : "–"}
          </span>
        </div>
        <div>
          <span className="dim small" title="Lap time change per lap on these tyres, from clean laps">
            Trend
          </span>
          <span className={`mono ${deg != null && deg > 0 ? "warn" : ""}`}>
            {deg == null ? `${stint?.clean_laps ?? 0} clean laps` : `${deg > 0 ? "+" : ""}${(deg / 1000).toFixed(2)} s/lap`}
          </span>
        </div>
      </div>

      <div className={`box-call${call?.neutralised ? " cheap" : ""}`}>
        <span className="label">Box this lap</span>
        {call ? (
          <span>
            Rejoin <b className="mono">P{call.position}</b>
            {call.ahead && (
              <>
                , {call.ahead.gap.toFixed(1)} s behind <b>{call.ahead.car.code}</b>
              </>
            )}
            {call.behind && (
              <>
                , {call.behind.gap.toFixed(1)} s ahead of <b>{call.behind.car.code}</b>
              </>
            )}
            <span className="dim small">
              {" "}
              · loss {call.lossSeconds.toFixed(1)} s{call.neutralised ? " (cheap stop under SC/VSC)" : ""}
            </span>
          </span>
        ) : (
          <span className="dim">Needs a pit-loss estimate (after the first stops) and a timed gap.</span>
        )}
      </div>
    </section>
  );
}
