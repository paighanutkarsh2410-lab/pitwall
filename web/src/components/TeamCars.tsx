import { lapTime, pairColours, teamColour, TYRES } from "../format";
import { DRIVER } from "../recording";
import { gapSeconds, neighbours, rejoin } from "../strategy";
import type { Board, BoardCar, Strategy } from "../types";

/** One card per team car: where it is, who is around it, its pace, and the pit call. */
export function TeamCars({ board, cars, strategy }: { board: Board; cars: BoardCar[]; strategy: Strategy | null }) {
  if (cars.length === 0) return null;
  // On a recording opened for one driver (?driver=), that driver's card leads; the rest keep order.
  const ordered = DRIVER == null ? cars : [...cars].sort((a, b) => Number(b.car === DRIVER) - Number(a.car === DRIVER));
  return (
    <div className="team-cars">
      {ordered.map((c) => (
        <CarCard key={c.car} board={board} car={c} strategy={strategy} />
      ))}
      {ordered.length === 2 && <HeadToHead board={board} cars={ordered} />}
    </div>
  );
}

/**
 * The team's two cars against each other: who is ahead and by how much, and their last lap,
 * best lap, tyres and stops side by side, the better of each marked.
 */
function HeadToHead({ board, cars }: { board: Board; cars: BoardCar[] }) {
  const [a, b] = cars;
  const ink = pairColours(cars);
  const ga = gapSeconds(a);
  const gb = gapSeconds(b);
  const ahead = (a.position ?? 99) <= (b.position ?? 99) ? a : b;
  const between = ga != null && gb != null ? Math.abs(ga - gb) : null;
  const rows: { label: string; values: [string, string]; better: 0 | 1 | null }[] = [
    { label: "Last", values: [lapTime(a.last_lap_ms), lapTime(b.last_lap_ms)], better: faster(a.last_lap_ms, b.last_lap_ms) },
    { label: "Best", values: [lapTime(a.best_lap_ms), lapTime(b.best_lap_ms)], better: faster(a.best_lap_ms, b.best_lap_ms) },
    {
      label: "Tyre",
      values: [a, b].map((c) => (c.compound ? `${TYRES[c.compound]?.label ?? "?"} · ${c.tyre_age ?? 0}` : "–")) as [string, string],
      better: null,
    },
    { label: "Stops", values: [String(a.pits), String(b.pits)], better: null },
  ];
  return (
    <section className="panel duel" aria-label="Head to head">
      <header className="panel-head">
        <h2>Head to head</h2>
        <span className="dim small">
          {board.lap < 1 ? "On the grid" : between == null ? "–" : `${ahead.code} ahead by ${between.toFixed(1)} s`}
        </span>
      </header>
      <div className="duel-grid">
        <span />
        {cars.map((c, i) => (
          <span key={c.car} className="duel-code" style={{ color: ink[i], borderColor: ink[i] }}>
            P{c.position ?? c.start_position ?? "–"} {c.code}
          </span>
        ))}
        {rows.map((r) => (
          <div key={r.label} className="duel-row">
            <span className="dim small">{r.label}</span>
            {r.values.map((v, i) => (
              <span key={i} className={`mono${r.better === i ? " better" : ""}`}>
                {v}
              </span>
            ))}
          </div>
        ))}
      </div>
    </section>
  );
}

/** Which of two lap times is quicker: 0, 1, or null when either is missing or they tie. */
function faster(a: number | null, b: number | null): 0 | 1 | null {
  if (a == null || b == null || a === b) return null;
  return a < b ? 0 : 1;
}

function fmtGap(seconds: number | null | undefined): string {
  return seconds == null ? "–" : `${seconds.toFixed(1)} s`;
}

function CarCard({ board, car, strategy }: { board: Board; car: BoardCar; strategy: Strategy | null }) {
  const around = neighbours(board, car);
  const model = strategy?.cars[String(car.car)];
  const stint = model?.stints[model.stints.length - 1];
  const deg = model?.deg_ms_per_lap;
  const call = board.lap >= 1 && !car.in_pit ? rejoin(board, car, strategy?.pit_loss_ms ?? null) : null;
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

      <PitCall board={board} car={car} call={call} />
    </section>
  );
}

/**
 * What a stop now would cost: where the car would rejoin and how many places that is. It is
 * marked only when it says something: amber for a cheap stop under a safety car or VSC, green
 * for a free one (no places lost). Otherwise it is information, not an instruction, and in the
 * last laps it gives way to "to the flag".
 */
function PitCall({ board, car, call }: { board: Board; car: BoardCar; call: ReturnType<typeof rejoin> }) {
  const left = board.laps != null ? board.laps - board.lap : null;
  if (board.lap < 1) return <div className="box-call quiet dim small">Pit calls from the first lap.</div>;
  if (car.in_pit) return <div className="box-call quiet small">In the pit lane.</div>;
  if (left != null && left <= 3) {
    return (
      <div className="box-call quiet small">
        <span className="label flag">To the flag</span>
        <span className="dim">{left === 0 ? "Final lap." : `${left} lap${left === 1 ? "" : "s"} to go: no stop.`}</span>
      </div>
    );
  }
  if (!call) return <div className="box-call quiet dim small">Pit loss known after the first stops.</div>;
  const lost = call.position - (car.position ?? call.position);
  const tone = call.neutralised ? "cheap" : lost <= 0 ? "free" : "";
  return (
    <div className={`box-call ${tone}`}>
      <span className="label">{call.neutralised ? "Cheap stop" : lost <= 0 ? "Free stop" : "If it pits now"}</span>
      <span>
        Rejoins <b className="mono">P{call.position}</b>
        <span className="dim">{lost > 0 ? ` (−${lost})` : ""}</span>
        {call.ahead && (
          <>
            , {call.ahead.gap.toFixed(1)} s behind <b>{call.ahead.car.code}</b>
          </>
        )}
        <span className="dim small"> · costs {call.lossSeconds.toFixed(1)} s</span>
      </span>
    </div>
  );
}
