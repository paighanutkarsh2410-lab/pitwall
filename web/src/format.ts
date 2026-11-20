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

/** Dark or light text, whichever reads better on this colour (WCAG relative luminance). */
export function onColour(hex: string): string {
  const c = hex.replace("#", "");
  if (!/^[0-9a-f]{6}$/i.test(c)) return "#0b0d10";
  const [r, g, b] = [0, 2, 4].map((i) => {
    const v = parseInt(c.slice(i, i + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.22 ? "#0b0d10" : "#ffffff";
}

export function teamColour(colour: string | null | undefined): string {
  return colour && /^[0-9a-f]{6}$/i.test(colour) ? `#${colour}` : "#8a8f98";
}

/**
 * The colours of the two cars on the wall's comparisons (trace, telemetry, head to head): the
 * first in its team colour; a teammate in white, so two cars of one team never read as one;
 * a car from another team in its own colour.
 */
export function pairColours(cars: { colour: string | null; team: string }[]): string[] {
  return cars.map((c, i) => {
    const base = teamColour(c.colour);
    if (i === 0) return base;
    return c.team === cars[0].team || base === teamColour(cars[0].colour) ? "#f4f3f1" : base;
  });
}

/** A team colour mixed towards white: the second car of a team, told apart from the first. */
export function shade(hex: string, towardsWhite: number): string {
  const n = parseInt(hex.slice(1), 16);
  const mix = (c: number) => Math.round(c + (255 - c) * towardsWhite);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map(mix);
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, "0")}`;
}
