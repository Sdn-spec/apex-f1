/** Session identity, flag state, lap counter and conditions. */

import { AnimatePresence, motion } from "framer-motion";
import type { SessionInfo } from "../lib/api";
import type { Snapshot } from "../lib/session";
import { STATUS_COLOURS } from "../lib/teams";
import { lapTime, windArrow } from "../lib/format";

interface Props {
  info: SessionInfo;
  snapshot: Snapshot | null;
  circuitLength: number | null;
  onPickSession: () => void;
}

export function TopBar({ info, snapshot, circuitLength, onPickSession }: Props) {
  const status = snapshot?.trackStatus ?? "—";
  const colours = STATUS_COLOURS[status] ?? STATUS_COLOURS["—"];
  const weather = snapshot?.weather;
  const fastest = snapshot?.fastestLap;
  const fastestDriver = fastest ? snapshot?.byNumber.get(fastest.driver) : undefined;
  // Yellow, safety car and red are the states worth pulling the eye; a settled
  // green flag should not throb for two hours.
  const alert = status !== "GREEN" && status !== "—" && status !== "CHEQUERED";

  return (
    <header className="topbar">
      <div className="brand">
        APE<span>X</span>
        <small>Race Control</small>
      </div>

      <button className="session-title" onClick={onPickSession} title="Change session">
        <b>
          {info.country_name} {info.session_name}
        </b>
        <span>
          {info.circuit_short_name} · {info.year}
          {circuitLength ? ` · ${(circuitLength / 1000).toFixed(3)} km` : ""}
        </span>
      </button>

      <AnimatePresence mode="wait">
        <motion.div
          key={status}
          className="status-chip"
          initial={{ opacity: 0, y: -6, scale: 0.94 }}
          animate={{
            opacity: 1,
            y: 0,
            scale: 1,
            boxShadow: alert
              ? [`0 0 0 0 ${colours.glow}`, `0 0 26px 5px ${colours.glow}`, `0 0 0 0 ${colours.glow}`]
              : `0 0 18px -4px ${colours.glow}`,
          }}
          exit={{ opacity: 0, y: 6, scale: 0.94 }}
          transition={{
            duration: 0.28,
            boxShadow: alert ? { duration: 1.7, repeat: Infinity, ease: "easeInOut" } : undefined,
          }}
          style={{ background: colours.bg, color: colours.text }}
        >
          {status}
        </motion.div>
      </AnimatePresence>

      {snapshot && (
        <div className="lap-counter">
          <em>Lap</em>
          <b>{snapshot.leaderLap}</b>
          {snapshot.totalLaps ? <i>/ {snapshot.totalLaps}</i> : null}
        </div>
      )}

      <div className="spacer" />

      {fastest && fastestDriver && (
        <div className="wx-item">
          <b style={{ color: "var(--purple)" }}>
            {fastestDriver.acronym} {lapTime(fastest.time)}
          </b>
          <span>Fastest lap</span>
        </div>
      )}

      {weather && (
        <div className="wx">
          {weather.airTemperature != null && (
            <div className="wx-item">
              <b>{weather.airTemperature.toFixed(1)}°</b>
              <span>Air</span>
            </div>
          )}
          {weather.trackTemperature != null && (
            <div className="wx-item">
              <b>{weather.trackTemperature.toFixed(1)}°</b>
              <span>Track</span>
            </div>
          )}
          {weather.humidity != null && (
            <div className="wx-item">
              <b>{weather.humidity.toFixed(0)}%</b>
              <span>Humidity</span>
            </div>
          )}
          {weather.windSpeed != null && (
            <div className="wx-item">
              <b>
                {weather.windSpeed.toFixed(1)} {windArrow(weather.windDirection)}
              </b>
              <span>Wind m/s</span>
            </div>
          )}
          {weather.rainfall ? <span className="rain-badge">RAIN</span> : null}
        </div>
      )}
    </header>
  );
}
