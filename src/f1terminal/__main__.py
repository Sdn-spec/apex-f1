"""Command line entry point for f1terminal."""

from __future__ import annotations

import argparse
import asyncio
import datetime as dt
import sys

from .data.openf1 import OpenF1Client, OpenF1Error, parse_dt
from .data.state import resolve_session, utcnow

EPILOG = """\
examples:
  f1terminal                              latest session, replayed from its start
  f1terminal --round zandvoort            most recent Zandvoort session
  f1terminal --year 2025 --round monza --type race
  f1terminal --session 11353 --speed 8    replay a specific session at 8x
  f1terminal --live                       poll a session that is running now
  f1terminal --list --year 2026           show the season's sessions and keys
"""


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="f1terminal",
        description="A race engineer's wall in your terminal: live F1 track map, "
        "timing, strategy and history.",
        epilog=EPILOG,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    picker = parser.add_argument_group("session selection")
    picker.add_argument("--session", type=int, metavar="KEY", help="OpenF1 session key")
    picker.add_argument("--year", type=int, help="season, e.g. 2026")
    picker.add_argument(
        "--round", dest="round_name", metavar="NAME",
        help="circuit, location or country, e.g. 'monza', 'brazil'",
    )
    picker.add_argument(
        "--type", dest="session_type", metavar="KIND",
        help="session kind: race, sprint, qualifying, practice",
    )

    playback = parser.add_argument_group("playback")
    playback.add_argument(
        "--live", action="store_true",
        help="follow the wall clock and poll for new data (for a session in progress)",
    )
    playback.add_argument(
        "--speed", type=float, default=1.0, metavar="N",
        help="replay speed multiplier (default: 1)",
    )
    playback.add_argument(
        "--at", metavar="HH:MM",
        help="start the replay at this UTC time of day instead of lights out",
    )
    playback.add_argument(
        "--from-end", type=float, metavar="MINUTES",
        help="start the replay this many minutes before the session ends",
    )

    other = parser.add_argument_group("other")
    other.add_argument("--list", action="store_true", help="list sessions and exit")
    other.add_argument("--no-cache", action="store_true", help="bypass the on-disk cache")
    other.add_argument("--clear-cache", action="store_true", help="empty the cache and exit")
    return parser


async def list_sessions(client: OpenF1Client, year: int | None) -> int:
    target = year or utcnow().year
    try:
        rows = await client.sessions(year=target)
    except OpenF1Error as exc:
        print(f"could not list sessions: {exc}", file=sys.stderr)
        return 1
    if not rows:
        print(f"no sessions found for {target}")
        return 1
    rows.sort(key=lambda row: row.get("date_start") or "")
    print(f"{'KEY':>7}  {'DATE':<16}  {'CIRCUIT':<22}  SESSION")
    for row in rows:
        start = parse_dt(row.get("date_start"))
        stamp = start.strftime("%Y-%m-%d %H:%M") if start else "—"
        print(
            f"{row['session_key']:>7}  {stamp:<16}  "
            f"{(row.get('circuit_short_name') or '—')[:22]:<22}  "
            f"{row.get('session_name') or row.get('session_type') or '—'}"
        )
    return 0


async def run(args: argparse.Namespace) -> int:
    from .data.cache import Cache

    cache = Cache(enabled=not args.no_cache)
    if args.clear_cache:
        removed = Cache().clear()
        print(f"cleared {removed} cached responses")
        return 0

    client = OpenF1Client(cache=cache)
    try:
        if args.list:
            return await list_sessions(client, args.year)

        try:
            session = await resolve_session(
                client,
                session_key=args.session,
                year=args.year,
                round_name=args.round_name,
                session_type=args.session_type,
            )
        except OpenF1Error as exc:
            print(f"could not reach the timing feed: {exc}", file=sys.stderr)
            return 1

        if session is None:
            print("no matching session found — try --list to see what is available",
                  file=sys.stderr)
            return 1

        start = parse_dt(session.get("date_start"))
        end = parse_dt(session.get("date_end"))
        running = bool(start and end and start <= utcnow() <= end)
        live = args.live or running

        start_at = None
        if args.at and start:
            try:
                hour, minute = (int(part) for part in args.at.split(":", 1))
                start_at = start.replace(hour=hour, minute=minute, second=0, microsecond=0)
            except ValueError:
                print(f"could not read --at {args.at!r}; expected HH:MM", file=sys.stderr)
                return 1
        elif args.from_end and end:
            start_at = end - dt.timedelta(minutes=args.from_end)

        name = session.get("session_name") or session.get("session_type")
        where = session.get("circuit_short_name") or session.get("location")
        mode = "live" if live else f"replay at {args.speed:g}x"
        print(f"loading {where} {name} ({session['session_key']}) — {mode}…")

        from .app import F1Terminal

        app = F1Terminal(
            session, live=live, speed=args.speed, start_at=start_at, client=client
        )
        await app.run_async()
        return 0
    finally:
        await client.aclose()


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        return asyncio.run(run(args))
    except KeyboardInterrupt:
        return 130


if __name__ == "__main__":
    raise SystemExit(main())
