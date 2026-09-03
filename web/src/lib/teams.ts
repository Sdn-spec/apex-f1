/**
 * Team and tyre colours.
 *
 * OpenF1 publishes a `team_colour` per driver, but it is occasionally missing
 * or a shade that disappears against a dark background, so a curated table
 * takes precedence and the feed's value is the fallback.
 */

const TEAM_COLOURS: Record<string, string> = {
  "red bull racing": "#3671C6",
  "red bull": "#3671C6",
  ferrari: "#E8002D",
  mercedes: "#27F4D2",
  mclaren: "#FF8000",
  "aston martin": "#229971",
  alpine: "#FF87BC",
  "alpine f1 team": "#FF87BC",
  williams: "#64C4FF",
  "racing bulls": "#6692FF",
  "rb f1 team": "#6692FF",
  "visa cash app rb": "#6692FF",
  "kick sauber": "#52E252",
  sauber: "#52E252",
  audi: "#52E252",
  "haas f1 team": "#B6BABD",
  haas: "#B6BABD",
  cadillac: "#C9A227",
};

export const FALLBACK_COLOUR = "#9E9E9E";

export function teamColour(team: string | null | undefined, feedColour?: string | null): string {
  const key = (team ?? "").trim().toLowerCase();
  if (TEAM_COLOURS[key]) return TEAM_COLOURS[key];
  for (const [name, colour] of Object.entries(TEAM_COLOURS)) {
    if (key.includes(name) || name.includes(key)) return colour;
  }
  if (feedColour) {
    const hex = feedColour.replace("#", "");
    if (/^[0-9a-f]{6}$/i.test(hex)) return `#${hex}`;
  }
  return FALLBACK_COLOUR;
}

export const COMPOUND_COLOURS: Record<string, string> = {
  SOFT: "#E8002D",
  MEDIUM: "#FFD12E",
  HARD: "#F0F0F0",
  INTERMEDIATE: "#43B02A",
  WET: "#0067AD",
  UNKNOWN: "#6B7280",
  TEST_UNKNOWN: "#6B7280",
};

export const COMPOUND_LETTER: Record<string, string> = {
  SOFT: "S",
  MEDIUM: "M",
  HARD: "H",
  INTERMEDIATE: "I",
  WET: "W",
};

export function compoundColour(compound: string | null | undefined): string {
  return COMPOUND_COLOURS[(compound ?? "").toUpperCase()] ?? COMPOUND_COLOURS.UNKNOWN;
}

export function compoundLetter(compound: string | null | undefined): string {
  const key = (compound ?? "").toUpperCase();
  return COMPOUND_LETTER[key] ?? "?";
}

/** Accent colours for the flag banner, keyed by track status. */
export const STATUS_COLOURS: Record<string, { bg: string; text: string; glow: string }> = {
  GREEN: { bg: "#00A24B", text: "#00160B", glow: "rgba(0,162,75,.55)" },
  YELLOW: { bg: "#FFCE00", text: "#221A00", glow: "rgba(255,206,0,.55)" },
  "DOUBLE YELLOW": { bg: "#FFB800", text: "#221A00", glow: "rgba(255,184,0,.6)" },
  "SAFETY CAR": { bg: "#FF8A00", text: "#231200", glow: "rgba(255,138,0,.6)" },
  "VIRTUAL SC": { bg: "#FFA92E", text: "#231200", glow: "rgba(255,169,46,.55)" },
  "RED FLAG": { bg: "#E8002D", text: "#FFFFFF", glow: "rgba(232,0,45,.65)" },
  CHEQUERED: { bg: "#F5F5F5", text: "#101014", glow: "rgba(245,245,245,.5)" },
  "—": { bg: "#2A2E39", text: "#8B93A7", glow: "rgba(0,0,0,0)" },
};
