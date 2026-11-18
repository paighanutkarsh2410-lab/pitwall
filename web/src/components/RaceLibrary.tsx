import { useCallback, useEffect, useState } from "react";
import type { CatalogRace } from "../types";

const YEARS = [2026, 2025, 2024, 2023].filter((y) => y <= new Date().getFullYear());

/** Every race OpenF1 has, by season: replay what's downloaded, download the rest. */
export function RaceLibrary({ onClose, onStart }: { onClose: () => void; onStart: (race: string, lap: number, speed: number) => void }) {
  const [year, setYear] = useState(YEARS[0]);
  const [races, setRaces] = useState<CatalogRace[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lap, setLap] = useState(1);
  const [speed, setSpeed] = useState(1);

  const load = useCallback(() => {
    fetch(`/api/catalog/${year}`)
      .then(async (r) => {
        if (!r.ok) throw new Error((await r.json()).detail ?? `HTTP ${r.status}`);
        return r.json();
      })
      .then((list: CatalogRace[]) => {
        setRaces(list);
        setError(null);
      })
      .catch((e: Error) => setError(e.message));
  }, [year]);

  useEffect(() => {
    setRaces(null);
    load();
  }, [load]);

  // While something downloads, keep its progress fresh.
  useEffect(() => {
    if (!races?.some((r) => r.state === "queued" || r.state === "downloading")) return;
    const timer = window.setInterval(load, 2000);
    return () => window.clearInterval(timer);
  }, [races, load]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const download = async (race: string) => {
    await fetch("/api/downloads", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ race }) });
    load();
  };

  return (
    <div className="overlay" role="dialog" aria-modal="true" aria-label="Race library" onClick={onClose}>
      <div className="library" onClick={(e) => e.stopPropagation()}>
        <header className="library-head">
          <h2>Race library</h2>
          <div className="toggle" role="tablist" aria-label="Season">
            {YEARS.map((y) => (
              <button key={y} role="tab" aria-pressed={y === year} onClick={() => setYear(y)}>
                {y}
              </button>
            ))}
          </div>
          <label className="small dim">
            from lap <input type="number" min={1} value={lap} onChange={(e) => setLap(Math.max(1, Number(e.target.value) || 1))} />
          </label>
          <div className="toggle" role="group" aria-label="Speed">
            {[1, 5, 10, 20].map((s) => (
              <button key={s} aria-pressed={speed === s} onClick={() => setSpeed(s)}>
                {s}×
              </button>
            ))}
          </div>
          <button className="close" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </header>
        <p className="dim small library-note">
          Races come from OpenF1's free archive, available about 30 minutes after the chequered flag. A download takes a few
          minutes (OpenF1 allows 30 requests a minute) and happens once; after that a race replays instantly.
        </p>
        {error && <p className="error">{error}</p>}
        {!races && !error && <p className="dim">Loading the {year} season…</p>}
        <ol className="race-grid">
          {races?.map((r, i) => (
            <li key={r.race} className={`race-card ${r.state}`}>
              <span className="round mono dim">R{String(i + 1).padStart(2, "0")}</span>
              <div className="race-name">
                <b>{r.location}</b>
                <span className="dim small">
                  {r.circuit} · {new Date(r.starts_at).toLocaleDateString(undefined, { day: "numeric", month: "short" })}
                </span>
              </div>
              {r.state === "ready" && (
                <button className="primary" onClick={() => onStart(r.race, lap, speed)}>
                  Replay
                </button>
              )}
              {(r.state === "missing" || r.state === "failed") && (
                <button onClick={() => download(r.race)} title={r.state === "failed" ? r.detail : undefined}>
                  {r.state === "failed" ? "Retry" : "Download"}
                </button>
              )}
              {(r.state === "queued" || r.state === "downloading") && (
                <span className="progress small" title={r.detail}>
                  {r.state === "queued" ? "Queued" : r.detail || "Downloading…"}
                </span>
              )}
              {r.state === "upcoming" && (
                <span className="dim small">
                  From {new Date(r.free_from).toLocaleString(undefined, { weekday: "short", hour: "2-digit", minute: "2-digit" })}
                </span>
              )}
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
}
