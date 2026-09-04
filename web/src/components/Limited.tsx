/**
 * What the app shows when the timing feed will not talk to us.
 *
 * OpenF1 restricts all unauthenticated access — historical sessions included —
 * for as long as a session is running, and the refusal arrives without a CORS
 * header, so the browser reports only a generic network failure. Left alone
 * that surfaces as "Failed to fetch", which tells a reader nothing and looks
 * like the app is broken during precisely the hours they came to use it.
 *
 * So this screen says what is actually happening, and keeps the parts of the
 * app that do not depend on that feed — the championship and the calendar,
 * both served by Jolpica — running instead of showing a dead page.
 */

import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import { history, setOpenf1Key, openf1Key, type FeedFault, type HistoryRace, type StandingRow } from "../lib/api";
import { StandingsView } from "./Views";

interface Props {
  fault: FeedFault;
  detail: string | null;
  onRetry: () => void;
}

export function LimitedMode({ fault, detail, onRetry }: Props) {
  const [drivers, setDrivers] = useState<StandingRow[]>([]);
  const [constructors, setConstructors] = useState<StandingRow[]>([]);
  const [schedule, setSchedule] = useState<HistoryRace[]>([]);
  const [loading, setLoading] = useState(true);
  const [key, setKey] = useState(openf1Key() ?? "");

  useEffect(() => {
    if (fault === "offline") {
      setLoading(false);
      return;
    }
    let cancelled = false;
    Promise.all([
      history.driverStandings("current").catch(() => []),
      history.constructorStandings("current").catch(() => []),
      history.schedule("current").catch(() => []),
    ])
      .then(([d, c, s]) => {
        if (cancelled) return;
        setDrivers(d);
        setConstructors(c);
        setSchedule(s);
      })
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [fault]);

  const offline = fault === "offline";
  const next = schedule.find((race) => Date.parse(`${race.date}T${race.time ?? "12:00:00Z"}`) > Date.now());

  return (
    <div className="limited">
      <motion.div
        className="limited-note"
        initial={{ opacity: 0, y: -8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.35, ease: [0.16, 1, 0.3, 1] }}
      >
        <div className="limited-head">
          <span className="limited-badge">{offline ? "OFFLINE" : "TIMING FEED LOCKED"}</span>
          <h1>{offline ? "No network connection" : "Live timing is not available right now"}</h1>
        </div>

        {offline ? (
          <p>
            Neither the timing feed nor the results archive can be reached, which usually means
            this device is offline. Everything works again as soon as the connection is back.
          </p>
        ) : (
          <>
            <p>
              OpenF1, the feed behind the track map and timing screens, closes access to
              unauthenticated users while a session is actually running — and that lockout covers
              the historical archive too, not just the live session. It lifts by itself once the
              session ends.
            </p>
            <p className="limited-dim">
              {next
                ? `Next up: ${next.raceName}, ${new Date(`${next.date}T${next.time ?? "12:00:00Z"}`).toLocaleString(undefined, { weekday: "long", day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" })}.`
                : "Practice, qualifying and the race are all sessions, so a race weekend locks the feed several times over."}
            </p>
            <div className="limited-key">
              <label htmlFor="openf1-key">
                Have an OpenF1 sponsor key? It unlocks live sessions. Stored only in this browser.
              </label>
              <div className="limited-key-row">
                <input
                  id="openf1-key"
                  type="password"
                  placeholder="OpenF1 API key"
                  value={key}
                  onChange={(event) => setKey(event.target.value)}
                  spellCheck={false}
                />
                <button
                  className="pill"
                  onClick={() => {
                    setOpenf1Key(key.trim() || null);
                    onRetry();
                  }}
                >
                  Save &amp; retry
                </button>
              </div>
            </div>
          </>
        )}

        <div className="limited-actions">
          <button className="pill" data-on="true" onClick={onRetry}>
            Try again
          </button>
          {detail && <code className="limited-detail">{detail}</code>}
        </div>
      </motion.div>

      {!offline && (
        <div className="limited-body">
          <div className="limited-caption">
            Championship standings and the season calendar come from a different archive, so they
            are unaffected.
          </div>
          <StandingsView
            drivers={drivers}
            constructors={constructors}
            winners={[]}
            circuit=""
            loading={loading}
          />
        </div>
      )}
    </div>
  );
}
