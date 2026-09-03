/**
 * Season calendar with a countdown to the next session.
 *
 * Times come from OpenF1 in UTC and are rendered in the viewer's own timezone,
 * which is the whole point of a schedule view — the useful question is "what
 * time is that for me", not "what time is it at the circuit".
 */

import { useEffect, useMemo, useState } from "react";
import { motion } from "framer-motion";
import type { SessionInfo } from "../lib/api";
import { openf1 } from "../lib/api";

interface Props {
  year: number;
  currentKey: number;
  onPick: (session: SessionInfo) => void;
}

interface Weekend {
  meetingKey: number;
  circuit: string;
  country: string;
  sessions: SessionInfo[];
  start: number;
  end: number;
}

function useCountdown(target: number | null) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (target == null) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [target]);
  if (target == null) return null;
  const remaining = Math.max(target - now, 0);
  return {
    days: Math.floor(remaining / 86_400_000),
    hours: Math.floor((remaining % 86_400_000) / 3_600_000),
    minutes: Math.floor((remaining % 3_600_000) / 60_000),
    seconds: Math.floor((remaining % 60_000) / 1000),
    done: remaining === 0,
  };
}

export function CalendarView({ year, currentKey, onPick }: Props) {
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    openf1
      .sessions({ year })
      .then((rows) => {
        if (!cancelled) setSessions(rows);
      })
      .catch(() => {
        if (!cancelled) setSessions([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [year]);

  const weekends = useMemo(() => {
    const grouped = new Map<number, Weekend>();
    for (const session of sessions) {
      const start = Date.parse(session.date_start);
      const end = Date.parse(session.date_end);
      const existing = grouped.get(session.meeting_key);
      if (existing) {
        existing.sessions.push(session);
        existing.start = Math.min(existing.start, start);
        existing.end = Math.max(existing.end, end);
      } else {
        grouped.set(session.meeting_key, {
          meetingKey: session.meeting_key,
          circuit: session.circuit_short_name,
          country: session.country_name,
          sessions: [session],
          start,
          end,
        });
      }
    }
    const list = [...grouped.values()].sort((a, b) => a.start - b.start);
    for (const weekend of list) weekend.sessions.sort((a, b) => Date.parse(a.date_start) - Date.parse(b.date_start));
    return list;
  }, [sessions]);

  const nextSession = useMemo(() => {
    const now = Date.now();
    return (
      sessions
        .filter((session) => Date.parse(session.date_start) > now)
        .sort((a, b) => Date.parse(a.date_start) - Date.parse(b.date_start))[0] ?? null
    );
  }, [sessions]);

  const countdown = useCountdown(nextSession ? Date.parse(nextSession.date_start) : null);
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;

  if (loading) return <div className="empty">Loading the {year} calendar…</div>;
  if (!weekends.length) return <div className="empty">No calendar available for {year}.</div>;

  return (
    <div style={{ padding: 14, display: "grid", gap: 14 }}>
      {nextSession && countdown && (
        <motion.div
          className="panel countdown"
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
        >
          <div>
            <span className="countdown-label">Next up</span>
            <h3>
              {nextSession.country_name} · {nextSession.session_name}
            </h3>
            <p>
              {nextSession.circuit_short_name} ·{" "}
              {new Date(nextSession.date_start).toLocaleString([], {
                weekday: "short",
                day: "numeric",
                month: "short",
                hour: "2-digit",
                minute: "2-digit",
              })}{" "}
              <span style={{ color: "var(--text-faint)" }}>({timezone})</span>
            </p>
          </div>
          <div className="countdown-clock">
            {[
              { value: countdown.days, label: "days" },
              { value: countdown.hours, label: "hrs" },
              { value: countdown.minutes, label: "min" },
              { value: countdown.seconds, label: "sec" },
            ].map((unit) => (
              <div key={unit.label}>
                <b>{String(unit.value).padStart(2, "0")}</b>
                <span>{unit.label}</span>
              </div>
            ))}
          </div>
        </motion.div>
      )}

      <div className="panel">
        <div className="panel-head">
          <h2>{year} season</h2>
          <span style={{ fontSize: 11, color: "var(--text-faint)" }}>
            {weekends.length} rounds · times in {timezone}
          </span>
        </div>
        <div>
          {weekends.map((weekend, index) => {
            const past = weekend.end < Date.now();
            const live = weekend.start <= Date.now() && Date.now() <= weekend.end;
            return (
              <motion.div
                key={weekend.meetingKey}
                className="weekend"
                data-past={past}
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: Math.min(index * 0.02, 0.4), duration: 0.3 }}
              >
                <div className="weekend-round">
                  <b>{String(index + 1).padStart(2, "0")}</b>
                  {live && <span className="live-dot" />}
                </div>
                <div className="weekend-where">
                  <b>{weekend.circuit}</b>
                  <span>{weekend.country}</span>
                </div>
                <div className="weekend-when">
                  {new Date(weekend.start).toLocaleDateString([], { day: "numeric", month: "short" })}
                  {" – "}
                  {new Date(weekend.end).toLocaleDateString([], { day: "numeric", month: "short" })}
                </div>
                <div className="weekend-sessions">
                  {weekend.sessions.map((session) => {
                    const started = Date.parse(session.date_start) <= Date.now();
                    return (
                      <button
                        key={session.session_key}
                        className="pill"
                        data-on={session.session_key === currentKey}
                        disabled={!started}
                        title={
                          started
                            ? `Open ${session.session_name}`
                            : new Date(session.date_start).toLocaleString()
                        }
                        onClick={() => started && onPick(session)}
                        style={{ opacity: started ? 1 : 0.4, cursor: started ? "pointer" : "default" }}
                      >
                        {session.session_name}
                        <span style={{ color: "var(--text-faint)", marginLeft: 6, fontSize: 10 }}>
                          {new Date(session.date_start).toLocaleTimeString([], {
                            hour: "2-digit",
                            minute: "2-digit",
                          })}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </motion.div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
