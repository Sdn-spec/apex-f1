/**
 * Synthetic live session.
 *
 * The archive proxy cannot run while OpenF1 is locked, so this serves a wholly
 * invented race from inside the browser instead — no upstream at all. The
 * session brackets the present, so the app takes the LiveClock path for real,
 * and every feed answers only with rows the simulated clock has already
 * reached. What is being measured is the live request cadence: before the fix
 * the location buffer refetched on every animation tick and pollLive pulled
 * five whole tables every three seconds.
 */
import { chromium } from "playwright";

const RUN_MS = Number(process.argv[2] ?? 60_000);
const START = Date.now() - 40 * 60_000; // session began 40 minutes ago
const END = Date.now() + 40 * 60_000;
const LAP_MS = 90_000;
const CARS = [1, 4, 16, 44, 63, 81];
const NAMES = { 1: "VER", 4: "NOR", 16: "LEC", 44: "HAM", 63: "RUS", 81: "PIA" };
const TEAMS = { 1: "Red Bull", 4: "McLaren", 16: "Ferrari", 44: "Ferrari", 63: "Mercedes", 81: "McLaren" };

const counts = new Map();
const bump = (k) => counts.set(k, (counts.get(k) ?? 0) + 1);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 950 } });
const errors = [];
page.on("pageerror", (e) => errors.push("PAGEERROR " + String(e).slice(0, 200)));
page.on("console", (m) => {
  const t = m.text();
  if (m.type() === "error" && !t.includes("Failed to load resource")) errors.push("CONSOLE " + t.slice(0, 150));
});

await page.route("**/api.openf1.org/**", async (route) => {
  const url = new URL(route.request().url());
  const endpoint = url.pathname.split("/").pop();
  bump(endpoint);
  const q = url.searchParams;
  const iso = (t) => new Date(t).toISOString();
  const after = q.get("date>") ? Date.parse(q.get("date>") + "Z") : null;
  const before = q.get("date<") ? Date.parse(q.get("date<") + "Z") : null;
  const drv = q.get("driver_number") ? Number(q.get("driver_number")) : null;
  const now = Date.now();
  let rows = [];

  // A lap is a circle; each car sits at a different phase around it.
  const place = (car, t) => {
    const phase = ((t - START) / LAP_MS + CARS.indexOf(car) * 0.09) * Math.PI * 2;
    return { x: Math.cos(phase) * 800, y: Math.sin(phase) * 520 };
  };

  switch (endpoint) {
    case "sessions":
      rows = [{
        session_key: 9999, meeting_key: 1234, session_name: "Race", session_type: "Race",
        date_start: iso(START), date_end: iso(END), circuit_key: 39,
        circuit_short_name: "Testing", country_name: "Nowhere", country_code: "XX",
        location: "Testing", year: new Date().getFullYear(),
      }];
      break;
    case "drivers":
      rows = CARS.map((n) => ({
        driver_number: n, broadcast_name: NAMES[n], full_name: NAMES[n],
        name_acronym: NAMES[n], team_name: TEAMS[n], team_colour: "3671C6", headshot_url: null,
      }));
      break;
    case "position": {
      const from = after ?? START;
      for (let t = from; t <= now; t += 5000) {
        CARS.forEach((n, i) => rows.push({ date: iso(t), driver_number: n, position: i + 1 }));
      }
      break;
    }
    case "intervals": {
      const from = after ?? now - 60_000;
      for (let t = from; t <= now; t += 5000) {
        CARS.forEach((n, i) => rows.push({
          date: iso(t), driver_number: n, gap_to_leader: i === 0 ? 0 : i * 1.7, interval: i === 0 ? 0 : 1.7,
        }));
      }
      break;
    }
    case "location": {
      // 3.7 Hz, exactly like the real feed.
      const from = after ?? now - 60_000;
      const to = Math.min(before ?? now, now);
      const cars = drv ? [drv] : CARS;
      for (let t = from; t <= to; t += 270) {
        for (const n of cars) {
          const p = place(n, t);
          rows.push({ date: iso(t), driver_number: n, x: p.x, y: p.y, z: 0 });
        }
      }
      break;
    }
    case "laps": {
      const done = Math.floor((now - START) / LAP_MS);
      for (let lap = 1; lap <= done; lap += 1) {
        for (const n of CARS) {
          rows.push({
            driver_number: n, lap_number: lap, date_start: iso(START + (lap - 1) * LAP_MS),
            lap_duration: 90 + (n % 7) * 0.1, duration_sector_1: 30, duration_sector_2: 30,
            duration_sector_3: 30, i1_speed: 300, i2_speed: 310, st_speed: 320, is_pit_out_lap: false,
          });
        }
      }
      break;
    }
    case "stints":
      rows = CARS.map((n) => ({
        driver_number: n, stint_number: 1, lap_start: 1,
        lap_end: Math.floor((now - START) / LAP_MS) + 1, compound: "MEDIUM", tyre_age_at_start: 0,
      }));
      break;
    case "weather":
      rows = [{
        date: iso(now - 30_000), air_temperature: 24, track_temperature: 38, humidity: 41,
        pressure: 1012, wind_speed: 2.1, wind_direction: 210, rainfall: 0,
      }];
      break;
    case "race_control":
      rows = after ? [] : [{
        date: iso(START), category: "Flag", message: "GREEN LIGHT - PIT EXIT OPEN",
        flag: "GREEN", scope: "Track", sector: null, driver_number: null,
      }];
      break;
    default:
      rows = []; // pit, team_radio, session_result, car_data
  }
  route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(rows) });
});

await page.goto("http://127.0.0.1:5173/", { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => document.querySelectorAll(".map-wrap svg g.car").length > 0, null, {
  timeout: 120_000,
  polling: 400,
});
const mode = await page.evaluate(() =>
  document.body.innerText.includes("LIVE") ? "LIVE" : "REPLAY");
console.log("clock mode:", mode, "| cars on map:", await page.evaluate(() => document.querySelectorAll("g.car").length));

await page.waitForTimeout(8000);
counts.clear();
const t0 = Date.now();
const snap = () =>
  page.evaluate(() =>
    [...document.querySelectorAll("g.car")].map((c) => c.getAttribute("transform")).join("|"));
const before = await snap();
await page.waitForTimeout(RUN_MS);
const after = await snap();
const secs = (Date.now() - t0) / 1000;

console.log(`\nrequests over ${secs.toFixed(0)}s of live running:`);
for (const [k, v] of [...counts].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${k.padEnd(13)} ${String(v).padStart(4)}   one per ${(secs / v).toFixed(1)}s`);
}
console.log("\ncars moved:", before !== after);
console.log("errors:", errors.length ? errors.slice(0, 5) : "none");
await page.screenshot({ path: "tools/fakelive.png" });
await browser.close();
