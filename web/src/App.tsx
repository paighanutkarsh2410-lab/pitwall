import { useEffect, useMemo, useRef, useState } from "react";
import { RaceControl } from "./components/RaceControl";
import { RaceLibrary } from "./components/RaceLibrary";
import { RaceTrace } from "./components/RaceTrace";
import { StrategyPanel } from "./components/StrategyPanel";
import { TeamCars } from "./components/TeamCars";
import { TelemetryCompare } from "./components/TelemetryCompare";
import { TimingScreen } from "./components/TimingScreen";
import { TrackMap } from "./components/TrackMap";
import { onColour, raceClock, teamColour, TRACK_STATUS } from "./format";
import { teamCars, teams } from "./strategy";
import type { Replay } from "./types";
import { DRIVER, RACE, RECORDING, type Playback } from "./recording";
import { useLive } from "./useLive";

const TEAM_KEY = "pitwall.team";

function savedTeam(): string | null {
  try {
    return localStorage.getItem(TEAM_KEY);
  } catch {
    return null;
  }
}

async function replayCall(method: string, body?: object): Promise<Replay> {
  const r = await fetch("/api/replay", {
    method,
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  return r.json();
}

export function App() {
  const [team, setTeam] = useState<string | null>(savedTeam);
  // A car clicked in the timing screen or on the map: compared with the team's lead car.
  const [focus, setFocus] = useState<number | null>(null);
  const [logos, setLogos] = useState<Record<string, string>>({});
  const [replay, setReplay] = useState<Replay>({ state: "idle" });
  const [library, setLibrary] = useState(false);
  const [watch, setWatch] = useState<number[]>([]);
  const live = useLive(watch);
  const { board, strategy } = live;

  useEffect(() => {
    if (RECORDING) return; // the public site has no API: no logos, no replay to poll
    fetch("/api/logos")
      .then((r) => (r.ok ? r.json() : {}))
      .then(setLogos)
      .catch(() => undefined);
    const poll = () => replayCall("GET").then(setReplay).catch(() => undefined);
    poll();
    const timer = window.setInterval(poll, 2000);
    return () => window.clearInterval(timer);
  }, [setLogos, setReplay]);

  const allTeams = useMemo(() => (board ? teams(board) : []), [board]);
  // Default to a team in the race (Red Bull if it's there), and remember the choice. On the public
  // site, a driver chosen on the home page (?driver=4) decides it instead, once, and is followed.
  const followed = useRef(false);
  useEffect(() => {
    if (!allTeams.length || !board) return;
    if (RECORDING && DRIVER && !followed.current) {
      const car = board.cars.find((c) => c.car === DRIVER);
      if (car) {
        followed.current = true;
        setTeam(car.team);
        setFocus(null);
        return;
      }
    }
    if (!team || !allTeams.some((t) => t.team === team)) {
      setTeam(allTeams.find((t) => t.team.startsWith("Red Bull"))?.team ?? allTeams[0].team);
    }
  }, [allTeams, team, setTeam, board]);
  useEffect(() => {
    try {
      if (team) localStorage.setItem(TEAM_KEY, team);
    } catch {
      /* private mode: the choice just isn't remembered */
    }
  }, [team]);

  const ours = board ? teamCars(board, team) : [];
  const compared = useMemo(() => {
    if (!board) return [];
    // The driver chosen on the home page leads the comparison; otherwise the team's first car.
    const first = ours.find((c) => c.car === DRIVER) ?? ours[0];
    const other = focus != null ? board.cars.find((c) => c.car === focus && c.car !== first?.car) : ours[1];
    return [first, other].filter((c): c is NonNullable<typeof c> => c != null);
  }, [board, ours, focus]);
  const watchKey = compared.map((c) => c.car).join(",");
  useEffect(() => {
    setWatch(watchKey ? watchKey.split(",").map(Number) : []);
  }, [watchKey]);

  const accent = ours[0] ? teamColour(ours[0].colour) : RECORDING ? "#e10600" : "#e8ff4a";
  const status = TRACK_STATUS[board?.track ?? "PRE_RACE"] ?? TRACK_STATUS.PRE_RACE;
  const playing = ["playing", "downloading", "starting"].includes(replay.state);

  const start = async (race: string, lap: number, speed: number) => {
    setLibrary(false);
    setReplay(await replayCall("POST", { race, speed, from_lap: lap }));
  };

  return (
    <div className="app" style={{ "--accent": accent, "--on-accent": onColour(accent) } as React.CSSProperties}>
      <header className="top">
        <div className="brand">
          <span className="mark" aria-hidden>
            ▚
          </span>
          Pitwall
        </div>
        {RECORDING && (
          <nav className="site-tabs" aria-label="Site">
            <a href="../">Home</a>
            <a href="./" aria-current="page">
              Pit wall
            </a>
            <a href="../engineering/">Engineering</a>
          </nav>
        )}
        <label className="team-pick">
          <span className="dim small">Team</span>
          <select value={team ?? ""} onChange={(e) => setTeam(e.target.value)} aria-label="Team">
            {allTeams.map((t) => (
              <option key={t.team} value={t.team}>
                {t.team}
              </option>
            ))}
          </select>
        </label>
        <div className="race">
          <h1>{board?.session?.name ?? (RECORDING && !RACE ? "No race chosen" : "No race running")}</h1>
          <span className="dim small">
            {board?.session ? `${board.session.circuit} · ${board.session.year} · Race` : RECORDING ? "Choose a race on the home page" : "Open the race library to start one"}
            {RECORDING && board?.session && (
              <>
                {" · "}
                <a className="change-race" href={`../?race=${RACE}`}>
                  Change race
                </a>
              </>
            )}
          </span>
        </div>
        {board && (
          <div className="race-state">
            <div className="lap-count">
              <span className="dim small">LAP</span>
              <span className="mono">
                {board.lap}
                <span className="dim">/{board.laps ?? "–"}</span>
              </span>
            </div>
            <span className={`status ${status.tone}`}>{status.label}</span>
            {board.weather && (
              <div className="weather small">
                <span className={board.weather.rainfall ? "rain" : ""}>{board.weather.rainfall ? "RAIN" : "DRY"}</span>
                <span>Air {board.weather.air_c.toFixed(1)}°</span>
                <span>Track {board.weather.track_c.toFixed(1)}°</span>
                <span>Hum {board.weather.humidity.toFixed(0)}%</span>
                <span>Wind {board.weather.wind_ms.toFixed(1)} m/s</span>
              </div>
            )}
            <span className="mono clock" title="Race time from the scheduled start">
              {raceClock(board.t)}
            </span>
          </div>
        )}
        {RECORDING && !RACE ? null : RECORDING && live.playback ? (
          <RecordingControls playback={live.playback} />
        ) : (
        <div className="transport">
          <span className={`replay-state ${replay.state}`} title={replay.detail}>
            {replay.state === "downloading" ? "Downloading" : replay.state}
          </span>
          {playing && (
            <div className="toggle" role="group" aria-label="Speed">
              {[1, 5, 10, 20].map((s) => (
                <button key={s} aria-pressed={replay.speed === s} onClick={async () => setReplay(await replayCall("PATCH", { speed: s }))}>
                  {s}×
                </button>
              ))}
            </div>
          )}
          <button className="primary" onClick={() => setLibrary(true)}>
            Races
          </button>
          <span className={`link ${live.connected ? "up" : "down"}`} title={live.connected ? "Live" : "Reconnecting"} />
        </div>
        )}
      </header>

      {board && board.cars.length > 0 ? (
        <main className="wall">
          <TimingScreen board={board} team={team} onSelect={(c) => setFocus(c === focus ? null : c)} logos={logos} />
          <TrackMap board={board} track={live.track} positions={live.positions} team={team} focus={focus} onSelect={setFocus} />
          <div className="side">
            <TeamCars board={board} cars={ours} strategy={strategy} />
          </div>
          <RaceTrace board={board} team={team} run={board.run} />
          <TelemetryCompare cars={compared} samples={live.samples} />
          <StrategyPanel board={board} strategy={strategy} team={team} />
          <RaceControl messages={board.messages} />
        </main>
      ) : (
        <main className="waiting">
          <p>{RECORDING ? (RACE ? "Loading the recording…" : "No race chosen yet.") : live.connected ? "No race on the wall yet." : "Connecting to the pit wall…"}</p>
          {RECORDING && !RACE && (
            <a className="primary choose-race" href="../">
              Choose a race
            </a>
          )}
          {live.connected && !RECORDING && (
            <button className="primary" onClick={() => setLibrary(true)}>
              Open the race library
            </button>
          )}
        </main>
      )}

      {library && !RECORDING && <RaceLibrary onClose={() => setLibrary(false)} onStart={start} />}

      <footer className="foot dim small">
        Unofficial personal project, not associated with Formula 1, the FIA or any team. Team colours and names are race data;
        no team branding is used. Data from OpenF1.
      </footer>
    </div>
  );
}

/** The public site's transport: a recording of a real race, played at the chosen speed. */
function RecordingControls({ playback }: { playback: Playback }) {
  const { playing, speed, lap, laps, buffering } = playback;
  return (
    <div className="transport">
      <span className={`replay-state ${buffering ? "downloading" : playing ? "playing" : "stopped"}`} title="A recording of the race, replayed through Pitwall's own code">
        {buffering ? "Loading" : "Recording"}
      </span>
      <button onClick={playback.toggle} aria-pressed={!playing}>
        {playing ? "Pause" : "Play"}
      </button>
      <div className="toggle" role="group" aria-label="Speed">
        {[1, 5, 10, 20].map((s) => (
          <button key={s} aria-pressed={speed === s} onClick={() => playback.setSpeed(s)}>
            {s}×
          </button>
        ))}
      </div>
      <label className="seek small">
        <span className="dim">Lap</span>
        <input
          type="range"
          min={1}
          max={laps}
          value={Math.max(1, lap)}
          onChange={(e) => playback.seekLap(Number(e.target.value))}
          aria-label="Jump to lap"
        />
      </label>
    </div>
  );
}
