/**
 * Apex — the application shell.
 *
 * Three cadences run side by side: the projection is recomputed a couple of
 * times a second, car coordinates are re-interpolated every animation frame so
 * the map stays smooth between them, and the network is touched only every few
 * seconds. Keeping them separate is what lets twenty cars move at 60fps without
 * re-rendering the timing tower twenty times a second.
 */

import { AnimatePresence, motion } from "framer-motion";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { history, type HistoryRace, type SessionInfo, type StandingRow } from "./lib/api";
import { LiveClock, ReplayClock, Session, resolveSession, type Snapshot } from "./lib/session";
import { clockTime } from "./lib/format";
import { SessionPicker } from "./components/SessionPicker";
import { TimingTower } from "./components/TimingTower";
import { TopBar } from "./components/TopBar";
import { TrackMap } from "./components/TrackMap";
import { DriverPanel, RaceControlFeed, StandingsView, StrategyBoard } from "./components/Views";
import { TelemetryPanel } from "./components/Telemetry";
import { RadioFeed } from "./components/Radio";
import { AnalysisView } from "./components/Charts";
import { CalendarView } from "./components/Calendar";

type Tab =
  | "race"
  | "timing"
  | "strategy"
  | "analysis"
  | "driver"
  | "telemetry"
  | "radio"
  | "standings"
  | "calendar"
  | "control";

const TABS: { id: Tab; label: string }[] = [
  { id: "race", label: "Race" },
  { id: "timing", label: "Timing" },
  { id: "strategy", label: "Strategy" },
  { id: "analysis", label: "Analysis" },
  { id: "driver", label: "Driver" },
  { id: "telemetry", label: "Telemetry" },
  { id: "radio", label: "Radio" },
  { id: "standings", label: "Standings" },
  { id: "calendar", label: "Calendar" },
  { id: "control", label: "Race Control" },
];

const PROJECTION_MS = 450;
const NETWORK_MS = 3000;

export default function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [info, setInfo] = useState<SessionInfo | null>(null);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [status, setStatus] = useState("finding the latest session");
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("race");
  const [selected, setSelected] = useState<number | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [paused, setPaused] = useState(false);
  const [speed, setSpeed] = useState(4);
  const [progress, setProgress] = useState(0);
  const [showCorners, setShowCorners] = useState(true);
  const [showLabels, setShowLabels] = useState(true);
  const [geometryVersion, setGeometryVersion] = useState(0);

  const [standings, setStandings] = useState<StandingRow[]>([]);
  const [constructors, setConstructors] = useState<StandingRow[]>([]);
  const [winners, setWinners] = useState<HistoryRace[]>([]);
  const [historyLoading, setHistoryLoading] = useState(true);

  const sessionRef = useRef<Session | null>(null);
  sessionRef.current = session;

  // ---- load a session -----------------------------------------------------

  const load = useCallback(async (target?: SessionInfo) => {
    setSnapshot(null);
    setSession(null);
    setError(null);
    setStatus("finding the session");

    try {
      const chosen = target ?? (await resolveSession({}));
      if (!chosen) {
        setError("No sessions found in the timing feed.");
        return;
      }
      setInfo(chosen);

      const start = Date.parse(chosen.date_start);
      const end = Date.parse(chosen.date_end);
      const isRunning = Date.now() >= start && Date.now() <= end;
      // Replays open near the end, where the field is spread out and cars are
      // moving — starting at lights out means several minutes of empty grid.
      const clock = isRunning
        ? new LiveClock()
        : new ReplayClock(start, end, 4, end - 20 * 60_000);

      const next = new Session(chosen, clock);
      setStatus("loading drivers");
      await next.loadDrivers();
      await next.loadTiming((label) => setStatus(`loading ${label}`));

      setStatus("tracing the circuit");
      await next.loadGeometry();
      setGeometryVersion((value) => value + 1);

      const now = clock.now();
      await next.ensureLocations(now);
      setSession(next);
      setSnapshot(next.project(now));
    } catch (cause) {
      setError(`Could not load timing data: ${String(cause)}`);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // ---- championship context ----------------------------------------------

  useEffect(() => {
    if (!info) return;
    let cancelled = false;
    setHistoryLoading(true);
    (async () => {
      try {
        const [drivers, teams] = await Promise.all([
          history.driverStandings(info.year),
          history.constructorStandings(info.year),
        ]);
        if (cancelled) return;
        setStandings(drivers);
        setConstructors(teams);

        const schedule = await history.schedule(info.year);
        const needle = (info.location ?? "").toLowerCase();
        const short = (info.circuit_short_name ?? "").toLowerCase();
        const match = schedule.find((race) => {
          const haystack = [
            race.Circuit?.circuitName,
            race.Circuit?.circuitId,
            race.Circuit?.Location?.locality,
            race.Circuit?.Location?.country,
          ]
            .join(" ")
            .toLowerCase();
          return (needle && haystack.includes(needle)) || (short && haystack.includes(short));
        });
        if (match?.Circuit?.circuitId && !cancelled) {
          setWinners(await history.circuitWinners(match.Circuit.circuitId));
        }
      } catch {
        // Championship context is supplementary; the race view stands alone.
      } finally {
        if (!cancelled) setHistoryLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [info]);

  // ---- the three cadences -------------------------------------------------

  useEffect(() => {
    if (!session) return;
    const timer = setInterval(() => {
      const now = session.clock.now();
      setSnapshot(session.project(now));
      if (session.clock instanceof ReplayClock) setProgress(session.clock.progress);
    }, PROJECTION_MS);
    return () => clearInterval(timer);
  }, [session]);

  useEffect(() => {
    if (!session) return;
    let frame = 0;
    const tick = () => {
      frame = requestAnimationFrame(tick);
      setSnapshot((previous) => {
        if (!previous) return previous;
        session.updatePositions(session.clock.now(), previous.byNumber);
        // The map reads coordinates off the driver objects, which are mutated
        // in place; a new array identity is enough to let it re-render.
        return { ...previous, drivers: [...previous.drivers] };
      });
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [session]);

  useEffect(() => {
    if (!session) return;
    const timer = setInterval(() => {
      const now = session.clock.now();
      void session.ensureLocations(now);
      if (session.clock.isLive) void session.pollLive();
    }, NETWORK_MS);
    return () => clearInterval(timer);
  }, [session]);

  // ---- playback controls --------------------------------------------------

  const replay = session?.clock instanceof ReplayClock ? (session.clock as ReplayClock) : null;

  const togglePause = useCallback(() => {
    if (!replay) return;
    replay.setPaused(!replay.paused);
    setPaused(replay.paused);
  }, [replay]);

  const changeSpeed = useCallback(
    (value: number) => {
      if (!replay) return;
      replay.setSpeed(value);
      setSpeed(replay.speed);
    },
    [replay],
  );

  const seek = useCallback(
    (seconds: number) => {
      if (!replay || !sessionRef.current) return;
      replay.seek(seconds);
      void sessionRef.current.ensureLocations(replay.now());
    },
    [replay],
  );

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement) return;
      const index = Number(event.key);
      if (index >= 1 && index <= TABS.length) {
        setTab(TABS[index - 1].id);
        return;
      }
      if (event.code === "Space") {
        event.preventDefault();
        togglePause();
      }
      if (event.key === "ArrowLeft") seek(-30);
      if (event.key === "ArrowRight") seek(30);
      if (event.key === "c") setShowCorners((value) => !value);
      if (event.key === "l") setShowLabels((value) => !value);
      if (event.key === "s") setPickerOpen(true);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [togglePause, seek]);

  const selectedDriver = useMemo(
    () => (selected != null ? (snapshot?.byNumber.get(selected) ?? null) : null),
    [selected, snapshot],
  );

  const pickDriver = useCallback((number: number) => {
    setSelected(number);
  }, []);

  // ---- render -------------------------------------------------------------

  if (error) {
    return (
      <div className="boot">
        <div className="boot-inner">
          <h1>Apex</h1>
          <p style={{ color: "var(--red)" }}>{error}</p>
          <button className="pill" onClick={() => void load()}>
            Try again
          </button>
        </div>
      </div>
    );
  }

  if (!session || !info || !snapshot) {
    return (
      <div className="boot">
        <motion.div
          className="boot-inner"
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5 }}
        >
          <h1>
            APE<span style={{ color: "var(--red)" }}>X</span>
          </h1>
          <p>{status}…</p>
          <div className="boot-bar">
            <motion.div
              className="boot-fill"
              initial={{ width: "6%" }}
              animate={{ width: ["6%", "92%"] }}
              transition={{ duration: 14, ease: "easeOut" }}
            />
          </div>
        </motion.div>
      </div>
    );
  }

  return (
    <div className="app">
      <TopBar
        info={info}
        snapshot={snapshot}
        circuitLength={session.geometry?.length ?? null}
        onPickSession={() => setPickerOpen(true)}
      />

      <nav className="nav">
        {TABS.map((entry) => (
          <button
            key={entry.id}
            className="nav-tab"
            data-active={tab === entry.id}
            onClick={() => setTab(entry.id)}
          >
            {entry.label}
            {tab === entry.id && <motion.span className="nav-underline" layoutId="nav-underline" />}
          </button>
        ))}

        <div className="playback">
          {replay ? (
            <>
              <button className="pill" onClick={togglePause}>
                {paused ? "▶ Play" : "❚❚ Pause"}
              </button>
              <button className="pill" onClick={() => seek(-30)} title="Back 30s">
                −30s
              </button>
              <button className="pill" onClick={() => seek(30)} title="Forward 30s">
                +30s
              </button>
              <div
                className="scrub"
                onClick={(event) => {
                  const box = event.currentTarget.getBoundingClientRect();
                  replay.seekFraction((event.clientX - box.left) / box.width);
                  void session.ensureLocations(replay.now());
                }}
                title="Seek"
              >
                <motion.div
                  className="scrub-fill"
                  animate={{ width: `${progress * 100}%` }}
                  transition={{ duration: 0.3 }}
                />
              </div>
              {[1, 4, 12, 30].map((value) => (
                <button
                  key={value}
                  className="pill"
                  data-on={speed === value}
                  onClick={() => changeSpeed(value)}
                >
                  {value}×
                </button>
              ))}
            </>
          ) : (
            <span className="pill" data-on="true">
              <span className="live-dot" /> LIVE
            </span>
          )}
          <span className="pill tnum" style={{ pointerEvents: "none" }}>
            {clockTime(snapshot.now)}
          </span>
        </div>
      </nav>

      <main className="stage">
        <AnimatePresence mode="wait">
          <motion.div
            key={tab}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6 }}
            transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
            style={{ height: "100%", minHeight: 0, overflow: tab === "race" ? "hidden" : "auto" }}
          >
            {tab === "race" && (
              <div className="race-grid">
                <div className="panel">
                  <div className="panel-head">
                    <h2>{info.circuit_short_name}</h2>
                    <div style={{ display: "flex", gap: 8 }}>
                      <button className="pill" data-on={showCorners} onClick={() => setShowCorners((v) => !v)}>
                        Corners
                      </button>
                      <button className="pill" data-on={showLabels} onClick={() => setShowLabels((v) => !v)}>
                        Names
                      </button>
                    </div>
                  </div>
                  <div className="panel-body" style={{ overflow: "hidden", display: "flex" }}>
                    <TrackMap
                      key={geometryVersion}
                      geometry={session.geometry}
                      drivers={snapshot.drivers}
                      selected={selected}
                      onSelect={pickDriver}
                      showCorners={showCorners}
                      showLabels={showLabels}
                    />
                  </div>
                </div>

                <div className="panel">
                  <div className="panel-head">
                    <h2>Timing tower</h2>
                    <span style={{ fontSize: 11, color: "var(--text-faint)" }}>
                      {snapshot.drivers.filter((d) => !d.retired).length} running
                    </span>
                  </div>
                  <div className="panel-body">
                    <TimingTower snapshot={snapshot} selected={selected} onSelect={pickDriver} />
                  </div>
                </div>
              </div>
            )}

            {tab === "timing" && (
              <div style={{ padding: 14, height: "100%", minHeight: 0 }}>
                <div className="panel" style={{ height: "100%" }}>
                  <div className="panel-head">
                    <h2>Detailed timing</h2>
                  </div>
                  <div className="panel-body">
                    <TimingTower snapshot={snapshot} selected={selected} onSelect={pickDriver} detailed />
                  </div>
                </div>
              </div>
            )}

            {tab === "strategy" && (
              <div style={{ padding: 14, height: "100%", minHeight: 0 }}>
                <div className="panel" style={{ height: "100%" }}>
                  <div className="panel-head">
                    <h2>Tyre strategy</h2>
                  </div>
                  <div className="panel-body">
                    <StrategyBoard snapshot={snapshot} />
                  </div>
                </div>
              </div>
            )}

            {tab === "driver" && (
              <div style={{ padding: 14, height: "100%", minHeight: 0 }}>
                <div className="panel" style={{ height: "100%" }}>
                  <div className="panel-head">
                    <h2>Driver</h2>
                  </div>
                  <div className="panel-body">
                    <DriverPanel driver={selectedDriver} snapshot={snapshot} />
                  </div>
                </div>
              </div>
            )}

            {tab === "analysis" && (
              <AnalysisView
                session={session}
                snapshot={snapshot}
                selected={selected}
                onSelect={pickDriver}
              />
            )}

            {tab === "telemetry" && (
              <TelemetryPanel session={session} driver={selectedDriver} now={snapshot.now} />
            )}

            {tab === "radio" && (
              <div style={{ padding: 14, height: "100%", minHeight: 0 }}>
                <div className="panel" style={{ height: "100%" }}>
                  <div className="panel-head">
                    <h2>Team radio</h2>
                    <span style={{ fontSize: 11, color: "var(--text-faint)" }}>
                      {snapshot.radio.length} clips
                    </span>
                  </div>
                  <div className="panel-body">
                    <RadioFeed clips={snapshot.radio} drivers={snapshot.byNumber} />
                  </div>
                </div>
              </div>
            )}

            {tab === "calendar" && (
              <CalendarView
                year={info.year}
                currentKey={info.session_key}
                onPick={(picked) => void load(picked)}
              />
            )}

            {tab === "standings" && (
              <StandingsView
                drivers={standings}
                constructors={constructors}
                winners={winners}
                circuit={info.circuit_short_name}
                loading={historyLoading}
              />
            )}

            {tab === "control" && (
              <div style={{ padding: 14, height: "100%", minHeight: 0 }}>
                <div className="panel" style={{ height: "100%" }}>
                  <div className="panel-head">
                    <h2>Race control</h2>
                    <span style={{ fontSize: 11, color: "var(--text-faint)" }}>
                      {snapshot.messages.length} messages
                    </span>
                  </div>
                  <div className="panel-body">
                    <RaceControlFeed messages={snapshot.messages} />
                  </div>
                </div>
              </div>
            )}
          </motion.div>
        </AnimatePresence>
      </main>

      <SessionPicker
        open={pickerOpen}
        current={info}
        onClose={() => setPickerOpen(false)}
        onPick={(picked) => void load(picked)}
      />
    </div>
  );
}
