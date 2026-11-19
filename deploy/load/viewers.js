// A race weekend's audience: a replay at 20x and hundreds of pit-wall viewers.
//
// Each virtual user is one browser: it opens the pit wall's WebSocket, watches two cars (as the
// screen does) and stays for a stint, counting the frames it gets and the gaps between them.
// The API sends five frames a second; a viewer getting fewer, or waiting longer, is a viewer
// watching a stale pit wall.
//
// Run with scripts/loadtest.sh (a k6 Job inside the cluster). Settings by environment:
//   API        the pit wall API (default http://api.pitwall.svc.cluster.local:8080)
//   VIEWERS    peak viewers (default 200)
//   SPEED      replay speed (default 20)
//   HOLD       how long to hold the peak (default 4m)

import http from "k6/http";
import { check } from "k6";
import { Counter, Rate, Trend } from "k6/metrics";
import { setTimeout } from "k6/timers";
import { WebSocket } from "k6/websockets";

const API = __ENV.API || "http://api.pitwall.svc.cluster.local:8080";
const VIEWERS = parseInt(__ENV.VIEWERS || "200", 10);
const SPEED = parseFloat(__ENV.SPEED || "20");
const HOLD = __ENV.HOLD || "4m";
const STINT_MS = 60000; // each viewer watches for a minute, then reconnects

const frames = new Counter("pitwall_frames");
const frameGap = new Trend("pitwall_frame_gap_ms", true);
const framesPerSecond = new Trend("pitwall_frames_per_second");
const connected = new Rate("pitwall_connected");
const withData = new Rate("pitwall_board_received");

export const options = {
  scenarios: {
    viewers: {
      executor: "ramping-vus",
      startVUs: 0,
      stages: [
        { duration: "2m", target: VIEWERS },
        { duration: HOLD, target: VIEWERS },
        { duration: "1m", target: 0 },
      ],
      gracefulRampDown: "70s",
    },
  },
  thresholds: {
    pitwall_connected: ["rate>0.99"],
    pitwall_board_received: ["rate>0.99"],
    // Five frames a second are sent; a viewer should see at least four.
    pitwall_frames_per_second: ["avg>=4", "p(5)>=3"],
    // Gaps between frames: 200 ms by design.
    pitwall_frame_gap_ms: ["p(95)<400", "p(99)<1000"],
  },
  summaryTrendStats: ["avg", "min", "med", "p(95)", "p(99)", "max"],
};

export function setup() {
  const start = http.post(
    `${API}/api/replay`,
    JSON.stringify({ race: "2024-sao-paulo", speed: SPEED, from_lap: 1 }),
    { headers: { "Content-Type": "application/json" } },
  );
  check(start, { "replay started": (r) => r.status === 201 });
  console.log(`replay at ${SPEED}x: ${start.status}; up to ${VIEWERS} viewers`);
}

export default function () {
  const url = API.replace(/^http/, "ws") + "/ws";
  const ws = new WebSocket(url);
  let count = 0;
  let last = null;
  let opened = false;
  let sawBoard = false;
  const began = Date.now();

  ws.onopen = () => {
    opened = true;
    ws.send(JSON.stringify({ watch: [1, 44] }));
    setTimeout(() => ws.close(), STINT_MS);
  };
  ws.onmessage = (message) => {
    const now = Date.now();
    count += 1;
    frames.add(1);
    if (last !== null) frameGap.add(now - last);
    last = now;
    if (!sawBoard && message.data.indexOf('"board"') !== -1) sawBoard = true;
  };
  ws.onerror = () => {};
  ws.onclose = () => {
    connected.add(opened);
    withData.add(sawBoard);
    const seconds = (Date.now() - began) / 1000;
    if (opened && seconds > 5) framesPerSecond.add(count / seconds);
  };
}
