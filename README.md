# f1terminal

A race engineer's wall in your terminal. Live track map, timing tower, tyre
strategy, race control and championship context for Formula 1 — rendered as a
TUI, driven by real timing data.

```
 Netherlands Race  ·  Zandvoort  ·  4.296 km            GREEN                    LAP 31/72  (41 to go)
 WX Air 18.9°C  Track 31.8°C  Hum 55%  Dry ↑    FASTEST HAM 1:15.514      REPLAY ▐███████░░░░▌ 1x

                  ⢀⡴⠚⠉1⠓⢆                        │  P  DRV      GAP       INT      LAST  TYRE  PIT
                 ⢠⠏      ⢧                       │  1  ANT   LEADER         —  1:16.473  H  9    2
                ⢸       ⢀⡇                       │  2  NOR   +0.699    +0.699  1:16.221  H  9    2
               ⡼    ⢀⣀⠤⠖⠊⠁         ⣀⣀⠤⠤⠤⠤⣀⣀      │  3  RUS   +8.226    +7.427  1:16.595  H 13    2
              ⣰⠁  ⢠⠞⠉           ⢀⡠⠔⠊⠉     ⠈⠉⠲⢄   │  4  PIA  +10.133    +1.907  1:16.727  H 12    2
             ⢠⠃   ⡏   ⣀⣀⠤⠤⠖⠒●⠒⠲⠤⠤⢄⣀⣀⡀           │  5  LEC  +10.597    +0.562  1:16.579  M  9    2
            ⢀⠏   3⢳⡀ ⢀⣀⠤⠖⠚⠉⠁       ⠉⠉⠉⠉4         │  6  HAM  +15.542    +4.963  1:16.007  H  5    2
           ◆ ANT⠉⠁                               │  7  LAW  +32.106   +16.743  1:17.126  M  9    2
```

## What it shows

**Track map.** There is no published outline for an F1 circuit, so the map is
derived: the app takes the fastest clean lap of the session, treats that car's
racing line as the centreline, and finds corners by looking for sustained
curvature along it. The result is drawn in Unicode braille — a braille cell
packs 2×4 dots, and since a terminal cell is about twice as tall as it is wide,
those dots come out nearly square, so the circuit keeps its true shape. Cars ride
on top in team colours, interpolated between samples so movement is smooth.

**Timing tower.** Position, gap to leader, interval to the car ahead, last and
best lap, all three sector times with session-best/personal-best colouring,
speed trap, tyre compound and age, and stop count.

**Strategy.** Every driver's stints laid out across race distance, coloured by
compound.

**Driver detail.** Telemetry for the selected car, its full stint and pit
history, and career totals — starts, wins, podiums, points, retirements.

**Stats.** Live drivers' and constructors' championship standings, plus past
winners at the circuit you're watching.

**Race control.** The full message feed — flags, penalties, investigations,
deleted lap times, DRS enablement — with safety car and red flag state lifted
into the header.

## Install

```bash
uv venv && uv pip install -e .
```

Or with pip: `pip install -e .`

## Use

```bash
f1terminal                              # latest session, replayed from its start
f1terminal --round zandvoort            # most recent Zandvoort session
f1terminal --year 2025 --round monza --type race
f1terminal --session 11353 --speed 8    # replay a specific session at 8x
f1terminal --live                       # poll a session that is running now
f1terminal --list --year 2026           # show the season's sessions and keys
```

`--at HH:MM` starts a replay at a given time of day; `--from-end N` starts it N
minutes before the end, which is the quickest way to watch a finish.

### Keys

| Key | Action |
| --- | --- |
| `1`–`6` | Race · Timing · Strategy · Driver · Stats · Race Control |
| `↑` `↓` | Select a driver (highlights them on the map) |
| `space` | Pause / resume replay |
| `←` `→` | Seek ∓30 seconds |
| `,` `.` | Replay slower / faster |
| `l` | Toggle driver name tags on the map |
| `c` | Toggle corner numbers |
| `r` | Force a refresh |
| `q` | Quit |

## Live vs replay

The only difference between watching a live race and replaying a finished one is
which clock drives the app. Live mode advances with the wall clock and polls for
new records; replay mode advances a virtual clock over data downloaded up front.
Both run the same projection.

Replay is deliberately time-honest: it shows only what was known at the replayed
moment. A car is marked OUT when its timing feed goes quiet relative to the rest
of the field — not by reading the final classification — so a retirement appears
when it happened, and a red-flag stoppage that silences every car at once does
not retire the entire grid. Tyre stints are clamped to the current lap for the
same reason.

## Data sources

- **[OpenF1](https://openf1.org)** — car positions at ~3.7 Hz, timing, intervals,
  tyre stints, pit stops, weather, race control. Covers 2023 onward.
- **[Jolpica-F1](https://github.com/jolpica/jolpica-f1)** — the maintained
  successor to Ergast, for championship standings, career records and circuit
  history back to 1950.

Both are rate-limited, so responses are cached under `~/.cache/f1terminal`.
A session that has ended can never change, so its timing is cached to disk and
subsequent runs start instantly. `--clear-cache` empties it; `--no-cache`
bypasses it.

## Development

```bash
uv pip install -e '.[dev]'
python -m pytest
```

The test suite runs offline against synthetic circuits and hand-built record
feeds — it covers the geometry and corner detection, the braille renderer, and
the projection rules that keep a replay from leaking the future.
