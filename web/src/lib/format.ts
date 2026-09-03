/** Display helpers shared across the views. */

export function lapTime(seconds: number | null | undefined): string {
  if (seconds == null || seconds < 0) return "—";
  const minutes = Math.floor(seconds / 60);
  const rest = seconds - minutes * 60;
  if (minutes > 0) return `${minutes}:${rest.toFixed(3).padStart(6, "0")}`;
  return rest.toFixed(3);
}

export function gap(value: number | string | null | undefined, leader = false): string {
  if (leader) return "LEADER";
  if (value == null) return "—";
  // OpenF1 sends "+1 LAP" / "+2 LAPS" for lapped runners.
  if (typeof value === "string") return value.replace("LAPS", "L").replace("LAP", "L").trim();
  if (value === 0) return "—";
  return `+${value.toFixed(3)}`;
}

export function sector(value: number | null | undefined): string {
  return value == null ? "—" : value.toFixed(3);
}

export function clockTime(epoch: number): string {
  return new Date(epoch).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

export function shortDate(iso: string): string {
  return new Date(iso).toLocaleDateString([], { day: "numeric", month: "short" });
}

export function windArrow(direction: number | null | undefined): string {
  if (direction == null) return "";
  const arrows = "↑↗→↘↓↙←↖";
  return arrows[Math.round((((direction % 360) + 360) % 360) / 45) % 8];
}

export function pitDuration(seconds: number | null | undefined): string {
  if (seconds == null) return "—";
  // Stops served under a red flag last minutes, not seconds.
  if (seconds >= 120) return `${Math.floor(seconds / 60)}m${String(Math.floor(seconds % 60)).padStart(2, "0")}s`;
  return `${seconds.toFixed(1)}s`;
}

export function ordinal(value: number): string {
  const remainder = value % 100;
  if (remainder >= 11 && remainder <= 13) return `${value}th`;
  switch (value % 10) {
    case 1:
      return `${value}st`;
    case 2:
      return `${value}nd`;
    case 3:
      return `${value}rd`;
    default:
      return `${value}th`;
  }
}
