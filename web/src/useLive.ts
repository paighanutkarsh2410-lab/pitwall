import { useEffect, useRef, useState } from "react";
import type { Board, Sample, Strategy, Track } from "./types";

const KEEP_SAMPLES = 240; // about a minute of a car's telemetry

export interface Live {
  connected: boolean;
  board: Board | null;
  strategy: Strategy | null;
  positions: Record<string, [number, number]>;
  track: Track | null;
  /** Recent telemetry of the watched cars, by car number. */
  samples: Record<string, Sample[]>;
}

interface Frame {
  board?: Board;
  strategy?: Strategy;
  positions?: Record<string, [number, number]>;
  track?: Track;
  telemetry?: Record<string, Sample[]>;
}

/** One WebSocket to pitwall-api, reconnecting with backoff; frames arrive five times a second. */
export function useLive(watch: number[]): Live {
  const [live, setLive] = useState<Live>({
    connected: false,
    board: null,
    strategy: null,
    positions: {},
    track: null,
    samples: {},
  });
  const socket = useRef<WebSocket | null>(null);
  const watching = useRef<number[]>(watch);
  const key = watch.join(",");

  useEffect(() => {
    let stopped = false;
    let retry = 500;
    let timer: number | undefined;

    const connect = () => {
      const scheme = location.protocol === "https:" ? "wss" : "ws";
      const ws = new WebSocket(`${scheme}://${location.host}/ws`);
      socket.current = ws;
      ws.onopen = () => {
        retry = 500;
        setLive((s) => ({ ...s, connected: true }));
        if (watching.current.length) ws.send(JSON.stringify({ watch: watching.current }));
      };
      ws.onmessage = (message) => {
        const frame = JSON.parse(message.data) as Frame;
        setLive((s) => {
          const next = { ...s };
          if (frame.board) {
            if (s.board && frame.board.run !== s.board.run) {
              next.samples = {};
              next.positions = {};
            }
            next.board = frame.board;
          }
          if (frame.strategy) next.strategy = frame.strategy;
          if (frame.positions) next.positions = frame.positions;
          if (frame.track) next.track = frame.track;
          if (frame.telemetry) {
            const samples = { ...next.samples };
            for (const [car, fresh] of Object.entries(frame.telemetry)) {
              samples[car] = [...(samples[car] ?? []), ...fresh].slice(-KEEP_SAMPLES);
            }
            next.samples = samples;
          }
          return next;
        });
      };
      ws.onclose = () => {
        setLive((s) => ({ ...s, connected: false }));
        if (stopped) return;
        timer = window.setTimeout(connect, retry);
        retry = Math.min(retry * 2, 8000);
      };
    };
    connect();
    return () => {
      stopped = true;
      window.clearTimeout(timer);
      socket.current?.close();
    };
  }, []);

  useEffect(() => {
    watching.current = key ? key.split(",").map(Number) : [];
    if (socket.current?.readyState === WebSocket.OPEN) {
      socket.current.send(JSON.stringify({ watch: watching.current }));
    }
    setLive((s) => ({ ...s, samples: {} }));
  }, [key]);

  return live;
}
