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

export class ApiError extends Error {}

async function request<T>(
  url: string,
  { retries = 3, cache = false }: { retries?: number; cache?: boolean } = {},
): Promise<T> {
  if (cache && memo.has(url)) return memo.get(url) as T;

  let lastError: unknown;
  for (let attempt = 0; attempt < retries; attempt += 1) {
    try {
      const response = await queue.run(() => fetch(url, { headers: { Accept: "application/json" } }));
      if (response.status === 429) {
        lastError = new ApiError("rate limited");
        await new Promise((r) => setTimeout(r, 1200 * (attempt + 1)));
        continue;
      }
      if (!response.ok) throw new ApiError(`${response.status} ${response.statusText}`);
      const payload = (await response.json()) as T;
      if (cache) memo.set(url, payload);
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
  position(sessionKey: number, since?: Date) {
    return request<PositionRow[]>(
      openf1Url("position", { session_key: sessionKey, [AFTER]: since && isoParam(since) }),
    );
  },
  intervals(sessionKey: number, since?: Date) {
    return request<IntervalRow[]>(
      openf1Url("intervals", { session_key: sessionKey, [AFTER]: since && isoParam(since) }),
    );
  },
  laps(sessionKey: number, driverNumber?: number) {
    return request<LapRow[]>(
      openf1Url("laps", { session_key: sessionKey, driver_number: driverNumber }),
    );
  },
  stints(sessionKey: number) {
    return request<StintRow[]>(openf1Url("stints", { session_key: sessionKey }));
  },
  pit(sessionKey: number) {
    return request<PitRow[]>(openf1Url("pit", { session_key: sessionKey }));
  },
  weather(sessionKey: number) {
    return request<WeatherRow[]>(openf1Url("weather", { session_key: sessionKey }));
  },
  raceControl(sessionKey: number) {
    return request<RaceControlRow[]>(openf1Url("race_control", { session_key: sessionKey }));
  },
  results(sessionKey: number) {
    return request<ResultRow[]>(openf1Url("session_result", { session_key: sessionKey })).catch(
      () => [] as ResultRow[],
    );
  },
  teamRadio(sessionKey: number) {
    return request<RadioRow[]>(openf1Url("team_radio", { session_key: sessionKey }));
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
      { cache: options.cache ?? false },
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
