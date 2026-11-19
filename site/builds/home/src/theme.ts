/**
 * Each team's grade: the page takes the winning team's own colours (colours only, no marks).
 * `onAccent` is the text colour that reads on the accent: white on the reds, near-black on
 * McLaren's papaya and Mercedes' teal, where white would fail contrast.
 */
export interface Theme {
  key: string;
  label: string; // shown in the wash: the team, as a word
  accent: string; // the hard colour: script names, marks, the card
  mid: string;
  deep: string;
  onAccent: string; // text on the card
  ctaBg: string;
  ctaInk: string;
  script: string; // the script first name in the hero
  haze: string; // a second glow behind the car
  glow: number; // the backdrop's colour in the 3D studio
  rim: number; // the rim light
  streak: number; // the coloured speed streaks
}

export const THEMES: Record<string, Theme> = {
  redbull: {
    key: "redbull", label: "Red Bull", accent: "#e10600", mid: "#b80500", deep: "#7a0400",
    onAccent: "#ffffff", ctaBg: "#ffffff", ctaInk: "#120202", script: "#e10600", haze: "#1c2a78",
    glow: 0xc80600, rim: 0xff2a14, streak: 0xff2a14,
  },
  mclaren: {
    key: "mclaren", label: "McLaren", accent: "#ff8000", mid: "#e56b00", deep: "#7a3300",
    onAccent: "#140800", ctaBg: "#140800", ctaInk: "#ff8f1f", script: "#ff8000", haze: "#3a1a00",
    glow: 0xff7000, rim: 0xff7a10, streak: 0xff8a20,
  },
  mercedes: {
    key: "mercedes", label: "Mercedes", accent: "#00d2be", mid: "#00a19c", deep: "#013f3b",
    onAccent: "#021514", ctaBg: "#021514", ctaInk: "#3be8d6", script: "#00d2be", haze: "#7f8b95",
    glow: 0x00a19c, rim: 0x2fe0cf, streak: 0x40e8d8,
  },
  ferrari: {
    key: "ferrari", label: "Ferrari", accent: "#dc0000", mid: "#a80000", deep: "#560000",
    onAccent: "#ffffff", ctaBg: "#fff200", ctaInk: "#2a0000", script: "#fff200", haze: "#5a4a00",
    glow: 0xdc0000, rim: 0xff2000, streak: 0xfff200,
  },
}; // fmt: skip

export function themeFor(team: string | undefined): Theme {
  const t = (team ?? "").toLowerCase();
  if (t.includes("mclaren")) return THEMES.mclaren;
  if (t.includes("mercedes")) return THEMES.mercedes;
  if (t.includes("ferrari")) return THEMES.ferrari;
  return THEMES.redbull;
}

/** The CSS custom properties a theme sets on :root. */
export function cssVars(t: Theme): Record<string, string> {
  return {
    "--accent": t.accent,
    "--accent-mid": t.mid,
    "--accent-deep": t.deep,
    "--on-accent": t.onAccent,
    "--cta-bg": t.ctaBg,
    "--cta-ink": t.ctaInk,
    "--script-ink": t.script,
    "--haze": t.haze,
  };
}
