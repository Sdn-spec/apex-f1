/**
 * Clients for the two feeds behind the app.
 *
 * OpenF1 carries live timing and car positions; Jolpica (the maintained
 * successor to Ergast) carries championship and career history. Both send
 * `access-control-allow-origin: *`, so the whole app runs client-side with no
 * server of its own.
 */

const OPENF1 = "https://api.openf1.org/v1";
const JOLPICA = "https://api.jolpi.ca/ergast/f1";

export interface SessionInfo {
  session_key: number;
  meeting_key: number;
  session_name: string;
  session_type: string;
  date_start: string;
  date_end: string;
  circuit_key: number;
  circuit_short_name: string;
  country_name: string;
  country_code: string;
  location: string;
  year: number;
}

export interface DriverRow {
  driver_number: number;
  broadcast_name: string;
  full_name: string;
  name_acronym: string;
  team_name: string;
  team_colour: string | null;
  headshot_url: string | null;
}

export interface PositionRow {
  date: string;
  driver_number: number;
  position: number;
}

export interface IntervalRow {
  date: string;
  driver_number: number;
  gap_to_leader: number | string | null;
  interval: number | string | null;
}

export interface LapRow {
  driver_number: number;
  lap_number: number;
  date_start: string | null;
  lap_duration: number | null;
  duration_sector_1: number | null;
  duration_sector_2: number | null;
  duration_sector_3: number | null;
  i1_speed: number | null;
  i2_speed: number | null;
  st_speed: number | null;
  is_pit_out_lap: boolean;
}

export interface StintRow {
  driver_number: number;
  stint_number: number;
  lap_start: number;
  lap_end: number;
  compound: string | null;
  tyre_age_at_start: number;
}

export interface PitRow {
  date: string;
  driver_number: number;
  lap_number: number;
  pit_duration: number | null;
  lane_duration: number | null;
}

export interface WeatherRow {
  date: string;
  air_temperature: number | null;
  track_temperature: number | null;
  humidity: number | null;
  pressure: number | null;
  wind_speed: number | null;
  wind_direction: number | null;
  rainfall: number | null;
}

export interface RaceControlRow {
  date: string;
  category: string;
  message: string;
  flag: string | null;
  scope: string | null;
  sector: number | null;
  driver_number: number | null;
}

export interface LocationRow {
  date: string;
  driver_number: number;
  x: number;
  y: number;
  z: number;
}

export interface RadioRow {
  date: string;
  driver_number: number;
  recording_url: string;
}

export interface CarDataRow {
  date: string;
  driver_number: number;
  speed: number | null;
  throttle: number | null;
  brake: number | null;
  n_gear: number | null;
  rpm: number | null;
  drs: number | null;
}

export interface ResultRow {
  position: number;
  driver_number: number;
  number_of_laps: number | null;
  points: number | null;
  dnf: boolean;
  dns: boolean;
  dsq: boolean;
  gap_to_leader: number | string | null;
  duration: number | null;
}

/**
 * OpenF1 reads comparison filters straight off the query string as
 * `date>=VALUE`. A parameter named "date>" serialises to `date%3E=VALUE`, which
 * decodes to exactly that; naming it "date>=" yields a doubled `=` and a 500.
 */
export const AFTER = "date>";
export const BEFORE = "date<";

function isoParam(value: Date): string {
  return value.toISOString().replace("Z", "").slice(0, 23);
}

class RequestQueue {
  private active = 0;
  private waiting: (() => void)[] = [];

  constructor(private readonly limit: number) {}

  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) {
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    }
    this.active += 1;
    try {
      return await task();
    } finally {
      this.active -= 1;
      this.waiting.shift()?.();
    }
  }
}

// OpenF1 rate-limits by burst and a session load fans out to eight endpoints.
const queue = new RequestQueue(3);
const memo = new Map<string, unknown>();

/**
 * Responses for a session that has already ended never change, so they are
 * kept in the browser's Cache Storage. Without it every reload re-downloads
 * several megabytes of timing and quickly trips the feed's rate limit — which
 * shows up as views that render empty for no visible reason.
 */
const CACHE_NAME = "apex-timing-v1";
let cacheHandle: Promise<Cache | null> | null = null;

function openCache(): Promise<Cache | null> {
  if (!cacheHandle) {
    cacheHandle =
      typeof caches === "undefined"
        ? Promise.resolve(null)
        : caches.open(CACHE_NAME).catch(() => null);
  }
  return cacheHandle;
}

export class ApiError extends Error {}

/**
 * OpenF1 is free for historical data but closes global access — archives
 * included — to unauthenticated callers whenever a session is actually
 * running, which is exactly when this app is most wanted. A sponsor key
 * lifts that. It lives in localStorage because there is no server to keep
 * it on, so it never leaves this browser.
 */
const KEY_STORAGE = "apex-openf1-key";

export function openf1Key(): string | null {
  try {
    return localStorage.getItem(KEY_STORAGE) || null;
  } catch {
    return null;
  }
}

export function setOpenf1Key(key: string | null): void {
  try {
    if (key) localStorage.setItem(KEY_STORAGE, key);
    else localStorage.removeItem(KEY_STORAGE);
  } catch {
    // Private browsing; the key simply will not persist.
  }
  memo.clear();
}

/**
 * The lockout response carries no CORS header, so a browser cannot read its
 * 401 — every blocked call surfaces as an indistinguishable `TypeError:
 * Failed to fetch`. Telling "the feed is refusing us" apart from "this
 * machine is offline" therefore needs a second opinion from another origin.
 */
export type FeedFault = "ok" | "openf1-unreachable" | "offline";

export async function diagnoseFeeds(): Promise<FeedFault> {
  const reachable = (url: string) =>
    fetch(url, { headers: { Accept: "application/json" } })
      .then((response) => response.ok)
      .catch(() => false);

  const [openf1Ok, jolpicaOk] = await Promise.all([
    reachable(openf1Url("sessions", { year: new Date().getFullYear() })),
    reachable(`${JOLPICA}/current.json?limit=1`),
  ]);
  if (openf1Ok) return "ok";
  return jolpicaOk ? "openf1-unreachable" : "offline";
}

async function request<T>(
  url: string,
  {
    retries = 3,
    cache = false,
    persist = false,
  }: { retries?: number; cache?: boolean; persist?: boolean } = {},
): Promise<T> {
  if ((cache || persist) && memo.has(url)) return memo.get(url) as T;

  if (persist) {
    const store = await openCache();
    const hit = await store?.match(url).catch(() => undefined);
    if (hit) {
      const payload = (await hit.json()) as T;
      memo.set(url, payload);
      return payload;
    }
  }

  let lastError: unknown;
  for (let attempt = 0; attempt < retries; attempt += 1) {
    try {
      const headers: Record<string, string> = { Accept: "application/json" };
      const key = openf1Key();
      if (key && url.startsWith(OPENF1)) headers.Authorization = `Bearer ${key}`;
      const response = await queue.run(() => fetch(url, { headers }));
      if (response.status === 429) {
        lastError = new ApiError("rate limited");
        await new Promise((r) => setTimeout(r, 1200 * (attempt + 1)));
        continue;
      }
      if (!response.ok) throw new ApiError(`${response.status} ${response.statusText}`);
      if (persist) {
        const store = await openCache();
        // put() consumes the body, so the copy has to be taken first.
        await store?.put(url, response.clone()).catch(() => undefined);
      }
      const payload = (await response.json()) as T;
      if (cache || persist) memo.set(url, payload);
      return payload;
    } catch (error) {
      lastError = error;
      if (attempt < retries - 1) {
        await new Promise((r) => setTimeout(r, 600 * (attempt + 1)));
      }
    }
  }
  throw new ApiError(`request failed: ${String(lastError)}`);
}

function openf1Url(endpoint: string, params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) search.set(key, String(value));
  }
  return `${OPENF1}/${endpoint}?${search.toString()}`;
}

export const openf1 = {
  sessions(params: { year?: number; session_key?: number | string }) {
    return request<SessionInfo[]>(openf1Url("sessions", params), { cache: true });
  },
  drivers(sessionKey: number) {
    return request<DriverRow[]>(openf1Url("drivers", { session_key: sessionKey }), { cache: true });
  },
  position(sessionKey: number, since?: Date, persist = false) {
    return request<PositionRow[]>(
      openf1Url("position", { session_key: sessionKey, [AFTER]: since && isoParam(since) }),
      { persist: persist && !since },
    );
  },
  intervals(sessionKey: number, since?: Date, persist = false) {
    return request<IntervalRow[]>(
      openf1Url("intervals", { session_key: sessionKey, [AFTER]: since && isoParam(since) }),
      { persist: persist && !since },
    );
  },
  laps(sessionKey: number, driverNumber?: number, persist = false) {
    return request<LapRow[]>(
      openf1Url("laps", { session_key: sessionKey, driver_number: driverNumber }),
      { persist },
    );
  },
  stints(sessionKey: number, persist = false) {
    return request<StintRow[]>(openf1Url("stints", { session_key: sessionKey }), { persist });
  },
  pit(sessionKey: number, persist = false) {
    return request<PitRow[]>(openf1Url("pit", { session_key: sessionKey }), { persist });
  },
  weather(sessionKey: number, since?: Date, persist = false) {
    return request<WeatherRow[]>(
      openf1Url("weather", { session_key: sessionKey, [AFTER]: since && isoParam(since) }),
      { persist: persist && !since },
    );
  },
  raceControl(sessionKey: number, since?: Date, persist = false) {
    return request<RaceControlRow[]>(
      openf1Url("race_control", { session_key: sessionKey, [AFTER]: since && isoParam(since) }),
      { persist: persist && !since },
    );
  },
  results(sessionKey: number, persist = false) {
    return request<ResultRow[]>(openf1Url("session_result", { session_key: sessionKey }), {
      persist,
    }).catch(() => [] as ResultRow[]);
  },
  teamRadio(sessionKey: number, persist = false) {
    return request<RadioRow[]>(openf1Url("team_radio", { session_key: sessionKey }), { persist });
  },
  carData(sessionKey: number, options: { driverNumber?: number; start?: Date; end?: Date } = {}) {
    return request<CarDataRow[]>(
      openf1Url("car_data", {
        session_key: sessionKey,
        driver_number: options.driverNumber,
        [AFTER]: options.start && isoParam(options.start),
        [BEFORE]: options.end && isoParam(options.end),
      }),
    );
  },
  location(
    sessionKey: number,
    options: { driverNumber?: number; start?: Date; end?: Date; cache?: boolean } = {},
  ) {
    return request<LocationRow[]>(
      openf1Url("location", {
        session_key: sessionKey,
        driver_number: options.driverNumber,
        [AFTER]: options.start && isoParam(options.start),
        [BEFORE]: options.end && isoParam(options.end),
      }),
      { cache: options.cache ?? false, persist: options.cache ?? false },
    );
  },
};

export interface StandingRow {
  position: string;
  points: string;
  wins: string;
  Driver?: {
    driverId: string;
    givenName: string;
    familyName: string;
    permanentNumber?: string;
    code?: string;
    nationality?: string;
  };
  Constructor?: { constructorId: string; name: string };
  Constructors?: { constructorId: string; name: string }[];
}

export interface HistoryRace {
  season: string;
  raceName: string;
  round?: string;
  date?: string;
  time?: string;
  Circuit?: { circuitId: string; circuitName: string; Location?: Record<string, string> };
  Results?: {
    position: string;
    Driver: { givenName: string; familyName: string };
    Constructor: { name: string };
    Time?: { time: string };
  }[];
}

async function jolpica<T>(path: string, params = "limit=100"): Promise<T> {
  const payload = await request<{ MRData: T }>(`${JOLPICA}/${path}.json?${params}`, {
    cache: true,
    retries: 2,
  });
  return payload.MRData;
}

export const history = {
  async driverStandings(season: string | number = "current"): Promise<StandingRow[]> {
    const data = await jolpica<{ StandingsTable: { StandingsLists: { DriverStandings: StandingRow[] }[] } }>(
      `${season}/driverStandings`,
      "limit=40",
    );
    return data.StandingsTable.StandingsLists[0]?.DriverStandings ?? [];
  },
  async constructorStandings(season: string | number = "current"): Promise<StandingRow[]> {
    const data = await jolpica<{
      StandingsTable: { StandingsLists: { ConstructorStandings: StandingRow[] }[] };
    }>(`${season}/constructorStandings`, "limit=40");
    return data.StandingsTable.StandingsLists[0]?.ConstructorStandings ?? [];
  },
  async schedule(season: string | number = "current"): Promise<HistoryRace[]> {
    const data = await jolpica<{ RaceTable: { Races: HistoryRace[] } }>(`${season}`, "limit=40");
    return data.RaceTable.Races ?? [];
  },
  /**
   * Past winners at a circuit, newest first. Results come back oldest-first and
   * no circuit has hosted a hundred championship races, so one full page holds
   * the whole history — a short page would return the 1950s.
   */
  async circuitWinners(circuitId: string): Promise<HistoryRace[]> {
    const data = await jolpica<{ RaceTable: { Races: HistoryRace[] } }>(
      `circuits/${circuitId}/results/1`,
      "limit=100",
    );
    return (data.RaceTable.Races ?? []).sort((a, b) => Number(b.season) - Number(a.season));
  },
};
