# Live-path test harnesses

Apex behaves quite differently live and in replay: different clock, different
polling, a different branch of the location buffer. Replay is easy to exercise
any day of the week, which meant the live path went a long time without ever
being run. These two harnesses exist so it can be tested without waiting for a
race.

Both drive a real browser against `npm run dev` on port 5173 and intercept the
OpenF1 calls, so no upstream request is made for the timing data itself.

## `fake-live-session.mjs`

Serves a wholly invented race — six cars on a circular track — from inside the
browser. The session brackets the present, so the app takes the live path for
real. Nothing upstream is contacted, so this works during an OpenF1 lockout and
offline.

```
node tools/fake-live-session.mjs [runMs]
```

It reports the steady-state request rate per endpoint, which is the thing most
worth watching: a regression here shows up as an endpoint being polled at the
animation cadence rather than its own. Expected shape:

| endpoint                                  | roughly    |
| ----------------------------------------- | ---------- |
| position, intervals                       | every 3 s  |
| location                                  | every 4–6 s |
| laps, stints, pit, weather, race\_control | every 20 s |

## `replay-as-live.mjs`

Takes a real archived session and shifts it forward in time so it appears to be
happening now, hiding every row the simulated clock has not reached. Slower to
set up and it needs OpenF1 to be reachable, but it exercises the live path
against real data shapes — ragged sample gaps, cars in the pits, missing rows —
which the synthetic feed is too tidy to reproduce.

```
node tools/replay-as-live.mjs [runMs]
```

Note that OpenF1 closes all unauthenticated access, archives included, while
any session is running, so this one cannot run during a race weekend. That is
what `fake-live-session.mjs` is for.
