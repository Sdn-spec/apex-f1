"""Client for the OpenF1 API (https://openf1.org).

OpenF1 exposes the same feed the F1 broadcast graphics are built from: car
positions at ~3.7 Hz, timing, tyre stints, pit stops, weather and race control
messages. Every endpoint is a flat list of records filtered by query parameters,
and comparison filters are expressed as suffixed parameter names (``date>``).
"""

from __future__ import annotations

import asyncio
import datetime as dt
from typing import Any, Iterable

import httpx

from .cache import Cache

BASE_URL = "https://api.openf1.org/v1"

# Sessions that have ended are immutable, so their timing can be cached hard.
FINISHED_TTL = 60 * 60 * 24 * 30
LIVE_TTL = 3.0


class OpenF1Error(RuntimeError):
    pass


def _iso(value: dt.datetime) -> str:
    """OpenF1 wants naive-looking ISO timestamps in UTC."""
    if value.tzinfo is not None:
        value = value.astimezone(dt.timezone.utc).replace(tzinfo=None)
    return value.isoformat(timespec="milliseconds")


# OpenF1 reads comparison filters off the raw query string as `date>=VALUE`.
# A urlencoded param named "date>" serialises to `date%3E=VALUE`, which decodes
# to exactly that. Naming it "date>=" instead yields a doubled `=` and a 500.
AFTER = "date>"
BEFORE = "date<"


def parse_dt(value: str | None) -> dt.datetime | None:
    if not value:
        return None
    try:
        parsed = dt.datetime.fromisoformat(value)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=dt.timezone.utc)
    return parsed.astimezone(dt.timezone.utc)


class OpenF1Client:
    def __init__(
        self,
        client: httpx.AsyncClient | None = None,
        cache: Cache | None = None,
        timeout: float = 30.0,
    ) -> None:
        self._client = client
        self._owns_client = client is None
        self._timeout = timeout
        self.cache = cache or Cache()
        # OpenF1 rate-limits by burst, and a session refresh fans out to eight
        # endpoints at once; without this the tail of the fan-out gets 429s.
        self._gate = asyncio.Semaphore(2)

    async def __aenter__(self) -> "OpenF1Client":
        return self

    async def __aexit__(self, *exc: object) -> None:
        await self.aclose()

    async def aclose(self) -> None:
        if self._owns_client and self._client is not None:
            await self._client.aclose()
            self._client = None

    @property
    def client(self) -> httpx.AsyncClient:
        if self._client is None:
            self._client = httpx.AsyncClient(
                timeout=httpx.Timeout(self._timeout, connect=10.0),
                headers={"User-Agent": "f1terminal/0.1 (+https://openf1.org)"},
                follow_redirects=True,
            )
        return self._client

    async def get(
        self,
        endpoint: str,
        params: dict[str, Any],
        *,
        cache_ttl: float | None = None,
        persist: bool = False,
        retries: int = 3,
    ) -> list[dict[str, Any]]:
        clean = {k: v for k, v in params.items() if v is not None}
        ident = endpoint + "?" + "&".join(f"{k}={clean[k]}" for k in sorted(clean))

        if persist:
            hit = self.cache.get_disk("openf1", ident, FINISHED_TTL)
            if hit is not None:
                return hit
        if cache_ttl:
            hit = self.cache.get_memory("openf1", ident, cache_ttl)
            if hit is not None:
                return hit

        last_error: Exception | None = None
        for attempt in range(retries):
            try:
                async with self._gate:
                    response = await self.client.get(f"{BASE_URL}/{endpoint}", params=clean)
                if response.status_code == 429:
                    last_error = OpenF1Error("rate limited (429)")
                    await asyncio.sleep(2.0 * (attempt + 1))
                    continue
                response.raise_for_status()
                payload = response.json()
                if isinstance(payload, dict):
                    # OpenF1 reports errors as an object rather than a list.
                    raise OpenF1Error(str(payload.get("detail") or payload)[:200])
                if cache_ttl:
                    self.cache.set_memory("openf1", ident, payload)
                if persist:
                    self.cache.set_disk("openf1", ident, payload)
                return payload
            except (httpx.HTTPError, OpenF1Error, ValueError) as exc:
                last_error = exc
                if attempt < retries - 1:
                    await asyncio.sleep(0.8 * (attempt + 1))
        raise OpenF1Error(f"{endpoint} failed: {last_error}") from last_error

    # ---- metadata -------------------------------------------------------

    async def meetings(self, year: int) -> list[dict[str, Any]]:
        return await self.get("meetings", {"year": year}, persist=True)

    async def sessions(
        self,
        *,
        year: int | None = None,
        session_key: int | str | None = None,
        meeting_key: int | None = None,
        session_type: str | None = None,
    ) -> list[dict[str, Any]]:
        params = {
            "year": year,
            "session_key": session_key,
            "meeting_key": meeting_key,
            "session_type": session_type,
        }
        persist = session_key != "latest" and year is not None
        return await self.get("sessions", params, persist=persist, cache_ttl=30.0)

    async def latest_session(self) -> dict[str, Any] | None:
        rows = await self.get("sessions", {"session_key": "latest"}, cache_ttl=30.0)
        return rows[0] if rows else None

    async def drivers(self, session_key: int) -> list[dict[str, Any]]:
        return await self.get("drivers", {"session_key": session_key}, cache_ttl=300.0)

    # ---- timing ---------------------------------------------------------

    async def position(
        self, session_key: int, since: dt.datetime | None = None, persist: bool = False
    ) -> list[dict[str, Any]]:
        params: dict[str, Any] = {"session_key": session_key}
        if since:
            params[AFTER] = _iso(since)
        return await self.get("position", params, cache_ttl=LIVE_TTL, persist=persist)

    async def intervals(
        self, session_key: int, since: dt.datetime | None = None, persist: bool = False
    ) -> list[dict[str, Any]]:
        params: dict[str, Any] = {"session_key": session_key}
        if since:
            params[AFTER] = _iso(since)
        return await self.get("intervals", params, cache_ttl=LIVE_TTL, persist=persist)

    async def laps(
        self,
        session_key: int,
        *,
        driver_number: int | None = None,
        lap_number: int | None = None,
        persist: bool = False,
    ) -> list[dict[str, Any]]:
        params = {
            "session_key": session_key,
            "driver_number": driver_number,
            "lap_number": lap_number,
        }
        return await self.get("laps", params, cache_ttl=LIVE_TTL, persist=persist)

    async def stints(self, session_key: int, persist: bool = False) -> list[dict[str, Any]]:
        return await self.get(
            "stints", {"session_key": session_key}, cache_ttl=15.0, persist=persist
        )

    async def pit(self, session_key: int, persist: bool = False) -> list[dict[str, Any]]:
        return await self.get(
            "pit", {"session_key": session_key}, cache_ttl=15.0, persist=persist
        )

    async def weather(
        self, session_key: int, since: dt.datetime | None = None, persist: bool = False
    ) -> list[dict[str, Any]]:
        params: dict[str, Any] = {"session_key": session_key}
        if since:
            params[AFTER] = _iso(since)
        return await self.get("weather", params, cache_ttl=30.0, persist=persist)

    async def race_control(
        self, session_key: int, persist: bool = False
    ) -> list[dict[str, Any]]:
        return await self.get(
            "race_control", {"session_key": session_key}, cache_ttl=10.0, persist=persist
        )

    async def car_data(
        self,
        session_key: int,
        *,
        driver_number: int | None = None,
        start: dt.datetime | None = None,
        end: dt.datetime | None = None,
    ) -> list[dict[str, Any]]:
        params: dict[str, Any] = {"session_key": session_key, "driver_number": driver_number}
        if start:
            params[AFTER] = _iso(start)
        if end:
            params[BEFORE] = _iso(end)
        return await self.get("car_data", params, cache_ttl=LIVE_TTL)

    async def location(
        self,
        session_key: int,
        *,
        driver_number: int | None = None,
        start: dt.datetime | None = None,
        end: dt.datetime | None = None,
        persist: bool = False,
    ) -> list[dict[str, Any]]:
        """Car coordinates in a track-local frame, roughly decimetres."""
        params: dict[str, Any] = {"session_key": session_key, "driver_number": driver_number}
        if start:
            params[AFTER] = _iso(start)
        if end:
            params[BEFORE] = _iso(end)
        return await self.get("location", params, cache_ttl=LIVE_TTL, persist=persist)

    async def session_result(
        self, session_key: int, persist: bool = False
    ) -> list[dict[str, Any]]:
        try:
            return await self.get(
                "session_result",
                {"session_key": session_key},
                cache_ttl=60.0,
                persist=persist,
            )
        except OpenF1Error:
            return []

    async def gather(self, *coros: Iterable[Any]) -> list[Any]:
        """Run requests concurrently, returning exceptions instead of raising."""
        return await asyncio.gather(*coros, return_exceptions=True)
