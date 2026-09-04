/**
 * Live-session simulator.
 *
 * The app has only ever been exercised in replay. This drives the real live
 * code path by putting a proxy in front of OpenF1 that shifts an archived race
 * forward in time so it appears to be happening right now, and — crucially —
 * hides every row the simulated clock has not reached yet. The app cannot tell
 * the difference, so LiveClock, pollLive and the live LocationBuffer branch all
 * run for real.
 */
import { chromium } from "playwright";

const RUN_MS = Number(process.argv[2] ?? 90_000);
const OPENF1 = "https://api.openf1.org/v1";

// The archived race to re-run as if it were live.
const sessions = await (await fetch(`${OPENF1}/sessions?session_key=latest`)).json();
const target = sessions[0];
const archiveStart = Date.parse(target.date_start);
const archiveEnd = Date.parse(target.date_end);
console.log(`simulating: ${target.session_name} @ ${target.circuit_short_name} (${target.session_key})`);

// Place the simulated clock 45 minutes into the race.
const OFFSET = Date.now() - (archiveStart + 45 * 60_000);
const archiveNow = () => Date.now() - OFFSET;

const shift = (iso) => {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? iso : new Date(t + OFFSET).toISOString();
};
const unshift = (iso) => new Date(Date.parse(iso) - OFFSET).toISOString().replace("Z", "");

const counts = new Map();
const bump = (k) => counts.set(k, (counts.get(k) ?? 0) + 1);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 950 } });
const errors = [];
page.on("pageerror", (e) => errors.push("PAGEERROR " + String(e).slice(0, 200)));
page.on("console", (m) => {
  const t = m.text();
  if (m.type() === "error" && !t.includes("Failed to load resource")) errors.push("CONSOLE " + t.slice(0, 160));
});

await page.route("**/api.openf1.org/**", async (route) => {
  const url = new URL(route.request().url());
  const endpoint = url.pathname.split("/").pop();
  bump(endpoint);

  // The race is not over in the simulation, so the classification must not exist.
  if (endpoint === "session_result") {
    return route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
  }

  // Translate the app's "now" filters back into archive time.
  const params = url.searchParams;
  for (const key of ["date>", "date<"]) {
    const value = params.get(key);
    if (value) params.set(key, unshift(value));
  }
  const upstream = `${OPENF1}/${endpoint}?${params.toString()}`;

  let rows;
  try {
    const response = await fetch(upstream, { headers: { Accept: "application/json" } });
    if (!response.ok) {
      return route.fulfill({ status: response.status, contentType: "application/json", body: "[]" });
    }
    rows = await response.json();
  } catch {
    return route.fulfill({ status: 502, contentType: "application/json", body: "[]" });
  }
  if (!Array.isArray(rows)) rows = [];

  const cutoff = archiveNow();
  const out = [];
  for (const row of rows) {
    if (endpoint === "sessions") {
      // Make the session bracket the present so the app chooses LiveClock.
      out.push({ ...row, date_start: shift(row.date_start), date_end: shift(row.date_end) });
      continue;
    }
    const stamp = row.date ?? row.date_start;
    if (stamp) {
      const t = Date.parse(stamp);
      if (!Number.isNaN(t) && t > cutoff) continue; // has not happened yet
    }
    const copy = { ...row };
    if (copy.date) copy.date = shift(copy.date);
    if (copy.date_start) copy.date_start = shift(copy.date_start);
    out.push(copy);
  }
  route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(out) });
});

await page.goto("http://127.0.0.1:5173/", { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => document.querySelectorAll(".map-wrap svg g").length > 0, null, {
  timeout: 240_000,
  polling: 500,
});

const mode = await page.evaluate(() => document.body.innerText.includes("LIVE") ? "LIVE" : "REPLAY");
console.log("clock mode:", mode);

// Let the boot burst settle, then measure the steady-state request rate.
await page.waitForTimeout(10_000);
counts.clear();
const t0 = Date.now();

const posAt = () =>
  page.evaluate(() =>
    [...document.querySelectorAll(".car")].slice(0, 6).map((c) => c.getAttribute("transform")).join("|"),
  );
const before = await posAt();

await page.waitForTimeout(RUN_MS);
const after = await posAt();
const elapsed = (Date.now() - t0) / 1000;

console.log(`\nsteady state over ${elapsed.toFixed(0)}s:`);
for (const [k, v] of [...counts].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${k.padEnd(14)} ${String(v).padStart(4)}  (${(elapsed / v).toFixed(1)}s apart)`);
}
console.log("\ncars moving:", before !== after && before.length > 0);
await page.screenshot({ path: "tools/livesim.png" });
console.log("errors:", errors.length ? errors.slice(0, 6) : "none");

await browser.close();
