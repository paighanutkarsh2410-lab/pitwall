import { useEffect, useState } from "react";
import { RECORDING, recordedTrace } from "./recording";
import type { Board, Trace } from "./types";

/**
 * The race so far, lap by lap: gaps to the leader, places, the grid and the starting tyres. On
 * the public site it comes from the recording's story; live, from the API's trace (which has
 * gaps only, so places are worked out from them).
 */
export function useTrace(board: Board | null): Trace | null {
  const [trace, setTrace] = useState<Trace | null>(null);
  const lap = board?.lap ?? 0;
  const run = board?.run;

  useEffect(() => {
    if (!RECORDING) return;
    let cancelled = false;
    recordedTrace(lap)
      .then((t) => !cancelled && setTrace(t))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [lap]);

  useEffect(() => {
    if (RECORDING || !run) return;
    let cancelled = false;
    const load = () =>
      fetch("/api/trace")
        .then((r) => (r.ok ? r.json() : null))
        .then((t: Trace | null) => !cancelled && t && setTrace({ ...t, positions: t.positions ?? placesFromGaps(t) }))
        .catch(() => undefined);
    load();
    const timer = window.setInterval(load, 4000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [run]);

  return trace;
}

/** Each car's place at the end of each lap, from the gaps: smaller gap, higher place. */
export function placesFromGaps(trace: Trace): Record<string, [number, number][]> {
  const byLap = new Map<number, [string, number][]>();
  for (const [car, pts] of Object.entries(trace.cars)) {
    for (const [lap, gap] of pts) {
      if (!byLap.has(lap)) byLap.set(lap, []);
      byLap.get(lap)!.push([car, gap]);
    }
  }
  const places: Record<string, [number, number][]> = {};
  for (const [lap, cars] of [...byLap].sort((a, b) => a[0] - b[0])) {
    cars.sort((a, b) => a[1] - b[1]).forEach(([car], i) => (places[car] ??= []).push([lap, i + 1]));
  }
  return places;
}
