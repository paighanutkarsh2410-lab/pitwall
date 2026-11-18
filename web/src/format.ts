import type { Gap } from "./types";

export function lapTime(ms: number | null | undefined): string {
  if (ms == null) return "–";
  const minutes = Math.floor(ms / 60000);
  const seconds = (ms % 60000) / 1000;
  return minutes ? `${minutes}:${seconds.toFixed(3).padStart(6, "0")}` : seconds.toFixed(3);
}

export function sector(ms: number | null | undefined): string {
  return ms == null ? "–" : (ms / 1000).toFixed(1);
}

export function gap(value: Gap, leader = false): string {
  if (leader) return "Leader";
  if (value == null) return "–";
  return typeof value === "string" ? value : `+${value.toFixed(3)}`;
}

/** Race time: t counts milliseconds from the scheduled start. */
export function raceClock(t: number): string {
  const sign = t < 0 ? "-" : "";
  const s = Math.abs(t) / 1000;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  return `${sign}${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
}

export function slug(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

export const TYRES: Record<string, { label: string; colour: string }> = {
  SOFT: { label: "S", colour: "#ff3b4d" },
  MEDIUM: { label: "M", colour: "#ffd23f" },
  HARD: { label: "H", colour: "#f2f2f2" },
  INTERMEDIATE: { label: "I", colour: "#3ddc6a" },
  WET: { label: "W", colour: "#3d8bff" },
};

export const TRACK_STATUS: Record<string, { label: string; tone: string }> = {
  PRE_RACE: { label: "Pre-race", tone: "neutral" },
  GREEN: { label: "Green flag", tone: "green" },
  SC: { label: "Safety car", tone: "amber" },
  SC_ENDING: { label: "Safety car in this lap", tone: "amber" },
  VSC: { label: "Virtual safety car", tone: "amber" },
  VSC_ENDING: { label: "VSC ending", tone: "amber" },
  RED: { label: "Red flag", tone: "red" },
  CHEQUERED: { label: "Chequered flag", tone: "chequered" },
};

export function teamColour(colour: string | null | undefined): string {
  return colour && /^[0-9a-f]{6}$/i.test(colour) ? `#${colour}` : "#8a8f98";
}
