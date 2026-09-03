/**
 * Race analysis: how the gaps evolved and how the tyres fell away.
 *
 * Both charts are hand-drawn SVG rather than a charting library — the data is
 * a few hundred points per driver and the only interaction is hovering a
 * legend entry, so a dependency would cost more than it saves.
 */

import { useMemo, useState } from "react";
import { motion } from "framer-motion";
import type { Driver, Session, Snapshot } from "../lib/session";
import { compoundColour } from "../lib/teams";
import { lapTime } from "../lib/format";

const W = 1000;
const H = 300;
const PAD = { left: 54, right: 18, top: 16, bottom: 30 };

interface Props {
  session: Session;
  snapshot: Snapshot;
  selected: number | null;
  onSelect: (number: number) => void;
}

export function AnalysisView({ session, snapshot, selected, onSelect }: Props) {
  const [mode, setMode] = useState<"gap" | "pace">("gap");
  const [hovered, setHovered] = useState<number | null>(null);

  const gaps = useMemo(() => session.gapHistory(snapshot.now), [session, snapshot.now]);
  const laps = useMemo(() => session.lapHistory(snapshot.now), [session, snapshot.now]);

  // Only the runners worth reading; twenty overlapping lines is noise.
  const shown = snapshot.drivers.filter((d) => !d.retired).slice(0, 10);
  const focus = hovered ?? selected;

  return (
    <div style={{ padding: 14, display: "grid", gap: 14 }}>
      <div className="panel">
        <div className="panel-head">
          <h2>{mode === "gap" ? "Gap to leader" : "Lap time evolution"}</h2>
          <div style={{ display: "flex", gap: 8 }}>
            <button className="pill" data-on={mode === "gap"} onClick={() => setMode("gap")}>
              Gaps
            </button>
            <button className="pill" data-on={mode === "pace"} onClick={() => setMode("pace")}>
              Pace
            </button>
          </div>
        </div>
        <div style={{ padding: "14px 16px" }}>
          {mode === "gap" ? (
            <GapChart drivers={shown} gaps={gaps} focus={focus} />
          ) : (
            <PaceChart drivers={shown} laps={laps} focus={focus} />
          )}
          <div className="chart-legend">
            {shown.map((driver) => (
              <button
                key={driver.number}
                className="legend-chip"
                data-on={focus === driver.number}
                onMouseEnter={() => setHovered(driver.number)}
                onMouseLeave={() => setHovered(null)}
                onClick={() => onSelect(driver.number)}
              >
                <i style={{ background: driver.colour }} />
                {driver.acronym}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="panel">
        <div className="panel-head">
          <h2>Tyre degradation by stint</h2>
          <span style={{ fontSize: 11, color: "var(--text-faint)" }}>
            {focus ? snapshot.byNumber.get(focus)?.fullName : "select a driver"}
          </span>
        </div>
        <div style={{ padding: "14px 16px" }}>
          <DegradationChart
            driver={focus != null ? (snapshot.byNumber.get(focus) ?? null) : null}
            laps={focus != null ? (laps.get(focus) ?? []) : []}
          />
        </div>
      </div>
    </div>
  );
}

function axes(xTicks: { at: number; label: string }[], yTicks: { at: number; label: string }[]) {
  return (
    <>
      {yTicks.map((tick) => (
        <g key={`y${tick.label}`}>
          <line x1={PAD.left} x2={W - PAD.right} y1={tick.at} y2={tick.at} stroke="rgba(255,255,255,.06)" />
          <text x={PAD.left - 8} y={tick.at + 3.5} textAnchor="end" fontSize={10} fill="#616b83">
            {tick.label}
          </text>
        </g>
      ))}
      {xTicks.map((tick) => (
        <text key={`x${tick.label}`} x={tick.at} y={H - PAD.bottom + 16} textAnchor="middle" fontSize={10} fill="#616b83">
          {tick.label}
        </text>
      ))}
    </>
  );
}

function GapChart({
  drivers,
  gaps,
  focus,
}: {
  drivers: Driver[];
  gaps: Map<number, { lap: number; gap: number }[]>;
  focus: number | null;
}) {
  const series = drivers.map((d) => ({ driver: d, points: gaps.get(d.number) ?? [] }));
  const allLaps = series.flatMap((s) => s.points.map((p) => p.lap));
  const allGaps = series.flatMap((s) => s.points.map((p) => p.gap));
  if (!allLaps.length) return <div className="empty">Not enough data yet.</div>;

  const maxLap = Math.max(...allLaps, 1);
  const maxGap = Math.max(...allGaps, 5);
  const x = (lap: number) => PAD.left + (lap / maxLap) * (W - PAD.left - PAD.right);
  const y = (value: number) => PAD.top + (value / maxGap) * (H - PAD.top - PAD.bottom);

  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", height: "auto", display: "block" }}>
      {axes(
        [0, 0.25, 0.5, 0.75, 1].map((f) => ({ at: x(maxLap * f), label: `L${Math.round(maxLap * f)}` })),
        [0, 0.25, 0.5, 0.75, 1].map((f) => ({ at: y(maxGap * f), label: `+${(maxGap * f).toFixed(0)}s` })),
      )}
      {series.map(({ driver, points }) => {
        if (points.length < 2) return null;
        const dim = focus != null && focus !== driver.number;
        return (
          <motion.polyline
            key={driver.number}
            points={points.map((p) => `${x(p.lap).toFixed(1)},${y(p.gap).toFixed(1)}`).join(" ")}
            fill="none"
            stroke={driver.colour}
            strokeWidth={focus === driver.number ? 3 : 1.8}
            strokeOpacity={dim ? 0.18 : 1}
            strokeLinejoin="round"
            initial={{ pathLength: 0 }}
            animate={{ pathLength: 1 }}
            transition={{ duration: 0.9, ease: "easeOut" }}
          />
        );
      })}
    </svg>
  );
}

function PaceChart({
  drivers,
  laps,
  focus,
}: {
  drivers: Driver[];
  laps: Map<number, { lap: number; time: number }[]>;
  focus: number | null;
}) {
  const series = drivers.map((d) => ({ driver: d, points: laps.get(d.number) ?? [] }));
  const all = series.flatMap((s) => s.points);
  if (all.length < 2) return <div className="empty">Not enough completed laps yet.</div>;

  const times = all.map((p) => p.time).sort((a, b) => a - b);
  const fastest = times[0];
  // Clip the slow tail so safety-car laps do not squash the interesting range.
  const slowest = times[Math.floor(times.length * 0.94)] ?? times[times.length - 1];
  const maxLap = Math.max(...all.map((p) => p.lap), 1);
  const span = Math.max(slowest - fastest, 0.5);

  const x = (lap: number) => PAD.left + (lap / maxLap) * (W - PAD.left - PAD.right);
  const y = (time: number) =>
    PAD.top + Math.min(Math.max((time - fastest) / span, 0), 1) * (H - PAD.top - PAD.bottom);

  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", height: "auto", display: "block" }}>
      {axes(
        [0, 0.25, 0.5, 0.75, 1].map((f) => ({ at: x(maxLap * f), label: `L${Math.round(maxLap * f)}` })),
        [0, 0.5, 1].map((f) => ({ at: y(fastest + span * f), label: lapTime(fastest + span * f) })),
      )}
      {series.map(({ driver, points }) => {
        if (points.length < 2) return null;
        const dim = focus != null && focus !== driver.number;
        return (
          <motion.polyline
            key={driver.number}
            points={points.map((p) => `${x(p.lap).toFixed(1)},${y(p.time).toFixed(1)}`).join(" ")}
            fill="none"
            stroke={driver.colour}
            strokeWidth={focus === driver.number ? 2.6 : 1.4}
            strokeOpacity={dim ? 0.14 : 0.95}
            strokeLinejoin="round"
            initial={{ pathLength: 0 }}
            animate={{ pathLength: 1 }}
            transition={{ duration: 0.9, ease: "easeOut" }}
          />
        );
      })}
    </svg>
  );
}

function DegradationChart({
  driver,
  laps,
}: {
  driver: Driver | null;
  laps: { lap: number; time: number; compound: string | null }[];
}) {
  if (!driver || laps.length < 3) {
    return <div className="empty">Pick a driver above to see how their tyres fell away.</div>;
  }

  const times = laps.map((l) => l.time).sort((a, b) => a - b);
  const fastest = times[0];
  const representative = times.filter((time) => time < fastest * 1.15);
  const slowest = representative[representative.length - 1] ?? times[times.length - 1];
  const span = Math.max(slowest - fastest, 0.4);
  const maxLap = Math.max(...laps.map((l) => l.lap), 1);
  const x = (lap: number) => PAD.left + (lap / maxLap) * (W - PAD.left - PAD.right);
  const y = (time: number) =>
    PAD.top + Math.min(Math.max((time - fastest) / span, 0), 1) * (210 - PAD.top - PAD.bottom);

  return (
    <svg viewBox={`0 0 ${W} 210`} style={{ width: "100%", height: "auto", display: "block" }}>
      {[0, 0.5, 1].map((f) => (
        <g key={f}>
          <line x1={PAD.left} x2={W - PAD.right} y1={y(fastest + span * f)} y2={y(fastest + span * f)} stroke="rgba(255,255,255,.06)" />
          <text x={PAD.left - 8} y={y(fastest + span * f) + 3.5} textAnchor="end" fontSize={10} fill="#616b83">
            {lapTime(fastest + span * f)}
          </text>
        </g>
      ))}
      {laps.map((entry, index) => (
        <motion.circle
          key={`${entry.lap}-${index}`}
          cx={x(entry.lap)}
          cy={y(entry.time)}
          r={3.4}
          fill={compoundColour(entry.compound)}
          initial={{ opacity: 0, scale: 0 }}
          animate={{ opacity: 0.92, scale: 1 }}
          transition={{ delay: Math.min(index * 0.006, 0.5), duration: 0.25 }}
        />
      ))}
    </svg>
  );
}
