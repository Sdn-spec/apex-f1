/**
 * Circuit geometry, derived from telemetry rather than bundled.
 *
 * No F1 circuit outline is published, so the outline here comes from the
 * fastest clean lap of the session: that car's racing line stands in for the
 * centreline, and corners are found by looking for sustained curvature along
 * it. Ported from the terminal app's Python implementation — the SVG renderer
 * draws a real smooth path rather than braille dots.
 */

export type Point = { x: number; y: number };

export interface Corner {
  number: number;
  x: number;
  y: number;
  angle: number;
  direction: "L" | "R";
  distance: number;
  severity: "fast" | "medium" | "slow" | "hairpin";
}

export interface TrackGeometry {
  points: Point[];
  corners: Corner[];
  bounds: { minX: number; minY: number; maxX: number; maxY: number };
  /** Approximate lap length in metres; OpenF1 units are roughly decimetres. */
  length: number;
  startFinish: Point;
  /** Cumulative distance along `points`, used to place a car by lap fraction. */
  cumulative: number[];
}

const distance = (a: Point, b: Point) => Math.hypot(b.x - a.x, b.y - a.y);

function pathLength(points: Point[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i += 1) total += distance(points[i - 1], points[i]);
  return total;
}

function dropStationary(points: Point[], minMove = 5): Point[] {
  const out: Point[] = [];
  for (const point of points) {
    if (!out.length || distance(out[out.length - 1], point) >= minMove) out.push(point);
  }
  return out;
}

function resample(points: Point[], step: number): Point[] {
  if (points.length < 2) return points.slice();
  const out: Point[] = [points[0]];
  let carry = 0;
  for (let i = 0; i < points.length - 1; i += 1) {
    const a = points[i];
    const b = points[i + 1];
    const segment = distance(a, b);
    if (segment <= 0) continue;
    let travelled = carry;
    while (travelled + step <= segment) {
      travelled += step;
      const t = travelled / segment;
      out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
    }
    carry = travelled - segment;
  }
  return out;
}

/**
 * Moving average with clamped edges. A lap trace rarely closes exactly on the
 * start/finish line, so wrapping would blend the overshoot into the first
 * corner and bend the geometry at the seam.
 */
function smooth(points: Point[], window = 3): Point[] {
  if (points.length < window * 2) return points.slice();
  const n = points.length;
  const out: Point[] = [];
  for (let i = 0; i < n; i += 1) {
    let sx = 0;
    let sy = 0;
    for (let k = -window; k <= window; k += 1) {
      const p = points[Math.min(Math.max(i + k, 0), n - 1)];
      sx += p.x;
      sy += p.y;
    }
    const count = window * 2 + 1;
    out.push({ x: sx / count, y: sy / count });
  }
  return out;
}

const wrapAngle = (angle: number) => ((angle + Math.PI) % (2 * Math.PI)) - Math.PI;
const heading = (a: Point, b: Point) => Math.atan2(b.y - a.y, b.x - a.x);

/**
 * Per-step heading change, treating the path as open. A derived lap overshoots
 * the start/finish line by a few metres, so the closing segment points
 * backwards along the track; wrapping the derivative across that seam injects a
 * phantom half-turn that smears into a fake corner.
 */
function turnRates(points: Point[]): number[] {
  const n = points.length;
  const deltas = new Array<number>(n).fill(0);
  for (let i = 1; i < n - 1; i += 1) {
    const prev = points[i - 1];
    const here = points[i];
    const next = points[i + 1];
    deltas[i] = wrapAngle(heading(here, next) - heading(prev, here));
  }
  return deltas;
}

function movingAverage(values: number[], halfWidth: number): number[] {
  const n = values.length;
  const window = halfWidth * 2 + 1;
  const out = new Array<number>(n);
  for (let i = 0; i < n; i += 1) {
    let sum = 0;
    for (let k = -halfWidth; k <= halfWidth; k += 1) {
      sum += values[Math.min(Math.max(i + k, 0), n - 1)];
    }
    out[i] = sum / window;
  }
  return out;
}

function severityOf(angle: number): Corner["severity"] {
  const degrees = Math.abs((angle * 180) / Math.PI);
  if (degrees > 120) return "hairpin";
  if (degrees > 70) return "slow";
  if (degrees > 35) return "medium";
  return "fast";
}

/**
 * Corners are runs of same-signed curvature. Thresholds are turn radii rather
 * than per-sample angles, so they mean the same thing on a short street circuit
 * as on a long road course, and hysteresis stops a mid-corner easing from
 * splitting one turn in two.
 */
export function detectCorners(
  points: Point[],
  { enterRadius = 1700, exitRadius = 4200, minTotal = (22 * Math.PI) / 180, maxGapUnits = 260 } = {},
): Corner[] {
  const n = points.length;
  if (n < 60) return [];

  const raw = turnRates(points);
  const smoothed = movingAverage(raw, 6);

  const cumulative = [0];
  for (let i = 1; i < n; i += 1) cumulative.push(cumulative[i - 1] + distance(points[i - 1], points[i]));
  const step = cumulative[n - 1] / Math.max(n - 1, 1);
  if (step <= 0) return [];

  const enter = step / enterRadius;
  const release = step / exitRadius;
  const maxGap = Math.max(Math.floor(maxGapUnits / step), 2);

  const runs: { indices: number[]; sign: number }[] = [];
  let current: number[] = [];
  let sign = 0;
  let gap = 0;

  const flush = () => {
    while (current.length && Math.abs(smoothed[current[current.length - 1]]) < release) current.pop();
    if (current.length) runs.push({ indices: current, sign });
    current = [];
    sign = 0;
    gap = 0;
  };

  for (let i = 0; i < n; i += 1) {
    const value = smoothed[i];
    const thisSign = value >= 0 ? 1 : -1;
    if (!current.length) {
      if (Math.abs(value) >= enter) {
        current = [i];
        sign = thisSign;
        gap = 0;
      }
      continue;
    }
    if (thisSign !== sign && Math.abs(value) >= enter) {
      flush();
      current = [i];
      sign = thisSign;
      gap = 0;
      continue;
    }
    if (Math.abs(value) >= release && thisSign === sign) {
      current.push(i);
      gap = 0;
      continue;
    }
    gap += 1;
    if (gap > maxGap) flush();
    else current.push(i);
  }
  flush();

  const corners: Corner[] = [];
  for (const run of runs) {
    const total = run.indices.reduce((sum, i) => sum + raw[i], 0);
    if (Math.abs(total) < minTotal) continue;
    const apex = run.indices.reduce((best, i) =>
      Math.abs(smoothed[i]) > Math.abs(smoothed[best]) ? i : best,
    );
    corners.push({
      number: 0,
      x: points[apex].x,
      y: points[apex].y,
      angle: total,
      direction: run.sign > 0 ? "L" : "R",
      distance: cumulative[apex] / 10,
      severity: severityOf(total),
    });
  }

  corners.sort((a, b) => a.distance - b.distance);
  corners.forEach((corner, index) => {
    corner.number = index + 1;
  });
  return corners;
}

export function buildGeometry(samples: { x: number; y: number }[]): TrackGeometry | null {
  const raw: Point[] = [];
  for (const sample of samples) {
    if (sample.x == null || sample.y == null) continue;
    if (sample.x === 0 && sample.y === 0) continue;
    raw.push({ x: sample.x, y: sample.y });
  }
  if (raw.length < 40) return null;

  let points = dropStationary(raw);
  if (points.length < 40) return null;
  const step = Math.max(pathLength(points) / 1500, 1);
  points = smooth(resample(points, step), 3);
  if (points.length < 30) return null;

  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const cumulative = [0];
  for (let i = 1; i < points.length; i += 1) {
    cumulative.push(cumulative[i - 1] + distance(points[i - 1], points[i]));
  }

  return {
    points,
    corners: detectCorners(points),
    bounds: {
      minX: Math.min(...xs),
      minY: Math.min(...ys),
      maxX: Math.max(...xs),
      maxY: Math.max(...ys),
    },
    length: pathLength(points) / 10,
    startFinish: points[0],
    cumulative,
  };
}

/**
 * A closed Catmull-Rom spline expressed as SVG cubic bezier segments. The
 * resampled centreline has hundreds of points; drawing it as a polyline reads
 * as faceted at large sizes, and a spline through every Nth point stays smooth.
 */
export function toSvgPath(points: Point[], stride = 4): string {
  const sampled: Point[] = [];
  for (let i = 0; i < points.length; i += stride) sampled.push(points[i]);
  if (sampled.length < 4) return "";

  const n = sampled.length;
  const at = (i: number) => sampled[((i % n) + n) % n];
  let d = `M ${at(0).x.toFixed(1)} ${at(0).y.toFixed(1)}`;
  for (let i = 0; i < n; i += 1) {
    const p0 = at(i - 1);
    const p1 = at(i);
    const p2 = at(i + 1);
    const p3 = at(i + 2);
    const c1 = { x: p1.x + (p2.x - p0.x) / 6, y: p1.y + (p2.y - p0.y) / 6 };
    const c2 = { x: p2.x - (p3.x - p1.x) / 6, y: p2.y - (p3.y - p1.y) / 6 };
    d += ` C ${c1.x.toFixed(1)} ${c1.y.toFixed(1)}, ${c2.x.toFixed(1)} ${c2.y.toFixed(1)}, ${p2.x.toFixed(1)} ${p2.y.toFixed(1)}`;
  }
  return `${d} Z`;
}

/** Direction of travel at a point on the centreline, for pointing a car marker. */
export function headingAt(geometry: TrackGeometry, index: number): number {
  const points = geometry.points;
  const n = points.length;
  const a = points[Math.max(index - 2, 0)];
  const b = points[Math.min(index + 2, n - 1)];
  return (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI;
}

export function nearestIndex(geometry: TrackGeometry, x: number, y: number): number {
  let best = 0;
  let bestDistance = Infinity;
  for (let i = 0; i < geometry.points.length; i += 1) {
    const point = geometry.points[i];
    const d = (point.x - x) ** 2 + (point.y - y) ** 2;
    if (d < bestDistance) {
      bestDistance = d;
      best = i;
    }
  }
  return best;
}
