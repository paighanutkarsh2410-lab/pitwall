import { useEffect, useState } from "react";
import type { RaceOnDisk, Replay } from "../types";

const SPEEDS = [1, 5, 10, 20, 50];

async function call(method: string, body?: object): Promise<Replay> {
  const response = await fetch("/api/replay", {
    method,
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  return response.json();
}

/** Start a race, change speed while it plays, or stop it. */
export function ReplayControls() {
  const [races, setRaces] = useState<RaceOnDisk[]>([]);
  const [replay, setReplay] = useState<Replay>({ state: "idle" });
  const [race, setRace] = useState("2024-sao-paulo");
  const [lap, setLap] = useState(1);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    fetch("/api/races")
      .then((r) => (r.ok ? r.json() : []))
      .then((list: RaceOnDisk[]) => {
        setRaces(list);
        if (list.length && !list.some((r) => r.race === race)) setRace(list[0].race);
      })
      .catch(() => undefined);
    const poll = () => call("GET").then(setReplay).catch(() => undefined);
    poll();
    const timer = window.setInterval(poll, 2000);
    return () => window.clearInterval(timer);
  }, []);

  const playing = replay.state === "playing" || replay.state === "downloading" || replay.state === "starting";
  const speed = replay.speed ?? 10;

  const act = async (fn: () => Promise<Replay>) => {
    setBusy(true);
    try {
      setReplay(await fn());
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="replay" aria-label="Replay controls">
      <select value={race} onChange={(e) => setRace(e.target.value)} aria-label="Race" disabled={busy}>
        {races.length === 0 && <option value="2024-sao-paulo">2024 São Paulo</option>}
        {races.map((r) => (
          <option key={r.race} value={r.race}>
            {r.year} {r.name.replace(" Grand Prix", "")}
          </option>
        ))}
      </select>
      <label className="lap-input">
        <span className="dim small">from lap</span>
        <input type="number" min={1} value={lap} onChange={(e) => setLap(Math.max(1, Number(e.target.value) || 1))} />
      </label>
      <div className="toggle speeds" role="group" aria-label="Speed">
        {SPEEDS.map((s) => (
          <button
            key={s}
            aria-pressed={speed === s}
            disabled={busy}
            onClick={() => act(() => (playing ? call("PATCH", { speed: s }) : call("POST", { race, speed: s, from_lap: lap })))}
          >
            {s}×
          </button>
        ))}
      </div>
      <button className="primary" disabled={busy} onClick={() => act(() => call("POST", { race, speed, from_lap: lap }))}>
        {playing ? "Restart" : "Start"}
      </button>
      {playing && (
        <button disabled={busy} onClick={() => act(() => call("DELETE"))}>
          Stop
        </button>
      )}
      <span className={`replay-state ${replay.state}`} title={replay.detail}>
        {replay.state === "downloading" ? "Downloading race…" : replay.state}
      </span>
    </div>
  );
}
