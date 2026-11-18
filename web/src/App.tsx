import { useEffect, useState } from "react";
import { CarPanel } from "./components/CarPanel";
import { RaceControl } from "./components/RaceControl";
import { ReplayControls } from "./components/ReplayControls";
import { StrategyPanel } from "./components/StrategyPanel";
import { TimingTower } from "./components/TimingTower";
import { TrackMap } from "./components/TrackMap";
import { raceClock, TRACK_STATUS } from "./format";
import { useLive } from "./useLive";

export function App() {
  const [selected, setSelected] = useState<number | null>(null);
  const [logos, setLogos] = useState<Record<string, string>>({});
  const live = useLive(selected);
  const { board } = live;

  useEffect(() => {
    fetch("/api/logos")
      .then((r) => (r.ok ? r.json() : {}))
      .then(setLogos)
      .catch(() => undefined);
  }, []);

  // Watch the leader until someone picks a car.
  useEffect(() => {
    if (selected == null && board?.cars[0]?.position) setSelected(board.cars[0].car);
  }, [board, selected]);

  const car = board?.cars.find((c) => c.car === selected) ?? null;
  const status = TRACK_STATUS[board?.track ?? "PRE_RACE"] ?? TRACK_STATUS.PRE_RACE;

  return (
    <div className="app">
      <header className="top">
        <div className="brand">
          <span className="mark" aria-hidden>
            ▚
          </span>
          <span>Pitwall</span>
        </div>
        {board?.session ? (
          <div className="race">
            <h1>{board.session.name}</h1>
            <span className="dim">
              {board.session.circuit} · {board.session.year}
            </span>
          </div>
        ) : (
          <div className="race">
            <h1>No race running</h1>
            <span className="dim">Start a replay to fill the pit wall.</span>
          </div>
        )}
        {board && (
          <div className="race-state">
            <div className="lap-count">
              <span className="dim small">Lap</span>
              <span className="mono">
                {board.lap}
                <span className="dim">/{board.laps ?? "–"}</span>
              </span>
            </div>
            <span className={`status ${status.tone}`}>{status.label}</span>
            {board.weather && (
              <span className="weather small" title={`Humidity ${board.weather.humidity}%`}>
                {board.weather.rainfall ? "Rain · " : ""}Air {board.weather.air_c.toFixed(0)}° · Track{" "}
                {board.weather.track_c.toFixed(0)}°
              </span>
            )}
            <span className="mono dim clock" title="Race time from the scheduled start">
              {raceClock(board.t)}
            </span>
          </div>
        )}
        <span className={`link ${live.connected ? "up" : "down"}`} title={live.connected ? "Live" : "Reconnecting"} />
      </header>

      <ReplayControls />

      {board && board.cars.length > 0 ? (
        <main className="wall">
          <TimingTower board={board} selected={selected} onSelect={setSelected} logos={logos} />
          <TrackMap board={board} track={live.track} positions={live.positions} selected={selected} onSelect={setSelected} />
          <div className="side">
            {car && <CarPanel car={car} samples={live.samplesCar === car.car ? live.samples : []} run={board.run} />}
            <RaceControl messages={board.messages} />
          </div>
          <StrategyPanel board={board} strategy={live.strategy} selected={selected} />
        </main>
      ) : (
        <main className="waiting">
          <p>{live.connected ? "Waiting for a race. Pick one above and press Start." : "Connecting to the pit wall…"}</p>
        </main>
      )}

      <footer className="foot dim small">
        Unofficial personal project, not associated with Formula 1, the FIA or any team. Data from OpenF1.
      </footer>
    </div>
  );
}
