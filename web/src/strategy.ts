import type { Board, BoardCar } from "./types";

/** Seconds behind the leader, or null for "+1 LAP" and unknown gaps. */
export function gapSeconds(car: BoardCar): number | null {
  if (car.position === 1) return 0;
  return typeof car.gap_to_leader === "number" ? car.gap_to_leader : null;
}

export interface Neighbours {
  ahead: { car: BoardCar; gap: number | null } | null;
  behind: { car: BoardCar; gap: number | null } | null;
}

/** The cars either side of this one on track order, and the gaps to them. */
export function neighbours(board: Board, car: BoardCar): Neighbours {
  const ordered = board.cars.filter((c) => c.position != null);
  const i = ordered.findIndex((c) => c.car === car.car);
  const ahead = i > 0 ? ordered[i - 1] : null;
  const behind = i >= 0 && i < ordered.length - 1 ? ordered[i + 1] : null;
  const num = (v: unknown) => (typeof v === "number" ? v : null);
  return {
    ahead: ahead ? { car: ahead, gap: num(car.interval) } : null,
    behind: behind ? { car: behind, gap: num(behind.interval) } : null,
  };
}

export interface Rejoin {
  position: number;
  lossSeconds: number;
  ahead: { car: BoardCar; gap: number } | null;
  behind: { car: BoardCar; gap: number } | null;
  neutralised: boolean;
}

const NEUTRALISED = new Set(["SC", "SC_ENDING", "VSC", "VSC_ENDING"]);

/**
 * Where the car would come out if it pitted this lap: its gap to the leader plus the pit loss,
 * placed among everyone else's gaps. Under a safety car or VSC the field is slow, so a stop costs
 * roughly half as much: the classic "cheap stop".
 */
export function rejoin(board: Board, car: BoardCar, pitLossMs: number | null): Rejoin | null {
  const own = gapSeconds(car);
  if (own == null || pitLossMs == null) return null;
  const neutralised = NEUTRALISED.has(board.track);
  const lossSeconds = (pitLossMs / 1000) * (neutralised ? 0.5 : 1);
  const projected = own + lossSeconds;
  const others = board.cars
    .filter((c) => c.car !== car.car && !c.in_pit)
    .map((c) => ({ car: c, gap: gapSeconds(c) }))
    .filter((c): c is { car: BoardCar; gap: number } => c.gap != null)
    .sort((a, b) => a.gap - b.gap);
  const before = others.filter((c) => c.gap <= projected);
  const after = others.filter((c) => c.gap > projected);
  const ahead = before[before.length - 1];
  const behind = after[0];
  return {
    position: before.length + 1,
    lossSeconds,
    ahead: ahead ? { car: ahead.car, gap: projected - ahead.gap } : null,
    behind: behind ? { car: behind.car, gap: behind.gap - projected } : null,
    neutralised,
  };
}

/** The team's cars in race order. */
export function teamCars(board: Board, team: string | null): BoardCar[] {
  if (!team) return [];
  return board.cars.filter((c) => c.team === team).slice(0, 2);
}

export function teams(board: Board): { team: string; colour: string | null }[] {
  const seen = new Map<string, string | null>();
  for (const c of board.cars) if (c.team && !seen.has(c.team)) seen.set(c.team, c.colour);
  return [...seen].map(([team, colour]) => ({ team, colour })).sort((a, b) => a.team.localeCompare(b.team));
}

/**
 * The laps in which a stop pays for itself, for the stint a car is on: a rough window, not a
 * prediction. On tyres that lose `deg` ms a lap more each lap, a stint L laps old has lost
 * deg·L²/2 against fresh tyres; a stop starts to pay once that passes the pit loss, at
 * L = √(2 · pitLoss / deg). The window is that tyre age ± 15% (at least two laps), counted from
 * when this set of tyres was new. None when the tyres aren't wearing measurably, when the stop
 * costs aren't known yet, or when the window would open in the last three laps (run to the flag).
 */
export function pitWindow(
  stint: { lap_start: number; tyre_age_start: number } | undefined,
  degMsPerLap: number | null | undefined,
  pitLossMs: number | null | undefined,
  totalLaps: number,
): [number, number] | null {
  if (!stint || degMsPerLap == null || pitLossMs == null || degMsPerLap < 15) return null;
  const age = Math.sqrt((2 * pitLossMs) / degMsPerLap);
  const newAt = stint.lap_start - stint.tyre_age_start;
  const spread = Math.max(2, age * 0.15);
  const from = Math.round(newAt + age - spread);
  const to = Math.min(totalLaps, Math.round(newAt + age + spread));
  if (from > totalLaps - 3 || to < stint.lap_start) return null;
  return [Math.max(from, stint.lap_start + 1), to];
}
