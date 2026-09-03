# Apex — the web front end

A broadcast-styled Formula 1 race view in the browser: animated track map,
timing tower that reorders as cars overtake, tyre strategy, driver detail,
championship standings and the race control feed.

Same data model as the terminal app in the parent directory — the geometry
derivation and the time-honest projection are ported to TypeScript — but the
rendering is very different. The map is a real SVG spline rather than braille,
and position changes animate rather than redraw.

## Run it

```bash
npm install
npm run dev      # http://127.0.0.1:5173
```

```bash
npm run build    # static bundle in dist/
npm run preview  # serve the built bundle
```

## Deploy it

There is no backend. Both upstream APIs send
`access-control-allow-origin: *`, so the built `dist/` folder is a plain static
site — drop it on GitHub Pages, Netlify, Vercel, Cloudflare Pages or any static
host. `vite.config.ts` sets `base: "./"`, so it works from a subdirectory too.

## What's on screen

| View | Shows |
| --- | --- |
| **Race** | Track map with live car positions beside the timing tower |
| **Timing** | Full classification with sector times, best laps and speed traps |
| **Strategy** | Every driver's stints laid across race distance, coloured by compound |
| **Analysis** | Gap-to-leader and lap-time evolution charts, plus tyre degradation by stint |
| **Driver** | The selected car: portrait, stint history, pit stops |
| **Telemetry** | Speed, throttle, brake and gear traces for the selected car |
| **Radio** | Team radio clips, playable |
| **Standings** | Drivers' and constructors' championships, past winners at this circuit |
| **Calendar** | The season, with a live countdown to the next session in your timezone |
| **Race Control** | Flags, penalties, investigations, deleted laps |

Keys: `1`–`9`/`0` switch views, `space` pauses, `←`/`→` seek 30 seconds, `c`
toggles corner numbers, `l` toggles driver name tags, `s` opens the session
picker. Clicking a car on the map or a row in the tower selects that driver, and
the driver-scoped views (Driver, Telemetry, and the degradation chart) follow
that selection.

Team radio comes from OpenF1's links to F1's own static hosting. Those play as
audio elements, which need no CORS grant — unlike `fetch`, media elements may
load cross-origin. Telemetry (`car_data`, ~4 Hz) is fetched per driver rather
than for the field, because twenty simultaneous traces would be megabytes a
minute and only one car is ever on screen.

## How the animation is put together

Three cadences run side by side, because tying them together would either make
the map stutter or make the tower re-render sixty times a second:

- **Every animation frame** — car coordinates are re-interpolated between
  telemetry samples, and the markers are moved by writing SVG transforms
  directly, outside React. The markers ease toward their target and snap when
  the jump is large, so a seek or a lap wrap doesn't slide a car across the
  infield.
- **Twice a second** — the full projection recomputes: positions, gaps, lap
  times, stints, flags.
- **Every three seconds** — the network is touched, to refill the sliding
  window of car positions (and, in a live session, to poll for new timing).

The timing tower uses Framer Motion `layout` animations keyed by driver number,
so rows physically slide past each other on an overtake instead of the numbers
blinking, and the row flashes green or red in the direction it moved.

## Live vs replay

If the chosen session is running now, the app follows the wall clock and polls.
Otherwise it replays, opening about twenty minutes from the end — where the
field is spread out and cars are moving, rather than on a stationary grid.

Replay only ever shows what was known at the replayed moment. Retirements come
from a car's timing feed going quiet relative to the *median* of the field
rather than from the final classification, which means a car shows as OUT when
it actually stopped, and a red flag that silences every car at once doesn't
retire the whole grid. Tyre stints are clamped to the current lap for the same
reason.

## Data

- [OpenF1](https://openf1.org) — timing, car positions, stints, pits, weather,
  race control. 2023 onward.
- [Jolpica-F1](https://github.com/jolpica/jolpica-f1) — championships and
  circuit history, back to 1950.

Both rate-limit, so requests are queued three at a time, retried on 429, and
memoised in the page for the session's lifetime.
