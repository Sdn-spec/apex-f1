/**
 * Team radio feed — the actual clips, playable.
 *
 * OpenF1 links straight to F1's static hosting, so the audio is served
 * cross-origin as a media element (which needs no CORS grant, unlike fetch).
 * One shared <audio> element plays at a time, because overlapping team radio is
 * unintelligible.
 */

import { motion } from "framer-motion";
import { useEffect, useRef, useState } from "react";
import type { Driver, RadioClip } from "../lib/session";
import { clockTime } from "../lib/format";

interface Props {
  clips: RadioClip[];
  drivers: Map<number, Driver>;
}

export function RadioFeed({ clips, drivers }: Props) {
  const audio = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState<string | null>(null);
  const [failed, setFailed] = useState<Set<string>>(new Set());

  useEffect(() => {
    const element = new Audio();
    element.preload = "none";
    element.addEventListener("ended", () => setPlaying(null));
    audio.current = element;
    return () => {
      element.pause();
      audio.current = null;
    };
  }, []);

  const toggle = (clip: RadioClip) => {
    const element = audio.current;
    if (!element) return;
    if (playing === clip.url) {
      element.pause();
      setPlaying(null);
      return;
    }
    element.pause();
    element.src = clip.url;
    setPlaying(clip.url);
    element.play().catch(() => {
      setPlaying(null);
      setFailed((previous) => new Set(previous).add(clip.url));
    });
  };

  const ordered = [...clips].reverse();
  if (!ordered.length) {
    return <div className="empty">No team radio has been broadcast yet in this session.</div>;
  }

  return (
    <div>
      {ordered.map((clip, index) => {
        const driver = drivers.get(clip.driverNumber);
        const isPlaying = playing === clip.url;
        const isBroken = failed.has(clip.url);
        return (
          <motion.button
            key={`${clip.date}-${index}`}
            className="radio-row"
            data-playing={isPlaying}
            onClick={() => toggle(clip)}
            initial={{ opacity: 0, x: -8 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ delay: Math.min(index * 0.02, 0.35), duration: 0.3 }}
          >
            <span className="radio-play" style={{ borderColor: driver?.colour ?? "var(--line)" }}>
              {isPlaying ? "❚❚" : "▶"}
            </span>
            <span className="radio-driver" style={{ color: driver?.colour }}>
              {driver?.acronym ?? clip.driverNumber}
            </span>
            <span className="radio-name">{driver?.lastName ?? "Unknown driver"}</span>
            {isPlaying && (
              <span className="radio-bars" aria-hidden>
                <i style={{ background: driver?.colour }} />
                <i style={{ background: driver?.colour }} />
                <i style={{ background: driver?.colour }} />
                <i style={{ background: driver?.colour }} />
              </span>
            )}
            {isBroken && <span className="radio-name" style={{ color: "var(--text-faint)" }}>unavailable</span>}
            <time>{clockTime(clip.date)}</time>
          </motion.button>
        );
      })}
    </div>
  );
}
