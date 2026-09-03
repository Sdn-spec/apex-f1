/** Pick any session from any season the feed covers. */

import { AnimatePresence, motion } from "framer-motion";
import { useEffect, useMemo, useState } from "react";
import { openf1, type SessionInfo } from "../lib/api";
import { shortDate } from "../lib/format";

const FIRST_YEAR = 2023;

interface Props {
  open: boolean;
  current: SessionInfo | null;
  onClose: () => void;
  onPick: (session: SessionInfo) => void;
}

export function SessionPicker({ open, current, onClose, onPick }: Props) {
  const thisYear = new Date().getFullYear();
  const [year, setYear] = useState(current?.year ?? thisYear);
  const [kind, setKind] = useState("Race");
  const [query, setQuery] = useState("");
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open) return;
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
  }, [open, year]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  const visible = useMemo(() => {
    const now = Date.now();
    const needle = query.trim().toLowerCase();
    return sessions
      .filter((row) => Date.parse(row.date_start) <= now)
      .filter((row) => (kind === "All" ? true : (row.session_name ?? "").includes(kind)))
      .filter((row) =>
        needle
          ? `${row.circuit_short_name} ${row.location} ${row.country_name}`.toLowerCase().includes(needle)
          : true,
      )
      .sort((a, b) => Date.parse(b.date_start) - Date.parse(a.date_start));
  }, [sessions, kind, query]);

  const years = Array.from({ length: thisYear - FIRST_YEAR + 1 }, (_, i) => thisYear - i);

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="picker-backdrop"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.18 }}
          onClick={onClose}
        >
          <motion.div
            className="picker"
            initial={{ opacity: 0, y: 18, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 12, scale: 0.98 }}
            transition={{ duration: 0.26, ease: [0.16, 1, 0.3, 1] }}
            onClick={(event) => event.stopPropagation()}
          >
            <div className="panel-head" style={{ padding: "16px 20px", gap: 10 }}>
              <h2 style={{ fontSize: 12 }}>Choose a session</h2>
              <div style={{ display: "flex", gap: 8, marginLeft: "auto", flexWrap: "wrap" }}>
                <label className="field">
                  <select value={year} onChange={(event) => setYear(Number(event.target.value))}>
                    {years.map((value) => (
                      <option key={value} value={value}>
                        {value}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="field">
                  <select value={kind} onChange={(event) => setKind(event.target.value)}>
                    {["Race", "Qualifying", "Sprint", "Practice", "All"].map((value) => (
                      <option key={value} value={value}>
                        {value}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="field">
                  <input
                    placeholder="Filter circuit…"
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    style={{ width: 130 }}
                  />
                </label>
              </div>
            </div>

            <div className="panel-body">
              {loading && <div className="empty">Loading {year} calendar…</div>}
              {!loading && !visible.length && <div className="empty">No sessions match.</div>}
              {visible.map((session) => (
                <button
                  key={session.session_key}
                  className="picker-row"
                  onClick={() => {
                    onPick(session);
                    onClose();
                  }}
                >
                  <span className="tnum" style={{ color: "var(--text-faint)", fontSize: 12 }}>
                    {shortDate(session.date_start)}
                  </span>
                  <span style={{ fontWeight: 600 }}>
                    {session.circuit_short_name}
                    <span style={{ color: "var(--text-faint)", fontWeight: 400 }}> · {session.country_name}</span>
                  </span>
                  <span style={{ color: "var(--text-dim)", fontSize: 12 }}>{session.session_name}</span>
                  <span
                    className="tnum"
                    style={{
                      fontSize: 11,
                      color: session.session_key === current?.session_key ? "var(--red)" : "var(--text-faint)",
                      textAlign: "right",
                    }}
                  >
                    {session.session_key === current?.session_key ? "CURRENT" : session.session_key}
                  </span>
                </button>
              ))}
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
