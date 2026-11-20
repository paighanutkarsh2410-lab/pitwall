import { useState } from "react";
import { raceClock } from "../format";
import type { Message } from "../types";

const FLAG_TONE: Record<string, string> = {
  RED: "red",
  YELLOW: "amber",
  "DOUBLE YELLOW": "amber",
  GREEN: "green",
  CLEAR: "green",
  CHEQUERED: "chequered",
  BLUE: "blue",
};

/** What a message is about, from its flag and its wording (the feed has no finer category). */
function kind(m: Message): "flags" | "penalties" | "incidents" | "other" {
  const text = m.message.toUpperCase();
  if (/PENALTY|DELETED|REPRIMAND|DISQUALIF|DRIVE THROUGH|STOP AND GO/.test(text)) return "penalties";
  if (/INCIDENT|INVESTIGAT|COLLISION|NOTED|UNDER REVIEW/.test(text)) return "incidents";
  if (m.flag || /SAFETY CAR|VSC|FLAG/.test(text)) return "flags";
  return "other";
}

const FILTERS = [
  ["all", "All"],
  ["flags", "Flags"],
  ["penalties", "Penalties"],
  ["incidents", "Incidents"],
] as const;

/** The race director's messages, newest first, each marked with its flag colour; filterable. */
export function RaceControl({ messages }: { messages: Message[] }) {
  const [filter, setFilter] = useState<(typeof FILTERS)[number][0]>("all");
  const shown = filter === "all" ? messages : messages.filter((m) => kind(m) === filter);
  const count = (f: string) => (f === "all" ? messages.length : messages.filter((m) => kind(m) === f).length);
  return (
    <section className="panel race-control" aria-label="Race control">
      <header className="panel-head">
        <h2>Race control</h2>
        <div className="chips" role="group" aria-label="Show">
          {FILTERS.map(([f, label]) => (
            <button key={f} aria-pressed={filter === f} onClick={() => setFilter(f)}>
              {label}
              <span className="n">{count(f)}</span>
            </button>
          ))}
        </div>
      </header>
      <ol>
        {shown.length === 0 && <li className="dim small">{messages.length ? "None of these yet." : "No messages yet."}</li>}
        {shown.map((m) => {
          const k = kind(m);
          const tone = m.flag ? (FLAG_TONE[m.flag] ?? "neutral") : k === "penalties" ? "penalty" : k === "incidents" ? "incident" : "neutral";
          return (
            <li key={`${m.t}-${m.message}`} className={`rc ${tone}`}>
              <span className="mono dim small">{raceClock(m.t)}</span>
              <span className="rc-body">
                {m.flag && <span className={`flag ${FLAG_TONE[m.flag] ?? "neutral"}`}>{m.flag}</span>}
                {!m.flag && k !== "other" && <span className={`flag ${tone}`}>{k === "penalties" ? "PENALTY" : "INCIDENT"}</span>}
                <span>{m.message}</span>
              </span>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
