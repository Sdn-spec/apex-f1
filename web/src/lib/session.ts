/**
 * Session state: folds OpenF1's flat record feeds into a live race picture.
 *
 * A clock is the only difference between watching a live race and replaying a
 * finished one. Both run the same projection: for each driver take the newest
 * record at or before "now". Replay is deliberately time-honest — it shows only
 * what was known at the replayed moment, never what the finished session's data
 * reveals about the rest of the race.
 */

import {
  openf1,
  type IntervalRow,
  type LapRow,
  type LocationRow,
  type PitRow,
  type PositionRow,
  type RaceControlRow,
  type RadioRow,
  type ResultRow,
  type SessionInfo,
  type StintRow,
  type WeatherRow,
} from "./api";
import { buildGeometry, type TrackGeometry } from "./track";
import { teamColour } from "./teams";

/** Longest a pit record's window is trusted to mean "in the pit lane". */
const MAX_PIT_WINDOW = 90_000;

/**
 * How long a car's feed must go quiet, relative to the middle of the field,
 * before it counts as retired.
 */
const RETIREMENT_SILENCE = 210_000;

export type TrackStatus =
  | "GREEN"
  | "YELLOW"
  | "DOUBLE YELLOW"
  | "SAFETY CAR"
  | "VIRTUAL SC"
  | "RED FLAG"
  | "CHEQUERED"
  | "—";

export interface Stint {
  stintNumber: number;
  compound: string;
  lapStart: number;
  lapEnd: number;
  tyreAgeAtStart: number;
}

export interface PitStop {
  lapNumber: number;
  date: number;
  duration: number | null;
}

export interface LapInfo {
  lapNumber: number;
  duration: number | null;
  sectors: [number | null, number | null, number | null];
  stSpeed: number | null;
  i1Speed: number | null;
  i2Speed: number | null;
  isPitOut: boolean;
}

export interface Driver {
  number: number;
  acronym: string;
  fullName: string;
  firstName: string;
  lastName: string;
  team: string;
  colour: string;
  headshot: string | null;
  position: number | null;
  gapToLeader: number | string | null;
  interval: number | null;
  lapNumber: number;
  lastLap: LapInfo | null;
  bestLap: number | null;
  bestSectors: [number | null, number | null, number | null];
  stints: Stint[];
  pitStops: PitStop[];
  inPit: boolean;
  retired: boolean;
  lastSeen: number | null;
  x: number | null;
  y: number | null;
  /** Fraction of a lap completed, used to place the marker on the SVG path. */
  trackIndex: number | null;
}

export interface Weather {
  airTemperature: number | null;
  trackTemperature: number | null;
  humidity: number | null;
  windSpeed: number | null;
  windDirection: number | null;
  rainfall: number | null;
}

export interface RaceMessage {
  date: number;
  category: string;
  message: string;
  flag: string | null;
  driverNumber: number | null;
}

export interface RadioClip {
  date: number;
  driverNumber: number;
  url: string;
}

export interface Telemetry {
  date: number;
  speed: number | null;
  throttle: number | null;
  brake: number | null;
  gear: number | null;
  rpm: number | null;
  drs: number | null;
}

export interface Snapshot {
  now: number;
  drivers: Driver[];
  byNumber: Map<number, Driver>;
  trackStatus: TrackStatus;
  weather: Weather;
  messages: RaceMessage[];
  radio: RadioClip[];
  leaderLap: number;
  totalLaps: number | null;
  fastestLap: { driver: number; time: number } | null;
  bestSectors: ({ driver: number; time: number } | null)[];
}

/** DRS codes 10, 12 and 14 all mean the flap is open. */
export const drsOpen = (code: number | null | undefined) =>
  code === 10 || code === 12 || code === 14;

const ms = (iso: string | null | undefined): number | null => {
  if (!iso) return null;
  const value = Date.parse(iso);
  return Number.isNaN(value) ? null : value;
};

// ---- clocks ---------------------------------------------------------------

export interface Clock {
  now(): number;
  readonly isLive: boolean;
}

export class LiveClock implements Clock {
  readonly isLive = true;
  now() {
    return Date.now();
  }
}

export class ReplayClock implements Clock {
  readonly isLive = false;
  private virtual: number;
  private anchor = Date.now();
  paused = false;
  speed = 1;

  constructor(
    readonly start: number,
    readonly end: number,
    speed = 1,
    startAt?: number,
  ) {
    this.speed = speed;
    this.virtual = startAt != null ? Math.min(Math.max(startAt, start), end) : start;
  }

  now(): number {
    if (!this.paused) {
      const elapsed = Date.now() - this.anchor;
      this.virtual = Math.min(this.virtual + elapsed * this.speed, this.end);
      this.anchor = Date.now();
      if (this.virtual >= this.end) this.paused = true;
    }
    return this.virtual;
  }

  setPaused(paused: boolean) {
    this.now();
    this.paused = paused;
    this.anchor = Date.now();
  }

  setSpeed(speed: number) {
    this.now();
    this.speed = Math.min(Math.max(speed, 0.25), 60);
  }

  seek(seconds: number) {
    this.now();
    this.virtual = Math.min(Math.max(this.virtual + seconds * 1000, this.start), this.end);
    this.anchor = Date.now();
  }

  seekFraction(fraction: number) {
    this.virtual = this.start + (this.end - this.start) * Math.min(Math.max(fraction, 0), 1);
    this.anchor = Date.now();
  }

  get progress(): number {
    const span = this.end - this.start;
    return span <= 0 ? 1 : Math.min(Math.max((this.virtual - this.start) / span, 0), 1);
  }
}

// ---- timed series ---------------------------------------------------------

/** Not every feed is per-car (weather is not), so the key is read defensively. */
const driverOf = (row: unknown): number | null =>
  (row as { driver_number?: number | null }).driver_number ?? null;

class TimedSeries<T> {
  dates: number[] = [];
  rows: T[] = [];
  private seen = new Set<string>();

  extend(records: (T & { date: string })[]): void {
    const fresh: { date: number; row: T }[] = [];
    for (const row of records) {
      const date = ms(row.date);
      if (date == null) continue;
      // OpenF1's comparison filter is inclusive, so polling re-sends the
      // record sitting on the cursor boundary.
      const token = `${date}:${driverOf(row) ?? 0}`;
      if (this.seen.has(token)) continue;
      this.seen.add(token);
      fresh.push({ date, row });
    }
    if (!fresh.length) return;
    fresh.sort((a, b) => a.date - b.date);
    for (const item of fresh) {
      this.dates.push(item.date);
      this.rows.push(item.row);
    }
    if (this.dates.some((value, index) => index > 0 && value < this.dates[index - 1])) {
      const order = this.dates.map((_, i) => i).sort((a, b) => this.dates[a] - this.dates[b]);
      this.dates = order.map((i) => this.dates[i]);
      this.rows = order.map((i) => this.rows[i]);
    }
  }

  private cut(now: number): number {
    let low = 0;
    let high = this.dates.length;
    while (low < high) {
      const mid = (low + high) >> 1;
      if (this.dates[mid] <= now) low = mid + 1;
      else high = mid;
    }
    return low;
  }

  upto(now: number): T[] {
    return this.rows.slice(0, this.cut(now));
  }

  latest(now: number): T | null {
    const cut = this.cut(now);
    return cut ? this.rows[cut - 1] : null;
  }

  latestPerDriver(now: number): Map<number, { date: number; row: T }> {
    const cut = this.cut(now);
    const latest = new Map<number, { date: number; row: T }>();
    for (let i = 0; i < cut; i += 1) {
      const number = driverOf(this.rows[i]);
      if (number != null) latest.set(number, { date: this.dates[i], row: this.rows[i] });
    }
    return latest;
  }

  get newest(): number | null {
    return this.dates.length ? this.dates[this.dates.length - 1] : null;
  }
}

// ---- location buffer ------------------------------------------------------

/**
 * The location feed is by far the largest endpoint — roughly 3.7 samples per
 * second per car — so it is never fetched whole. A sliding window is kept
 * around the clock position and refilled just before it runs out.
 */
class LocationBuffer {
  private samples = new Map<number, { dates: number[]; points: { x: number; y: number }[] }>();
  /**
   * Coverage is a real interval, not just a forward edge. Tracking only the
   * far end cannot express "the clock has moved back before what we hold",
   * which is exactly what rewinding does.
   */
  private coveredFrom: number | null = null;
  private coveredTo: number | null = null;
  private fetching = false;

  constructor(
    private readonly sessionKey: number,
    private readonly windowMs = 60_000,
  ) {}

  async ensure(now: number, live: boolean): Promise<void> {
    if (this.fetching) return;

    const margin = this.windowMs * 0.35;
    const inside =
      this.coveredFrom != null &&
      this.coveredTo != null &&
      now >= this.coveredFrom &&
      now + margin < this.coveredTo;
    if (inside) return;

    // Extending forward keeps what is already buffered and appends the next
    // slice. Any other case — a rewind, or a jump past the end — has landed
    // outside the window entirely, so the buffer is refilled around the new
    // position instead.
    const extendsForward =
      this.coveredFrom != null &&
      this.coveredTo != null &&
      now >= this.coveredFrom &&
      now - this.coveredTo < this.windowMs * 3;

    const refill = !extendsForward;
    const start = refill ? now - this.windowMs * 0.25 : this.coveredTo!;
    let end = now + this.windowMs;
    if (live) end = Math.min(end, Date.now());
    if (end <= start) return;

    if (refill) this.samples.clear();

    this.fetching = true;
    try {
      const rows = await openf1.location(this.sessionKey, {
        start: new Date(start),
        end: new Date(end),
      });
      this.ingest(rows);
      // Both ends move together and only on success. Recording the new start
      // before the request lands would, if it failed, leave a window that
      // claims to cover the clock while holding no samples for it — and since
      // that claim suppresses the next fetch, the cars would never come back.
      if (refill) this.coveredFrom = start;
      this.coveredTo = end;
    } catch {
      if (refill) {
        this.coveredFrom = null;
        this.coveredTo = null;
      }
    } finally {
      this.fetching = false;
    }
  }

  private ingest(rows: LocationRow[]): void {
    for (const row of rows) {
      if (row.x == null || row.y == null) continue;
      if (row.x === 0 && row.y === 0) continue;
      const date = ms(row.date);
      if (date == null) continue;
      let entry = this.samples.get(row.driver_number);
      if (!entry) {
        entry = { dates: [], points: [] };
        this.samples.set(row.driver_number, entry);
      }
      // Insert in order rather than appending. A window fetched after a seek
      // can predate what is already held, and an append-only buffer would
      // silently drop every one of those samples.
      const at = lowerBound(entry.dates, date);
      if (entry.dates[at] === date) continue;
      entry.dates.splice(at, 0, date);
      entry.points.splice(at, 0, { x: row.x, y: row.y });
    }
    this.trim();
  }

  /** Keep the buffer bounded without discarding the part around the clock. */
  private trim(): void {
    for (const entry of this.samples.values()) {
      const excess = entry.dates.length - 6000;
      if (excess > 0) {
        entry.dates.splice(0, excess);
        entry.points.splice(0, excess);
      }
    }
  }

  at(number: number, now: number): { x: number; y: number } | null {
    const entry = this.samples.get(number);
    if (!entry || !entry.dates.length) return null;
    const { dates, points } = entry;
    const index = lowerBound(dates, now + 1);
    // Clamp to the ends rather than returning null: while a refill after a
    // seek is in flight the nearest known point is a better answer than
    // leaving the car frozen wherever it was last drawn.
    if (index === 0) return points[0];
    if (index >= dates.length) return points[points.length - 1];
    const spanMs = dates[index] - dates[index - 1];
    if (spanMs <= 0) return points[index - 1];
    const ratio = (now - dates[index - 1]) / spanMs;
    const a = points[index - 1];
    const b = points[index];
    return { x: a.x + (b.x - a.x) * ratio, y: a.y + (b.y - a.y) * ratio };
  }
}

/** First index whose value is >= target. */
function lowerBound(values: number[], target: number): number {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (values[mid] < target) low = mid + 1;
    else high = mid;
  }
  return low;
}

// ---- the session ----------------------------------------------------------

export class Session {
  geometry: TrackGeometry | null = null;
  totalLaps: number | null = null;
  private drivers = new Map<number, Driver>();
  private position = new TimedSeries<PositionRow>();
  private intervals = new TimedSeries<IntervalRow>();
  private weather = new TimedSeries<WeatherRow>();
  private raceControl = new TimedSeries<RaceControlRow>();
  private laps: LapRow[] = [];
  private stints: StintRow[] = [];
  private pits: PitRow[] = [];
  private results: ResultRow[] = [];
  private radioClips: RadioClip[] = [];
  /** Feeds that did not load, so the UI can say why a view looks empty. */
  readonly failures: string[] = [];
  private location: LocationBuffer;
  /** Telemetry is fetched per driver on demand; nobody reads twenty traces. */
  private telemetry = new Map<number, { fetchedAt: number; samples: Telemetry[] }>();

  constructor(
    readonly info: SessionInfo,
    readonly clock: Clock,
  ) {
    this.location = new LocationBuffer(info.session_key);
  }

  get sessionKey(): number {
    return this.info.session_key;
  }

  get startTime(): number {
    return ms(this.info.date_start) ?? Date.now();
  }

  get endTime(): number {
    return ms(this.info.date_end) ?? this.startTime + 7_200_000;
  }

  async loadDrivers(): Promise<void> {
    const rows = await openf1.drivers(this.sessionKey);
    for (const row of rows) {
      if (!row.driver_number) continue;
      const name = row.full_name ?? row.broadcast_name ?? String(row.driver_number);
      const parts = name.split(" ");
      this.drivers.set(row.driver_number, {
        number: row.driver_number,
        acronym: row.name_acronym ?? String(row.driver_number),
        fullName: name,
        firstName: parts[0] ?? "",
        lastName: parts.slice(1).join(" ") || name,
        team: row.team_name ?? "—",
        colour: teamColour(row.team_name, row.team_colour),
        headshot: row.headshot_url ?? null,
        position: null,
        gapToLeader: null,
        interval: null,
        lapNumber: 0,
        lastLap: null,
        bestLap: null,
        bestSectors: [null, null, null],
        stints: [],
        pitStops: [],
        inPit: false,
        retired: false,
        lastSeen: null,
        x: null,
        y: null,
        trackIndex: null,
      });
    }
  }

  /** A session that has ended can never change, so its feeds are cacheable. */
  get isFinished(): boolean {
    return Date.now() > this.endTime;
  }

  async loadTiming(onProgress?: (label: string) => void): Promise<void> {
    const keep = this.isFinished;
    const steps: [string, () => Promise<void>][] = [
      ["positions", async () => this.position.extend(await openf1.position(this.sessionKey, undefined, keep))],
      ["gaps", async () => this.intervals.extend(await openf1.intervals(this.sessionKey, undefined, keep))],
      ["lap times", async () => void (this.laps = await openf1.laps(this.sessionKey, undefined, keep))],
      ["tyre stints", async () => void (this.stints = await openf1.stints(this.sessionKey, keep))],
      ["pit stops", async () => void (this.pits = await openf1.pit(this.sessionKey, keep))],
      ["weather", async () => this.weather.extend(await openf1.weather(this.sessionKey, keep))],
      ["race control", async () => this.raceControl.extend(await openf1.raceControl(this.sessionKey, keep))],
      ["classification", async () => void (this.results = await openf1.results(this.sessionKey, keep))],
      [
        "team radio",
        async () => {
          const rows: RadioRow[] = await openf1.teamRadio(this.sessionKey, keep);
          this.radioClips = rows
            .map((row) => ({
              date: ms(row.date) ?? 0,
              driverNumber: row.driver_number,
              url: row.recording_url,
            }))
            .filter((clip) => clip.date && clip.url)
            .sort((a, b) => a.date - b.date);
        },
      ],
    ];
    this.failures.length = 0;
    for (const [label, run] of steps) {
      onProgress?.(label);
      try {
        await run();
      } catch {
        // One failed feed leaves its column empty rather than blocking the
        // whole app, but it is recorded so the UI can explain the gap instead
        // of just rendering nothing.
        this.failures.push(label);
      }
    }
    this.inferTotalLaps();
  }

  /** Derive the circuit outline from the fastest clean lap of the session. */
  async loadGeometry(): Promise<TrackGeometry | null> {
    const clean = this.laps
      .filter(
        (lap) =>
          lap.lap_duration != null &&
          lap.lap_duration > 45 &&
          lap.lap_duration < 300 &&
          !lap.is_pit_out_lap &&
          lap.date_start,
      )
      .sort((a, b) => (a.lap_duration ?? 0) - (b.lap_duration ?? 0));

    for (const candidate of clean.slice(0, 4)) {
      const start = ms(candidate.date_start);
      if (start == null) continue;
      try {
        const rows = await openf1.location(this.sessionKey, {
          driverNumber: candidate.driver_number,
          start: new Date(start),
          end: new Date(start + (candidate.lap_duration ?? 0) * 1000 + 1500),
          cache: true,
        });
        const geometry = buildGeometry(rows);
        if (geometry) {
          this.geometry = geometry;
          return geometry;
        }
      } catch {
        continue;
      }
    }
    return null;
  }

  async pollLive(): Promise<void> {
    if (!this.clock.isLive) return;
    const [positions, intervals, laps, stints, pits, weather, control] = await Promise.all([
      openf1.position(this.sessionKey, this.position.newest ? new Date(this.position.newest) : undefined).catch(() => []),
      openf1.intervals(this.sessionKey, this.intervals.newest ? new Date(this.intervals.newest) : undefined).catch(() => []),
      openf1.laps(this.sessionKey).catch(() => this.laps),
      openf1.stints(this.sessionKey).catch(() => this.stints),
      openf1.pit(this.sessionKey).catch(() => this.pits),
      openf1.weather(this.sessionKey).catch(() => []),
      openf1.raceControl(this.sessionKey).catch(() => []),
    ]);
    this.position.extend(positions);
    this.intervals.extend(intervals);
    this.laps = laps;
    this.stints = stints;
    this.pits = pits;
    this.weather.extend(weather);
    this.raceControl.extend(control);
  }

  async ensureLocations(now: number): Promise<void> {
    await this.location.ensure(now, this.clock.isLive);
  }

  /**
   * Recent telemetry for one car. Fetched per driver rather than for the field,
   * because the trace view only ever shows the selected car and `car_data` is
   * a 4 Hz feed — twenty of those would be megabytes per minute.
   */
  async loadTelemetry(driverNumber: number, now: number, windowMs = 45_000): Promise<Telemetry[]> {
    const cached = this.telemetry.get(driverNumber);
    if (cached && Math.abs(cached.fetchedAt - now) < windowMs * 0.4) return cached.samples;
    try {
      const rows = await openf1.carData(this.sessionKey, {
        driverNumber,
        start: new Date(now - windowMs),
        end: new Date(now + 1000),
      });
      const samples = rows
        .map((row) => ({
          date: ms(row.date) ?? 0,
          speed: row.speed,
          throttle: row.throttle,
          brake: row.brake,
          gear: row.n_gear,
          rpm: row.rpm,
          drs: row.drs,
        }))
        .filter((sample) => sample.date)
        .sort((a, b) => a.date - b.date);
      this.telemetry.set(driverNumber, { fetchedAt: now, samples });
      return samples;
    } catch {
      return cached?.samples ?? [];
    }
  }

  /**
   * Completed laps per driver up to `now`, for the analysis charts. Read from
   * the same lap feed the tower uses, so it inherits the same "has the car
   * actually crossed the line yet" rule.
   */
  lapHistory(now: number): Map<number, { lap: number; time: number; compound: string | null }[]> {
    const stintFor = (driverNumber: number, lap: number): string | null => {
      const stint = this.stints.find(
        (row) => row.driver_number === driverNumber && row.lap_start <= lap && lap <= row.lap_end,
      );
      return stint?.compound ?? null;
    };

    const history = new Map<number, { lap: number; time: number; compound: string | null }[]>();
    for (const row of this.laps) {
      const started = ms(row.date_start);
      if (started == null || row.lap_duration == null) continue;
      if (started + row.lap_duration * 1000 > now) continue;
      if (row.is_pit_out_lap) continue;
      // Safety-car and traffic laps are minutes long and would flatten the
      // y-axis for every genuine lap on the chart.
      if (row.lap_duration > 240) continue;
      const list = history.get(row.driver_number) ?? [];
      list.push({
        lap: row.lap_number,
        time: row.lap_duration,
        compound: stintFor(row.driver_number, row.lap_number),
      });
      history.set(row.driver_number, list);
    }
    for (const list of history.values()) list.sort((a, b) => a.lap - b.lap);
    return history;
  }

  /** Gap to the leader over time, sampled once per leader lap. */
  gapHistory(now: number): Map<number, { lap: number; gap: number }[]> {
    const byDriver = new Map<number, { lap: number; gap: number }[]>();
    const leaderTimes: { lap: number; at: number }[] = [];
    for (const row of this.laps) {
      const started = ms(row.date_start);
      if (started == null || started > now) continue;
      const existing = leaderTimes.find((entry) => entry.lap === row.lap_number);
      if (!existing) leaderTimes.push({ lap: row.lap_number, at: started });
      else if (started < existing.at) existing.at = started;
    }
    leaderTimes.sort((a, b) => a.lap - b.lap);

    for (const { lap, at } of leaderTimes) {
      for (const [number, { row }] of this.intervals.latestPerDriver(at)) {
        const value = row.gap_to_leader;
        if (typeof value !== "number") continue;
        const list = byDriver.get(number) ?? [];
        list.push({ lap, gap: value });
        byDriver.set(number, list);
      }
    }
    return byDriver;
  }

  private inferTotalLaps(): void {
    const laps = this.results.map((row) => row.number_of_laps ?? 0).filter(Boolean);
    if (laps.length) this.totalLaps = Math.max(...laps);
  }

  /** Cheap per-frame update: move the cars without reprojecting all timing. */
  updatePositions(now: number, into: Map<number, Driver>): void {
    for (const [number, driver] of into) {
      const point = this.location.at(number, now);
      if (!point) continue;
      driver.x = point.x;
      driver.y = point.y;
      if (this.geometry) {
        driver.trackIndex = nearestOnPath(this.geometry, point.x, point.y);
      }
    }
  }

  project(now: number): Snapshot {
    const drivers = new Map<number, Driver>();
    for (const [number, base] of this.drivers) {
      drivers.set(number, {
        ...base,
        position: null,
        gapToLeader: null,
        interval: null,
        inPit: false,
        lapNumber: 0,
        lastLap: null,
        bestLap: null,
        bestSectors: [null, null, null],
        stints: [],
        pitStops: [],
        lastSeen: null,
      });
    }

    for (const [number, { date, row }] of this.position.latestPerDriver(now)) {
      const driver = drivers.get(number);
      if (!driver) continue;
      if (row.position != null) driver.position = row.position;
      driver.lastSeen = date;
    }

    for (const [number, { date, row }] of this.intervals.latestPerDriver(now)) {
      const driver = drivers.get(number);
      if (!driver) continue;
      driver.gapToLeader = row.gap_to_leader;
      driver.interval = typeof row.interval === "number" ? row.interval : null;
      if (driver.lastSeen == null || date > driver.lastSeen) driver.lastSeen = date;
    }

    let fastestLap: Snapshot["fastestLap"] = null;
    const bestSectors: Snapshot["bestSectors"] = [null, null, null];

    for (const row of this.laps) {
      const driver = drivers.get(row.driver_number);
      if (!driver) continue;
      const started = ms(row.date_start);
      if (started == null || started > now) continue;
      driver.lapNumber = Math.max(driver.lapNumber, row.lap_number);

      // A lap only counts once the car has actually crossed the line.
      const duration = row.lap_duration;
      if (duration == null || started + duration * 1000 > now) continue;

      const sectors: LapInfo["sectors"] = [
        row.duration_sector_1,
        row.duration_sector_2,
        row.duration_sector_3,
      ];
      driver.lastLap = {
        lapNumber: row.lap_number,
        duration,
        sectors,
        stSpeed: row.st_speed,
        i1Speed: row.i1_speed,
        i2Speed: row.i2_speed,
        isPitOut: Boolean(row.is_pit_out_lap),
      };

      if (!row.is_pit_out_lap && duration > 0 && duration < 600) {
        if (driver.bestLap == null || duration < driver.bestLap) driver.bestLap = duration;
        if (!fastestLap || duration < fastestLap.time) {
          fastestLap = { driver: driver.number, time: duration };
        }
      }
      sectors.forEach((value, index) => {
        if (value == null || value <= 0) return;
        const personal = driver.bestSectors[index];
        if (personal == null || value < personal) driver.bestSectors[index] = value;
        const overall = bestSectors[index];
        if (!overall || value < overall.time) bestSectors[index] = { driver: driver.number, time: value };
      });
    }

    const leaderLap = Math.max(0, ...[...drivers.values()].map((d) => d.lapNumber));

    for (const row of [...this.stints].sort(
      (a, b) => a.driver_number - b.driver_number || a.stint_number - b.stint_number,
    )) {
      const driver = drivers.get(row.driver_number);
      if (!driver) continue;
      const current = Math.max(driver.lapNumber, 1);
      if (row.lap_start > current) continue;
      // A finished session reports each stint's final lap_end; unclamped it
      // would draw a strategy bar past the lap the replay has reached.
      const lapEnd = Math.min(row.lap_end || current, current);
      driver.stints.push({
        stintNumber: row.stint_number,
        compound: (row.compound ?? "UNKNOWN").toUpperCase(),
        lapStart: row.lap_start,
        lapEnd: Math.max(lapEnd, row.lap_start),
        tyreAgeAtStart: row.tyre_age_at_start ?? 0,
      });
    }

    for (const row of this.pits) {
      const driver = drivers.get(row.driver_number);
      if (!driver) continue;
      const when = ms(row.date);
      if (when == null || when > now) continue;
      const duration = row.pit_duration ?? row.lane_duration;
      driver.pitStops.push({ lapNumber: row.lap_number, date: when, duration });
      // Red-flag stops report durations of many minutes, which would otherwise
      // pin a driver to PIT for the rest of the race.
      const window = Math.min((duration ?? 30) * 1000, MAX_PIT_WINDOW);
      if (now - when >= 0 && now - when <= window) driver.inPit = true;
    }

    const weatherRow = this.weather.latest(now);
    const weather: Weather = {
      airTemperature: weatherRow?.air_temperature ?? null,
      trackTemperature: weatherRow?.track_temperature ?? null,
      humidity: weatherRow?.humidity ?? null,
      windSpeed: weatherRow?.wind_speed ?? null,
      windDirection: weatherRow?.wind_direction ?? null,
      rainfall: weatherRow?.rainfall ?? null,
    };

    const messages: RaceMessage[] = this.raceControl.upto(now).map((row) => ({
      date: ms(row.date) ?? 0,
      category: row.category ?? "Other",
      message: (row.message ?? "").trim(),
      flag: row.flag,
      driverNumber: row.driver_number,
    }));

    this.applyRetirements(drivers, now, leaderLap);
    this.updatePositions(now, drivers);

    const ordered = [...drivers.values()].sort((a, b) => {
      if (a.position && b.position) return a.position - b.position;
      if (a.position) return -1;
      if (b.position) return 1;
      return a.number - b.number;
    });

    return {
      now,
      drivers: ordered,
      byNumber: drivers,
      trackStatus: deriveTrackStatus(messages),
      weather,
      messages,
      radio: this.radioClips.filter((clip) => clip.date <= now),
      leaderLap,
      totalLaps: this.totalLaps,
      fastestLap,
      bestSectors,
    };
  }

  /**
   * Who is out, using only what was known at `now`. The final classification
   * says who retired but not when, so consulting it mid-race would show a car
   * as OUT while the replay still has it circulating. What marks a retirement
   * at a given moment is the timing feed going quiet for that car.
   */
  private applyRetirements(drivers: Map<number, Driver>, now: number, leaderLap: number): void {
    const dnf = new Set(
      this.results.filter((row) => row.dnf || row.dns || row.dsq).map((row) => row.driver_number),
    );
    if (now >= this.endTime) {
      for (const driver of drivers.values()) driver.retired = dnf.has(driver.number);
      return;
    }

    // Measured against the middle of the field, not the clock: under a red flag
    // every car stops reporting at once and a clock comparison would retire the
    // entire grid. The median rather than the newest record, because one car
    // still sending from the pit lane would make everyone else look stopped.
    const seen = [...drivers.values()]
      .map((d) => d.lastSeen)
      .filter((value): value is number => value != null)
      .sort((a, b) => a - b);
    if (!seen.length) return;
    const feedTime = seen[Math.floor(seen.length / 2)];
    for (const driver of drivers.values()) {
      if (driver.lastSeen == null) {
        driver.retired = leaderLap > 0;
        continue;
      }
      driver.retired = feedTime - driver.lastSeen > RETIREMENT_SILENCE;
    }
  }
}

function nearestOnPath(geometry: TrackGeometry, x: number, y: number): number {
  let best = 0;
  let bestDistance = Infinity;
  const points = geometry.points;
  // The centreline is dense; a coarse pass then a local refine is far cheaper
  // than scanning every point for twenty cars on every frame.
  for (let i = 0; i < points.length; i += 8) {
    const d = (points[i].x - x) ** 2 + (points[i].y - y) ** 2;
    if (d < bestDistance) {
      bestDistance = d;
      best = i;
    }
  }
  for (let i = Math.max(best - 8, 0); i < Math.min(best + 8, points.length); i += 1) {
    const d = (points[i].x - x) ** 2 + (points[i].y - y) ** 2;
    if (d < bestDistance) {
      bestDistance = d;
      best = i;
    }
  }
  return best;
}

export function deriveTrackStatus(messages: RaceMessage[]): TrackStatus {
  let status: TrackStatus = "—";
  let safetyCar = false;
  let virtualSc = false;

  for (const message of messages) {
    const text = message.message.toUpperCase();
    const flag = (message.flag ?? "").toUpperCase();

    if (text.includes("VIRTUAL SAFETY CAR") || text.includes("VSC")) {
      if (text.includes("END") || text.includes("IN THIS LAP")) virtualSc = false;
      else if (text.includes("DEPLOYED")) virtualSc = true;
    } else if (text.includes("SAFETY CAR")) {
      if (text.includes("IN THIS LAP") || text.includes("END")) safetyCar = false;
      else if (text.includes("DEPLOYED")) safetyCar = true;
    }

    if (flag === "RED") status = "RED FLAG";
    else if (flag === "CHEQUERED") status = "CHEQUERED";
    else if (flag === "GREEN" || text.includes("TRACK CLEAR")) {
      if (status !== "CHEQUERED") status = "GREEN";
    } else if (flag === "DOUBLE YELLOW") status = "DOUBLE YELLOW";
    else if (flag === "YELLOW") status = "YELLOW";
    else if (flag === "CLEAR" && (status === "YELLOW" || status === "DOUBLE YELLOW")) {
      status = "GREEN";
    }
  }

  if (status === "CHEQUERED") return status;
  if (safetyCar) return "SAFETY CAR";
  if (virtualSc) return "VIRTUAL SC";
  return status;
}

/** Pick a session: an explicit key, a circuit by name, or the latest race. */
export async function resolveSession(options: {
  sessionKey?: number;
  year?: number;
  round?: string;
  type?: string;
}): Promise<SessionInfo | null> {
  if (options.sessionKey) {
    const rows = await openf1.sessions({ session_key: options.sessionKey });
    return rows[0] ?? null;
  }

  const now = Date.now();
  const targetYear = options.year ?? new Date().getFullYear();
  let rows = await openf1.sessions({ year: targetYear });
  if (!rows.length) rows = await openf1.sessions({ year: targetYear - 1 });
  if (!rows.length) return null;

  if (!options.year && options.round) {
    // A circuit whose next running is still ahead should show its last race,
    // not an empty session, so widen the search to the previous season.
    rows = rows.concat(await openf1.sessions({ year: targetYear - 1 }));
  }

  if (options.type) {
    const wanted = options.type.toLowerCase();
    const matched = rows.filter(
      (row) =>
        (row.session_name ?? "").toLowerCase().includes(wanted) ||
        (row.session_type ?? "").toLowerCase().includes(wanted),
    );
    if (matched.length) rows = matched;
  }

  if (options.round) {
    const needle = options.round.toLowerCase();
    const matched = rows.filter(
      (row) =>
        (row.circuit_short_name ?? "").toLowerCase().includes(needle) ||
        (row.location ?? "").toLowerCase().includes(needle) ||
        (row.country_name ?? "").toLowerCase().includes(needle),
    );
    if (matched.length) rows = matched;
  }

  const started = rows.filter((row) => (ms(row.date_start) ?? now) <= now);
  const pool = started.length ? started : rows;
  pool.sort((a, b) => (ms(a.date_start) ?? 0) - (ms(b.date_start) ?? 0));
  return pool[pool.length - 1] ?? null;
}
