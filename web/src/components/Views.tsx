/** Strategy, driver detail, championship standings and race control. */

import { motion } from "framer-motion";
import type { StandingRow, HistoryRace } from "../lib/api";
import type { Driver, RaceMessage, Snapshot } from "../lib/session";
import { compoundColour, compoundLetter } from "../lib/teams";
import { clockTime, gap, lapTime, pitDuration, sector } from "../lib/format";

const stagger = (index: number) => ({
  initial: { opacity: 0, y: 10 },
  animate: { opacity: 1, y: 0 },
  transition: { delay: Math.min(index * 0.018, 0.4), duration: 0.32, ease: [0.16, 1, 0.3, 1] as const },
});

// ---- strategy -------------------------------------------------------------

export function StrategyBoard({ snapshot }: { snapshot: Snapshot }) {
  const total = snapshot.totalLaps ?? Math.max(snapshot.leaderLap, 1);

  return (
    <div style={{ paddingBottom: 12 }}>
      <div className="strategy-row" style={{ color: "var(--text-faint)", fontSize: 9.5, letterSpacing: ".14em", textTransform: "uppercase", paddingTop: 12 }}>
        <span style={{ textAlign: "right" }}>P</span>
        <span>Driver</span>
        <span>Lap 1 → {total}</span>
        <span style={{ textAlign: "right" }}>Stops</span>
      </div>

      {snapshot.drivers.map((driver, index) => (
        <motion.div key={driver.number} className="strategy-row" {...stagger(index)}>
          <span className="pos" style={{ fontSize: 13 }}>
            {driver.position ?? "–"}
          </span>
          <span className="drv">
            <b style={{ color: driver.colour, fontSize: 13 }}>{driver.acronym}</b>
          </span>
          <div className="stint-track">
            {driver.stints.length === 0 && (
              <span style={{ alignSelf: "center", paddingLeft: 8, fontSize: 11, color: "var(--text-faint)" }}>
                no stint data
              </span>
            )}
            {driver.stints.map((stint) => {
              const laps = Math.max(stint.lapEnd - stint.lapStart + 1, 1);
              return (
                <motion.div
                  key={stint.stintNumber}
                  className="stint-seg"
                  initial={{ flexGrow: 0 }}
                  animate={{ flexGrow: laps / total }}
                  transition={{ duration: 0.55, ease: [0.16, 1, 0.3, 1] }}
                  style={{
                    background: compoundColour(stint.compound),
                    flexBasis: 0,
                    minWidth: 3,
                  }}
                  title={`${stint.compound} · laps ${stint.lapStart}–${stint.lapEnd}`}
                >
                  {laps / total > 0.06 ? compoundLetter(stint.compound) : ""}
                </motion.div>
              );
            })}
          </div>
          <span className="cell dim">{driver.pitStops.length}</span>
        </motion.div>
      ))}
    </div>
  );
}

// ---- driver detail --------------------------------------------------------

export function DriverPanel({ driver, snapshot }: { driver: Driver | null; snapshot: Snapshot }) {
  if (!driver) return <div className="empty">Pick a car from the timing tower or the track map.</div>;

  const last = driver.lastLap;
  const stint = driver.stints.at(-1);
  const tyreAge = stint ? stint.tyreAgeAtStart + Math.max(driver.lapNumber - stint.lapStart, 0) : null;

  return (
    <div>
      <div className="driver-hero">
        <div
          className="driver-hero-bg"
          style={{ background: `linear-gradient(105deg, ${driver.colour}, transparent 62%)` }}
        />
        {driver.headshot && (
          <motion.img
            className="driver-photo"
            src={driver.headshot}
            alt=""
            loading="lazy"
            style={{ borderColor: driver.colour }}
            initial={{ opacity: 0, scale: 0.9 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ duration: 0.45, ease: [0.16, 1, 0.3, 1] }}
            // F1's CDN serves a generic silhouette when it has no portrait;
            // an empty frame reads better than a stranger's outline.
            onError={(event) => {
              (event.currentTarget as HTMLImageElement).style.display = "none";
            }}
          />
        )}
        <motion.div
          className="driver-num-big"
          style={{ color: driver.colour, position: "relative" }}
          initial={{ opacity: 0, x: -14 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
        >
          {driver.number}
        </motion.div>
        <motion.div
          className="driver-names"
          style={{ position: "relative" }}
          initial={{ opacity: 0, x: -10 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ duration: 0.4, delay: 0.05, ease: [0.16, 1, 0.3, 1] }}
        >
          <b>{driver.firstName}</b>
          <strong>{driver.lastName}</strong>
          <b style={{ color: driver.colour, marginTop: 6 }}>{driver.team}</b>
        </motion.div>
      </div>

      <div className="stat-grid">
        <Stat label="Position" value={driver.position ?? "—"} />
        <Stat label="Lap" value={driver.lapNumber || "—"} />
        <Stat label="Gap to leader" value={gap(driver.gapToLeader, driver.position === 1)} />
        <Stat label="Interval" value={gap(driver.interval)} />
        <Stat label="Last lap" value={lapTime(last?.duration)} />
        <Stat label="Best lap" value={lapTime(driver.bestLap)} />
        <Stat label="Sector 1" value={sector(last?.sectors[0])} />
        <Stat label="Sector 2" value={sector(last?.sectors[1])} />
        <Stat label="Sector 3" value={sector(last?.sectors[2])} />
        <Stat label="Speed trap" value={last?.stSpeed ? `${last.stSpeed}` : "—"} />
        <Stat
          label="Tyre"
          value={stint ? `${compoundLetter(stint.compound)} · ${tyreAge}` : "—"}
          colour={stint ? compoundColour(stint.compound) : undefined}
        />
        <Stat label="Stops" value={driver.pitStops.length} />
      </div>

      {driver.stints.length > 0 && (
        <>
          <SectionTitle>Stints</SectionTitle>
          <table className="table">
            <thead>
              <tr>
                <th>#</th>
                <th>Compound</th>
                <th>Laps</th>
                <th className="num">Age at start</th>
              </tr>
            </thead>
            <tbody>
              {driver.stints.map((item) => (
                <tr key={item.stintNumber}>
                  <td className="num">{item.stintNumber}</td>
                  <td style={{ color: compoundColour(item.compound), fontWeight: 700 }}>{item.compound}</td>
                  <td className="tnum">
                    {item.lapStart}–{item.lapEnd}
                  </td>
                  <td className="num">{item.tyreAgeAtStart}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      {driver.pitStops.length > 0 && (
        <>
          <SectionTitle>Pit stops</SectionTitle>
          <table className="table">
            <thead>
              <tr>
                <th>Lap</th>
                <th>Time of day</th>
                <th className="num">Pit lane</th>
              </tr>
            </thead>
            <tbody>
              {driver.pitStops.map((stop, index) => (
                <tr key={index}>
                  <td className="num">{stop.lapNumber}</td>
                  <td className="tnum">{clockTime(stop.date)}</td>
                  <td className="num">{pitDuration(stop.duration)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      {snapshot.fastestLap?.driver === driver.number && (
        <div style={{ padding: 16, color: "var(--purple)", fontWeight: 700, fontSize: 13 }}>
          ★ Holds the fastest lap of the session
        </div>
      )}
    </div>
  );
}

function Stat({ label, value, colour }: { label: string; value: string | number; colour?: string }) {
  return (
    <div className="stat">
      <span>{label}</span>
      <b style={colour ? { color: colour } : undefined}>{value}</b>
    </div>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        padding: "16px 15px 8px",
        fontSize: 10,
        letterSpacing: ".16em",
        textTransform: "uppercase",
        color: "var(--text-faint)",
        fontWeight: 700,
      }}
    >
      {children}
    </div>
  );
}

// ---- standings ------------------------------------------------------------

export function StandingsView({
  drivers,
  constructors,
  winners,
  circuit,
  loading,
}: {
  drivers: StandingRow[];
  constructors: StandingRow[];
  winners: HistoryRace[];
  circuit: string;
  loading: boolean;
}) {
  if (loading && !drivers.length) return <div className="empty">Loading championship data…</div>;
  if (!drivers.length && !constructors.length) {
    return <div className="empty">Championship data is unavailable right now.</div>;
  }

  return (
    <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1.35fr) minmax(0,1fr)", gap: 14, padding: 14, alignItems: "start" }}>
      <div className="panel">
        <div className="panel-head">
          <h2>Drivers' championship</h2>
        </div>
        <div className="panel-body">
          <table className="table">
            <thead>
              <tr>
                <th style={{ width: 34 }}>P</th>
                <th>Driver</th>
                <th>Team</th>
                <th className="num">Wins</th>
                <th className="num">Points</th>
              </tr>
            </thead>
            <tbody>
              {drivers.map((row, index) => (
                <motion.tr key={row.Driver?.driverId ?? index} {...stagger(index)}>
                  <td className="num" style={{ fontWeight: 700 }}>{row.position}</td>
                  <td style={{ fontWeight: 600 }}>
                    {row.Driver?.givenName?.[0]}. {row.Driver?.familyName}
                  </td>
                  <td style={{ color: "var(--text-faint)" }}>{row.Constructors?.[0]?.name ?? "—"}</td>
                  <td className="num">{row.wins}</td>
                  <td className="num" style={{ color: "var(--yellow)", fontWeight: 700 }}>{row.points}</td>
                </motion.tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div style={{ display: "grid", gap: 14 }}>
        <div className="panel">
          <div className="panel-head">
            <h2>Constructors</h2>
          </div>
          <div className="panel-body">
            <table className="table">
              <thead>
                <tr>
                  <th style={{ width: 34 }}>P</th>
                  <th>Team</th>
                  <th className="num">Points</th>
                </tr>
              </thead>
              <tbody>
                {constructors.map((row, index) => (
                  <motion.tr key={row.Constructor?.constructorId ?? index} {...stagger(index)}>
                    <td className="num" style={{ fontWeight: 700 }}>{row.position}</td>
                    <td style={{ fontWeight: 600 }}>{row.Constructor?.name}</td>
                    <td className="num" style={{ color: "var(--yellow)", fontWeight: 700 }}>{row.points}</td>
                  </motion.tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {winners.length > 0 && (
          <div className="panel">
            <div className="panel-head">
              <h2>Past winners — {circuit}</h2>
            </div>
            <div className="panel-body">
              <table className="table">
                <thead>
                  <tr>
                    <th style={{ width: 54 }}>Year</th>
                    <th>Winner</th>
                    <th>Team</th>
                  </tr>
                </thead>
                <tbody>
                  {winners.slice(0, 14).map((race, index) => {
                    const win = race.Results?.[0];
                    if (!win) return null;
                    return (
                      <motion.tr key={race.season} {...stagger(index)}>
                        <td className="num" style={{ color: "var(--text-faint)" }}>{race.season}</td>
                        <td style={{ fontWeight: 600 }}>
                          {win.Driver.givenName[0]}. {win.Driver.familyName}
                        </td>
                        <td style={{ color: "var(--text-faint)" }}>{win.Constructor.name}</td>
                      </motion.tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ---- race control ---------------------------------------------------------

const FLAG_STYLES: Record<string, { bg: string; fg: string }> = {
  RED: { bg: "rgba(232,0,45,.2)", fg: "#ff7b91" },
  YELLOW: { bg: "rgba(255,209,46,.16)", fg: "#ffd970" },
  "DOUBLE YELLOW": { bg: "rgba(255,184,0,.18)", fg: "#ffc95c" },
  GREEN: { bg: "rgba(70,209,127,.16)", fg: "#6de0a0" },
  CHEQUERED: { bg: "rgba(245,245,245,.14)", fg: "#e8ecf5" },
  CLEAR: { bg: "rgba(70,209,127,.12)", fg: "#68d99b" },
  BLUE: { bg: "rgba(80,170,255,.16)", fg: "#79bcff" },
};

function messageStyle(message: RaceMessage) {
  const flag = (message.flag ?? "").toUpperCase();
  if (FLAG_STYLES[flag]) return FLAG_STYLES[flag];
  if (message.category === "SafetyCar") return { bg: "rgba(255,138,0,.16)", fg: "#ffab52" };
  if (message.category === "Drs") return { bg: "rgba(39,244,210,.13)", fg: "#5ff0d8" };
  return { bg: "rgba(255,255,255,.05)", fg: "var(--text-dim)" };
}

export function RaceControlFeed({ messages }: { messages: RaceMessage[] }) {
  const ordered = [...messages].reverse();
  if (!ordered.length) return <div className="empty">No race control messages yet.</div>;

  return (
    <div>
      {ordered.slice(0, 160).map((message, index) => {
        const style = messageStyle(message);
        return (
          <motion.div
            key={`${message.date}-${index}`}
            className="msg"
            initial={{ opacity: 0, x: -8 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ delay: Math.min(index * 0.012, 0.3), duration: 0.3 }}
          >
            <time>{clockTime(message.date)}</time>
            <p>
              <span className="msg-tag" style={{ background: style.bg, color: style.fg }}>
                {(message.flag ?? message.category).toUpperCase()}
              </span>
              {message.message}
            </p>
          </motion.div>
        );
      })}
    </div>
  );
}

// ---- driver rail ----------------------------------------------------------

/**
 * The Driver and Telemetry views are scoped to a single car, which leaves them
 * looking like a one-driver app unless the rest of the field sits beside them.
 * This rail is that field: every entry in the session, pickable, carrying just
 * enough context — position, tyre, last lap — to choose from without having to
 * go back to the timing tower.
 */
export function DriverRail({
  drivers,
  selected,
  onSelect,
}: {
  drivers: Driver[];
  selected: number | null;
  onSelect: (number: number) => void;
}) {
  return (
    <div className="panel driver-rail">
      <div className="panel-head">
        <h2>Drivers</h2>
        <span style={{ fontSize: 11, color: "var(--text-faint)" }}>{drivers.length} cars</span>
      </div>
      <div className="panel-body">
        {drivers.map((driver, index) => {
          const stint = driver.stints.at(-1);
          const age = stint
            ? stint.tyreAgeAtStart + Math.max(driver.lapNumber - stint.lapStart, 0)
            : null;
          return (
            <motion.button
              key={driver.number}
              type="button"
              className="rail-row"
              data-on={selected === driver.number}
              data-out={driver.retired}
              onClick={() => onSelect(driver.number)}
              {...stagger(index)}
            >
              <i className="rail-bar" style={{ background: driver.colour }} />
              <span className="rail-pos tnum">{driver.position ?? "–"}</span>
              <span className="rail-name">
                <b>{driver.acronym}</b>
                <em>{driver.team}</em>
              </span>
              <span className="rail-tail">
                {stint && (
                  <span
                    className="rail-tyre"
                    style={{ color: compoundColour(stint.compound) }}
                    title={`${stint.compound ?? "unknown"}${age != null ? ` · ${age} laps` : ""}`}
                  >
                    {compoundLetter(stint.compound)}
                    {age != null && <small>{age}</small>}
                  </span>
                )}
                <span className="tnum rail-lap">{lapTime(driver.lastLap?.duration ?? null)}</span>
              </span>
            </motion.button>
          );
        })}
      </div>
    </div>
  );
}
