import { raceClock } from "../format";
import type { Message } from "../types";

const FLAG_TONE: Record<string, string> = {
  RED: "red",
  YELLOW: "amber",
  "DOUBLE YELLOW": "amber",
  GREEN: "green",
  CHEQUERED: "chequered",
  BLUE: "blue",
};

export function RaceControl({ messages }: { messages: Message[] }) {
  return (
    <section className="panel race-control" aria-label="Race control">
      <header className="panel-head">
        <h2>Race control</h2>
      </header>
      <ol>
        {messages.length === 0 && <li className="dim small">No messages yet.</li>}
        {messages.map((m) => (
          <li key={`${m.t}-${m.message}`}>
            <span className="mono dim small">{raceClock(m.t)}</span>
            {m.flag && <span className={`flag ${FLAG_TONE[m.flag] ?? "neutral"}`}>{m.flag}</span>}
            <span>{m.message}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}
