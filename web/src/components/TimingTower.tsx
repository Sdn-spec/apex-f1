/**
 * The timing tower.
 *
 * Rows are keyed by driver number and laid out with Framer Motion's `layout`,
 * so when the order changes the rows physically slide past each other instead
 * of the numbers blinking to new values. A gain or loss also flashes the row in
 * green or red, which is what makes an overtake readable at a glance.
 */

import { AnimatePresence, motion } from "framer-motion";
import { useEffect, useRef, useState } from "react";
import type { Driver, Snapshot } from "../lib/session";
import { compoundColour, compoundLetter } from "../lib/teams";
import { gap, lapTime, sector } from "../lib/format";

const EPSILON = 1e-4;

interface Props {
  snapshot: Snapshot;
  selected: number | null;
  onSelect: (number: number) => void;
  detailed?: boolean;
}

/** Remembers each driver's previous position so a change can be animated. */
function usePositionDeltas(drivers: Driver[]) {
  const previous = useRef(new Map<number, number>());
  const [deltas, setDeltas] = useState(new Map<number, number>());

  useEffect(() => {
    const changed = new Map<number, number>();
    for (const driver of drivers) {
      if (driver.position == null) continue;
      const before = previous.current.get(driver.number);
      if (before != null && before !== driver.position) {
        changed.set(driver.number, before - driver.position);
      }
      previous.current.set(driver.number, driver.position);
    }
    if (!changed.size) return;
    setDeltas(changed);
    const timer = setTimeout(() => setDeltas(new Map()), 1900);
    return () => clearTimeout(timer);
  }, [drivers]);

  return deltas;
}

function lapClass(snapshot: Snapshot, driver: Driver): string {
  const last = driver.lastLap?.duration;
  if (last == null) return "cell dim";
  if (snapshot.fastestLap?.driver === driver.number && Math.abs(last - snapshot.fastestLap.time) < EPSILON) {
    return "cell purple";
  }
  if (driver.bestLap != null && Math.abs(last - driver.bestLap) < EPSILON) return "cell green";
  return "cell yellow";
}

/** A driver's own best is purple only when it is also the session's fastest. */
function bestClass(snapshot: Snapshot, driver: Driver): string {
  if (driver.bestLap == null) return "cell dim";
  if (snapshot.fastestLap?.driver === driver.number) return "cell purple";
  return "cell dim";
}

function sectorClass(snapshot: Snapshot, driver: Driver, index: number): string {
  const value = driver.lastLap?.sectors[index];
  if (value == null) return "cell dim";
  const overall = snapshot.bestSectors[index];
  if (overall && Math.abs(value - overall.time) < EPSILON) return "cell purple";
  const personal = driver.bestSectors[index];
  if (personal != null && Math.abs(value - personal) < EPSILON) return "cell green";
  return "cell";
}

export function TimingTower({ snapshot, selected, onSelect, detailed = false }: Props) {
  const deltas = usePositionDeltas(snapshot.drivers);

  return (
    <div className="tower">
      <div className={detailed ? "tower-head detailed" : "tower-head"}>
        <span style={{ textAlign: "right" }}>P</span>
        <span>Driver</span>
        <span>{detailed ? "Team" : ""}</span>
        <span style={{ textAlign: "right" }}>Gap</span>
        <span style={{ textAlign: "right" }}>Int</span>
        <span style={{ textAlign: "right" }}>Last</span>
        {detailed && <span style={{ textAlign: "right" }}>Best</span>}
        {detailed && <span style={{ textAlign: "right" }}>S1</span>}
        {detailed && <span style={{ textAlign: "right" }}>S2</span>}
        {detailed && <span style={{ textAlign: "right" }}>S3</span>}
        {detailed && <span style={{ textAlign: "right" }}>Trap</span>}
        <span style={{ textAlign: "right" }}>Tyre</span>
        {!detailed && <span style={{ textAlign: "right" }} />}
      </div>

      {snapshot.drivers.map((driver) => {
        const delta = deltas.get(driver.number) ?? 0;
        const isSelected = driver.number === selected;
        return (
          <motion.div
            key={driver.number}
            layout
            layoutId={`row-${driver.number}`}
            transition={{ type: "spring", stiffness: 620, damping: 44, mass: 0.85 }}
            className={detailed ? "row detailed" : "row"}
            data-selected={isSelected}
            data-out={driver.retired}
            onClick={() => onSelect(driver.number)}
          >
            <span className="row-accent" style={{ background: driver.colour }} />

            <AnimatePresence>
              {delta !== 0 && (
                <motion.span
                  className="row-flash"
                  initial={{ opacity: 0.55 }}
                  animate={{ opacity: 0 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 1.6, ease: "easeOut" }}
                  style={{
                    background:
                      delta > 0
                        ? "linear-gradient(90deg, rgba(70,209,127,.42), transparent 62%)"
                        : "linear-gradient(90deg, rgba(232,0,45,.42), transparent 62%)",
                  }}
                />
              )}
            </AnimatePresence>

            <span className="pos">{driver.position ?? "–"}</span>

            <span className="drv">
              <span className="drv-num">{driver.number}</span>
              <b style={{ color: driver.colour }}>{driver.acronym}</b>
            </span>

            <span className="team-name">
              {detailed ? driver.team : driver.inPit ? <em className="badge-pit">IN PIT</em> : null}
            </span>

            <span className="cell dim">
              {driver.retired ? (
                <em className="badge-out">OUT</em>
              ) : (
                gap(driver.gapToLeader, driver.position === 1)
              )}
            </span>
            <span className="cell">{driver.retired ? "—" : gap(driver.interval)}</span>
            <span className={lapClass(snapshot, driver)}>{lapTime(driver.lastLap?.duration)}</span>

            {detailed && (
              <span className={bestClass(snapshot, driver)}>{lapTime(driver.bestLap)}</span>
            )}
            {detailed &&
              [0, 1, 2].map((index) => (
                <span key={index} className={sectorClass(snapshot, driver, index)}>
                  {sector(driver.lastLap?.sectors[index])}
                </span>
              ))}
            {detailed && (
              <span className="cell dim">{driver.lastLap?.stSpeed ?? "—"}</span>
            )}

            <span className="tyre">
              {driver.stints.length ? (
                <>
                  <span
                    className="tyre-dot"
                    style={{ color: compoundColour(driver.stints.at(-1)?.compound) }}
                  >
                    {compoundLetter(driver.stints.at(-1)?.compound)}
                  </span>
                  <span className="tyre-age">
                    {driver.stints.at(-1)
                      ? driver.stints.at(-1)!.tyreAgeAtStart +
                        Math.max(driver.lapNumber - driver.stints.at(-1)!.lapStart, 0)
                      : "—"}
                  </span>
                </>
              ) : (
                <span className="cell dim">—</span>
              )}
            </span>

            {!detailed && (
              <span className="cell dim">{driver.pitStops.length || "—"}</span>
            )}
          </motion.div>
        );
      })}
    </div>
  );
}
