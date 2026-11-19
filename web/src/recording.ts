import { useCallback, useEffect, useRef, useState } from "react";
import type { Board, Sample, Strategy, Trace, Track } from "./types";

/**
 * The public site's source: a recording instead of a WebSocket.
 *
 * `scripts/record_race.py` ran a whole race through Pitwall's own timing, strategy and API code
 * and saved what this screen would have been sent, in one-minute chunks of race time. This plays
 * it back at the chosen speed and hands the screen the same frames the API would: nothing here
 * computes timing, it only replays what the services produced.
 */
export const RECORDING = import.meta.env.VITE_PITWALL_SOURCE === "recording";
const params = new URLSearchParams(location.search);
/** The race to play: ?race=2025-silverstone (the home page links here with it). */
export const RACE = /^\d{4}-[a-z0-9-]+$/.test(params.get("race") ?? "") ? params.get("race")! : "2024-sao-paulo";
/** The driver to follow, if the home page named one: ?driver=4. */
export const DRIVER = Number(params.get("driver")) || null;
const DATA = () => new URL(`../data/${RACE}/`, document.baseURI).href;

/** Chunks are stored gzipped (a static host counts stored size); the browser unpacks them. */
async function readJson<T>(url: string): Promise<T> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: ${r.status}`);
  if (!url.endsWith(".gz")) return r.json();
  const unpacked = r.body!.pipeThrough(new DecompressionStream("gzip"));
  return new Response(unpacked).json();
}
const TICK_MS = 200; // the API sends five frames a second
const KEEP_SAMPLES = 240;

interface Manifest {
  race: string;
  session: Board["session"];
  start_t: number;
  begin_t: number;
  end_t: number;
  chunk_ms: number;
  chunks: { file: string; t0: number; t1: number }[];
  laps: Record<string, number>;
  track: Track | null;
}

interface Chunk {
  t0: number;
  boards: [number, Board][];
  strategy: [number, Strategy][];
  positions: [number, Record<string, [number, number]>][];
  telemetry: Record<string, Sample[]>;
}

export interface Playback {
  playing: boolean;
  speed: number;
  lap: number;
  laps: number;
  buffering: boolean;
  toggle: () => void;
  setSpeed: (speed: number) => void;
  seekLap: (lap: number) => void;
}

export interface RecordedLive {
  connected: boolean;
  board: Board | null;
  strategy: Strategy | null;
  positions: Record<string, [number, number]>;
  track: Track | null;
  samples: Record<string, Sample[]>;
  playback: Playback;
}

/** The last entry at or before t, from a list sorted by time. */
function lastAt<T>(list: [number, T][], t: number): T | undefined {
  let lo = 0;
  let hi = list.length - 1;
  let found: T | undefined;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (list[mid][0] <= t) {
      found = list[mid][1];
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return found;
}

export function useRecording(watch: number[]): RecordedLive {
  const [manifest, setManifest] = useState<Manifest | null>(null);
  const [view, setView] = useState({
    board: null as Board | null,
    strategy: null as Strategy | null,
    positions: {} as Record<string, [number, number]>,
    samples: {} as Record<string, Sample[]>,
  });
  const [playing, setPlaying] = useState(true);
  const [speed, setSpeedState] = useState(1);
  const [buffering, setBuffering] = useState(true);
  const clock = useRef({ t: 0, sentT: 0, last: performance.now() });
  const chunks = useRef(new Map<number, Promise<Chunk>>());
  const loaded = useRef(new Map<number, Chunk>());
  const watching = useRef<number[]>(watch);
  const state = useRef({ playing: true, speed: 1 });

  useEffect(() => {
    fetch(`${DATA()}manifest.json`)
      .then((r) => r.json())
      .then((m: Manifest) => {
        // Start half a minute before lights out: the grid, then the start.
        clock.current.t = m.start_t - 30_000;
        clock.current.sentT = clock.current.t;
        setManifest(m);
      })
      .catch(() => setBuffering(true));
  }, []);

  const chunkIndex = useCallback(
    (t: number) => (manifest ? Math.floor((t - manifest.begin_t) / manifest.chunk_ms) : 0),
    [manifest],
  );
  const load = useCallback(
    (i: number) => {
      if (!manifest || i < 0 || i >= manifest.chunks.length) return undefined;
      let p = chunks.current.get(i);
      if (!p) {
        p = readJson<Chunk>(`${DATA()}${manifest.chunks[i].file}`);
        p.then((c) => loaded.current.set(i, c)).catch(() => chunks.current.delete(i));
        chunks.current.set(i, p);
      }
      return p;
    },
    [manifest],
  );

  useEffect(() => {
    watching.current = watch;
    setView((v) => ({ ...v, samples: {} }));
    clock.current.sentT = clock.current.t - 60_000; // backfill a minute of the new cars' telemetry
  }, [watch.join(",")]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!manifest) return;
    const timer = window.setInterval(() => {
      const c = clock.current;
      const now = performance.now();
      const i = chunkIndex(c.t);
      load(i);
      load(i + 1); // the next minute, ready before it is needed
      const chunk = loaded.current.get(i);
      if (!chunk) {
        setBuffering(true);
        c.last = now;
        return;
      }
      setBuffering(false);
      if (state.current.playing) {
        c.t = Math.min(c.t + (now - c.last) * state.current.speed, manifest.end_t - 1);
      }
      c.last = now;
      const t = c.t;
      // What the screen holds at race time t: the newest board, strategy and positions.
      const search = <T,>(pick: (k: Chunk) => [number, T][]) => {
        for (let k = i; k >= Math.max(0, i - 3); k--) {
          const ch = loaded.current.get(k);
          if (!ch) {
            load(k);
            continue;
          }
          const hit = lastAt(pick(ch), t);
          if (hit !== undefined) return hit;
        }
        return undefined;
      };
      const board = search((k) => k.boards);
      const strategy = search((k) => k.strategy);
      const positions = search((k) => k.positions);
      const fresh: Record<string, Sample[]> = {};
      for (const car of watching.current) {
        for (let k = chunkIndex(c.sentT); k <= i; k++) {
          const ch = loaded.current.get(k);
          for (const s of ch?.telemetry[String(car)] ?? []) {
            if (s[0] > c.sentT && s[0] <= t) (fresh[car] ??= []).push(s);
          }
        }
      }
      c.sentT = t;
      setView((v) => {
        const samples = { ...v.samples };
        for (const [car, list] of Object.entries(fresh)) {
          samples[car] = [...(samples[car] ?? []), ...list].slice(-KEEP_SAMPLES);
        }
        return {
          board: board ? { ...board, session: manifest.session, run: "recording" } : v.board,
          strategy: strategy ?? v.strategy,
          positions: positions ?? v.positions,
          samples,
        };
      });
    }, TICK_MS);
    return () => window.clearInterval(timer);
  }, [manifest, chunkIndex, load]);

  const toggle = useCallback(() => {
    state.current.playing = !state.current.playing;
    clock.current.last = performance.now();
    setPlaying(state.current.playing);
  }, []);
  const setSpeed = useCallback((s: number) => {
    state.current.speed = s;
    setSpeedState(s);
  }, []);
  const seekLap = useCallback(
    (lap: number) => {
      if (!manifest) return;
      const t = manifest.laps[String(lap)] ?? manifest.start_t;
      clock.current.t = t - 2_000;
      clock.current.sentT = clock.current.t - 60_000;
      setView((v) => ({ ...v, samples: {}, positions: {} }));
    },
    [manifest],
  );

  return {
    connected: manifest !== null,
    board: view.board,
    strategy: view.strategy,
    positions: view.positions,
    track: manifest?.track ?? null,
    samples: view.samples,
    playback: {
      playing,
      speed,
      lap: view.board?.lap ?? 0,
      laps: view.board?.laps ?? 69,
      buffering,
      toggle,
      setSpeed,
      seekLap,
    },
  };
}

/** The race trace (gap to the leader at the end of each lap), from the recording's story. */
export async function recordedTrace(upToLap: number): Promise<Trace> {
  const story = await fetch(`${DATA()}story.json`).then((r) => r.json());
  const cars: Record<string, [number, number][]> = {};
  // story.laps[n].gaps are taken as the leader starts lap n+1: the gaps at the end of lap n.
  for (const entry of story.laps as { lap: number; gaps: Record<string, number | string> }[]) {
    const finished = entry.lap - 1;
    if (finished < 1 || finished > upToLap) continue;
    for (const [car, gap] of Object.entries(entry.gaps)) {
      if (typeof gap === "number") (cars[car] ??= []).push([finished, gap]);
    }
  }
  return { laps: Math.max(1, upToLap), cars };
}
