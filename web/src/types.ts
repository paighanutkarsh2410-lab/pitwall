export type Gap = number | string | null;

export interface Session {
  race_id: string;
  name: string;
  circuit: string;
  location: string;
  country: string;
  year: number;
  starts_at: string;
  laps: number | null;
}

export interface BoardCar {
  car: number;
  code: string;
  name: string;
  team: string;
  colour: string | null;
  position: number | null;
  lap: number;
  gap_to_leader: Gap;
  interval: Gap;
  last_lap_ms: number | null;
  best_lap_ms: number | null;
  personal_best: boolean;
  fastest_lap: boolean;
  sectors_ms: (number | null)[];
  sector_status: ("purple" | "green" | "yellow" | null)[];
  best_sectors_ms: (number | null)[];
  start_position: number | null;
  compound: string | null;
  tyre_age: number | null;
  pits: number;
  in_pit: boolean;
  last_pit: { lap: number; pit_lane_ms: number | null; stop_ms: number | null } | null;
}

export interface Message {
  t: number;
  category: string;
  flag: string | null;
  message: string;
  car: number | null;
}

export interface Weather {
  air_c: number;
  track_c: number;
  humidity: number;
  rainfall: boolean;
  wind_ms: number;
}

export interface Board {
  run: string;
  t: number;
  session: Session | null;
  lap: number;
  laps: number | null;
  track: string;
  yellow_sectors: number[];
  weather: Weather | null;
  messages: Message[];
  fastest_lap: { car: number; lap_time_ms: number } | null;
  best_sectors_ms: (number | null)[];
  cars: BoardCar[];
}

export interface StintSummary {
  stint: number;
  compound: string;
  lap_start: number;
  lap_end: number | null;
  tyre_age_start: number;
  clean_laps: number;
  pace_ms: number | null;
  deg_ms_per_lap: number | null;
}

export interface Strategy {
  run: string;
  t: number;
  pit_loss_ms: number | null;
  neutralised_laps: number[];
  cars: Record<string, { stints: StintSummary[]; compound: string | null; deg_ms_per_lap: number | null; pits: number }>;
}

/** [t, speed, throttle, brake, gear, rpm, drs] */
export type Sample = [number, number, number, number, number, number, number];

export interface Track {
  race: string;
  points: [number, number][];
}

export interface Lap {
  lap: number;
  t: number;
  lap_time_ms: number | null;
  s1_ms: number | null;
  s2_ms: number | null;
  s3_ms: number | null;
  pit_out_lap: boolean;
}

export interface Replay {
  run?: string;
  race?: string;
  speed?: number;
  from_lap?: number;
  state: "idle" | "starting" | "downloading" | "playing" | "finished" | "stopped" | "failed";
  detail?: string;
  sent?: number;
  race_t?: number | null;
}

export interface CatalogRace {
  race: string;
  location: string;
  country: string;
  circuit: string;
  starts_at: string;
  state: "ready" | "missing" | "queued" | "downloading" | "failed" | "upcoming";
  free_from: string;
  detail: string;
}

export interface Trace {
  laps: number;
  cars: Record<string, [number, number][]>;
  /** Each car's place at the end of each lap. Derived from the gaps when the source has none. */
  positions?: Record<string, [number, number][]>;
  /** The tyres each car started on, where known before the start. */
  startTyres?: Record<string, string | null>;
  /** The starting grid: car -> grid slot. */
  grid?: Record<string, number>;
}

export interface RaceOnDisk {
  race: string;
  name: string;
  circuit: string;
  year: number;
  laps: number;
  events: number;
}
