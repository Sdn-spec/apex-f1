/**
 * The live track map.
 *
 * The circuit is an SVG spline through the derived centreline, drawn as a wide
 * dark "asphalt" stroke with a thin dashed line down the middle. Cars ride on
 * top as team-coloured markers.
 *
 * Motion is handled outside React: the snapshot only changes a few times a
 * second, so car markers are moved by writing transforms directly in a
 * requestAnimationFrame loop, easing towards the latest projected coordinates.
 * Routing twenty markers per frame through React state would re-render the
 * whole tower along with them.
 */

import { memo, useEffect, useMemo, useRef } from "react";
import type { Driver } from "../lib/session";
import { toSvgPath, type TrackGeometry } from "../lib/track";

interface Props {
  geometry: TrackGeometry | null;
  drivers: Driver[];
  selected: number | null;
  onSelect: (number: number) => void;
  showCorners: boolean;
  showLabels: boolean;
}

/**
 * Breathing room around the circuit, as a fraction of its longest dimension.
 * It has to clear more than the centreline: car markers, their name tags and a
 * car sitting in the pit lane all fall outside the bounds of the racing line.
 */
const PADDING_RATIO = 0.09;

function TrackMapImpl({ geometry, drivers, selected, onSelect, showCorners, showLabels }: Props) {
  const groupRefs = useRef(new Map<number, SVGGElement>());
  const targets = useRef(new Map<number, { x: number; y: number }>());
  const current = useRef(new Map<number, { x: number; y: number }>());
  const frame = useRef(0);

  const view = useMemo(() => {
    if (!geometry) return null;
    const { minX, minY, maxX, maxY } = geometry.bounds;
    const pad = Math.max(maxX - minX, maxY - minY) * PADDING_RATIO;
    return {
      // SVG y grows downward while track y grows north, so every coordinate
      // that reaches the canvas is negated — the centreline here, and the cars,
      // corners and start/finish below. Flipping only some of them puts the
      // circuit and the cars in different coordinate spaces.
      path: toSvgPath(
        geometry.points.map((point) => ({ x: point.x, y: -point.y })),
        3,
      ),
      viewBox: `${minX - pad} ${-(maxY + pad)} ${maxX - minX + pad * 2} ${maxY - minY + pad * 2}`,
      span: Math.max(maxX - minX, maxY - minY),
    };
  }, [geometry]);

  // Feed the animation loop the latest coordinates without re-rendering.
  useEffect(() => {
    for (const driver of drivers) {
      if (driver.x == null || driver.y == null) continue;
      targets.current.set(driver.number, { x: driver.x, y: -driver.y });
    }
  }, [drivers]);

  useEffect(() => {
    const tick = () => {
      frame.current = requestAnimationFrame(tick);
      for (const [number, target] of targets.current) {
        const node = groupRefs.current.get(number);
        if (!node) continue;
        let position = current.current.get(number);
        if (!position) {
          position = { ...target };
          current.current.set(number, position);
        }
        const dx = target.x - position.x;
        const dy = target.y - position.y;
        // A jump this large is a seek or a lap wrap, not motion — snap instead
        // of sliding the marker across the infield.
        const snap = Math.hypot(dx, dy) > (view?.span ?? 1e9) * 0.25;
        position.x = snap ? target.x : position.x + dx * 0.18;
        position.y = snap ? target.y : position.y + dy * 0.18;
        node.setAttribute("transform", `translate(${position.x.toFixed(1)} ${position.y.toFixed(1)})`);
      }
    };
    frame.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame.current);
  }, [view?.span]);

  if (!geometry || !view) {
    return (
      <div className="empty">
        <div>
          <div style={{ fontSize: 30, marginBottom: 12 }}>◠</div>
          Tracing the circuit from lap telemetry…
        </div>
      </div>
    );
  }

  const scale = view.span / 1000;
  const trackWidth = Math.max(scale * 26, 14);
  const carRadius = Math.max(scale * 15, 9);
  const labelSize = Math.max(scale * 21, 12);
  const running = drivers.filter((d) => !d.retired && d.x != null && d.y != null);

  // Under a restart queue or a safety car the whole field bunches into a few
  // car lengths, and twenty overlapping name tags are less readable than none.
  // Label from the front of the race backwards, skipping any car that would
  // sit on top of one already labelled.
  const labelled = new Set<number>();
  const minGap = view.span * 0.045;
  for (const driver of [...running].sort((a, b) => (a.position ?? 99) - (b.position ?? 99))) {
    const clashes = [...labelled].some((number) => {
      const other = running.find((d) => d.number === number);
      return other && Math.hypot(other.x! - driver.x!, other.y! - driver.y!) < minGap;
    });
    if (!clashes) labelled.add(driver.number);
  }

  return (
    <div className="map-wrap">
      <svg viewBox={view.viewBox} preserveAspectRatio="xMidYMid meet" role="img" aria-label="Circuit map">
        <defs>
          <linearGradient id="asphalt" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="#2b3145" />
            <stop offset="100%" stopColor="#1b2030" />
          </linearGradient>
          <filter id="carGlow" x="-120%" y="-120%" width="340%" height="340%">
            <feGaussianBlur stdDeviation={carRadius * 0.55} result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>

        {/* Track surface: a soft outer halo, the asphalt body, then a dashed centreline. */}
        <path
          d={view.path}
          fill="none"
          stroke="rgba(90,130,255,.07)"
          strokeWidth={trackWidth * 2.1}
          strokeLinejoin="round"
        />
        <path
          d={view.path}
          fill="none"
          stroke="url(#asphalt)"
          strokeWidth={trackWidth}
          strokeLinejoin="round"
          strokeLinecap="round"
        />
        <path
          d={view.path}
          fill="none"
          stroke="rgba(255,255,255,.16)"
          strokeWidth={Math.max(trackWidth * 0.045, 1)}
          strokeDasharray={`${trackWidth * 0.5} ${trackWidth * 0.85}`}
        />

        <g transform={`translate(${geometry.startFinish.x} ${-geometry.startFinish.y})`}>
          <rect
            x={-trackWidth * 0.5}
            y={-trackWidth * 0.5}
            width={trackWidth}
            height={trackWidth}
            fill="#f2f4f8"
            opacity={0.9}
            rx={trackWidth * 0.12}
          />
        </g>

        {showCorners &&
          geometry.corners.map((corner) => (
            <text
              key={corner.number}
              x={corner.x}
              y={-corner.y}
              fill="#5a6480"
              fontSize={labelSize * 0.82}
              fontWeight={700}
              textAnchor="middle"
              dominantBaseline="middle"
              style={{ pointerEvents: "none" }}
            >
              {corner.number}
            </text>
          ))}

        {running.map((driver) => {
          const isSelected = driver.number === selected;
          const leader = driver.position === 1;
          return (
            <g
              key={driver.number}
              ref={(node) => {
                if (node) groupRefs.current.set(driver.number, node);
                else groupRefs.current.delete(driver.number);
              }}
              onClick={() => onSelect(driver.number)}
              style={{ cursor: "pointer" }}
            >
              {(isSelected || leader) && (
                <circle
                  r={carRadius * 1.85}
                  fill="none"
                  stroke={driver.colour}
                  strokeWidth={carRadius * 0.16}
                  opacity={isSelected ? 0.85 : 0.4}
                />
              )}
              <circle
                r={carRadius}
                fill={driver.colour}
                stroke="#080910"
                strokeWidth={carRadius * 0.22}
                filter={isSelected || leader ? "url(#carGlow)" : undefined}
                opacity={driver.inPit ? 0.45 : 1}
              />
              {((showLabels && labelled.has(driver.number)) || isSelected) && (
                <text
                  x={carRadius * 2}
                  y={carRadius * 0.42}
                  fill={isSelected ? "#fff" : "#c3cbdd"}
                  fontSize={labelSize}
                  fontWeight={800}
                  style={{ pointerEvents: "none" }}
                >
                  {driver.acronym}
                </text>
              )}
            </g>
          );
        })}
      </svg>

      <div className="map-legend">
        <span>{geometry.corners.length} corners</span>
        <span>{(geometry.length / 1000).toFixed(3)} km</span>
        <span>{running.length} cars running</span>
      </div>
    </div>
  );
}

export const TrackMap = memo(TrackMapImpl);
