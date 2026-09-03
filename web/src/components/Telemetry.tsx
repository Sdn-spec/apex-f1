/**
 * Live car telemetry for the selected driver.
 *
 * `car_data` arrives at about 4 Hz, so the traces are drawn as plain SVG
 * polylines over a rolling window rather than animated point by point — what
 * reads as motion is the window sliding as the clock advances.
 */

import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import type { Driver, Session, Telemetry as Sample } from "../lib/session";
import { drsOpen } from "../lib/session";

interface Props {
  session: Session;
  driver: Driver | null;
  now: number;
}

const WINDOW_MS = 45_000;

export function TelemetryPanel({ session, driver, now }: Props) {
  const [samples, setSamples] = useState<Sample[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!driver) return;
    let cancelled = false;
    setLoading(true);
    session
      .loadTelemetry(driver.number, now, WINDOW_MS)
      .then((rows) => {
        if (!cancelled) setSamples(rows);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // Refetch as the window slides, not on every projection tick.
  }, [session, driver?.number, Math.floor(now / 15_000)]);

  if (!driver) return <div className="empty">Select a driver to see their telemetry.</div>;
  if (!samples.length) {
    return <div className="empty">{loading ? "Loading telemetry…" : "No telemetry for this window."}</div>;
  }

  const latest = samples[samples.length - 1];

  return (
    <div style={{ padding: 14, display: "grid", gap: 14 }}>
      <div className="stat-grid" style={{ borderRadius: 12, overflow: "hidden" }}>
        <Readout label="Speed" value={latest.speed ?? "—"} unit="km/h" colour={driver.colour} big />
        <Readout label="Gear" value={latest.gear ?? "—"} />
        <Readout label="Throttle" value={latest.throttle ?? "—"} unit="%" />
        <Readout label="Brake" value={latest.brake ? "ON" : "off"} colour={latest.brake ? "#ff5a6e" : undefined} />
        <Readout label="RPM" value={latest.rpm ?? "—"} />
        <Readout
          label="DRS"
          value={drsOpen(latest.drs) ? "OPEN" : "closed"}
          colour={drsOpen(latest.drs) ? "var(--cyan)" : undefined}
        />
      </div>

      <Trace
        title="Speed"
        unit="km/h"
        samples={samples}
        pick={(s) => s.speed}
        colour={driver.colour}
        max={360}
      />
      <Trace
        title="Throttle"
        unit="%"
        samples={samples}
        pick={(s) => s.throttle}
        colour="#46d17f"
        max={100}
      />
      <Trace
        title="Brake"
        unit="%"
        samples={samples}
        pick={(s) => s.brake}
        colour="#ff5a6e"
        max={100}
      />
      <Trace title="Gear" unit="" samples={samples} pick={(s) => s.gear} colour="#b388ff" max={8} steps />
    </div>
  );
}

function Readout({
  label,
  value,
  unit,
  colour,
  big,
}: {
  label: string;
  value: string | number;
  unit?: string;
  colour?: string;
  big?: boolean;
}) {
  return (
    <div className="stat">
      <span>{label}</span>
      <b style={{ color: colour, fontSize: big ? 26 : undefined }}>
        {value}
        {unit ? <small style={{ fontSize: 11, color: "var(--text-faint)", marginLeft: 4 }}>{unit}</small> : null}
      </b>
    </div>
  );
}

function Trace({
  title,
  unit,
  samples,
  pick,
  colour,
  max,
  steps,
}: {
  title: string;
  unit: string;
  samples: Sample[];
  pick: (sample: Sample) => number | null;
  colour: string;
  max: number;
  steps?: boolean;
}) {
  const width = 1000;
  const height = 120;
  const values = samples.map(pick);
  const first = samples[0]?.date ?? 0;
  const span = Math.max((samples[samples.length - 1]?.date ?? 0) - first, 1);

  const points: string[] = [];
  samples.forEach((sample, index) => {
    const value = values[index];
    if (value == null) return;
    const x = ((sample.date - first) / span) * width;
    const y = height - (Math.min(value, max) / max) * height;
    // Gear is a discrete quantity; interpolating between gears would draw
    // ramps through gears the car never selected.
    if (steps && points.length) points.push(`${x.toFixed(1)},${points[points.length - 1].split(",")[1]}`);
    points.push(`${x.toFixed(1)},${y.toFixed(1)}`);
  });

  return (
    <div className="panel" style={{ padding: "12px 14px 8px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
        <span style={{ fontSize: 10, letterSpacing: ".14em", textTransform: "uppercase", color: "var(--text-faint)", fontWeight: 700 }}>
          {title}
        </span>
        <span style={{ fontSize: 10, color: "var(--text-faint)" }}>
          0–{max} {unit}
        </span>
      </div>
      <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" style={{ width: "100%", height: 110, display: "block" }}>
        {[0.25, 0.5, 0.75].map((fraction) => (
          <line
            key={fraction}
            x1={0}
            x2={width}
            y1={height * fraction}
            y2={height * fraction}
            stroke="rgba(255,255,255,.06)"
            strokeWidth={1}
          />
        ))}
        <motion.polyline
          points={points.join(" ")}
          fill="none"
          stroke={colour}
          strokeWidth={2.5}
          strokeLinejoin="round"
          strokeLinecap="round"
          vectorEffect="non-scaling-stroke"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.35 }}
        />
      </svg>
    </div>
  );
}
