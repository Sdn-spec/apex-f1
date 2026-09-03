"""Client for the Jolpica-F1 API, the maintained successor to Ergast.

OpenF1 only covers 2023 onward and holds no championship context, so historical
comparison — career wins, podium counts, head-to-head records, circuit history —
comes from here. Jolpica rate-limits aggressively (a few requests per second,
a few hundred per hour), so every response is cached to disk.
"""

from __future__ import annotations

import asyncio
from typing import Any

import httpx

from .cache import Cache

BASE_URL = "https://api.jolpi.ca/ergast/f1"

SEASON_TTL = 60 * 60 * 6
ARCHIVE_TTL = 60 * 60 * 24 * 30


class JolpicaError(RuntimeError):
    pass


class JolpicaClient:
    def __init__(
        self,
        client: httpx.AsyncClient | None = None,
        cache: Cache | None = None,
        timeout: float = 25.0,
    ) -> None:
        self._client = client
        self._owns_client = client is None
        self._timeout = timeout
        self.cache = cache or Cache()
        self._throttle = asyncio.Semaphore(2)

    async def aclose(self) -> None:
        if self._owns_client and self._client is not None:
            await self._client.aclose()
            self._client = None

    @property
    def client(self) -> httpx.AsyncClient:
        if self._client is None:
            self._client = httpx.AsyncClient(
                timeout=httpx.Timeout(self._timeout, connect=10.0),
                headers={"User-Agent": "f1terminal/0.1"},
                follow_redirects=True,
            )
        return self._client

    async def get(
        self, path: str, *, limit: int = 100, offset: int = 0, ttl: float = SEASON_TTL
    ) -> dict[str, Any]:
        ident = f"{path}?limit={limit}&offset={offset}"
        hit = self.cache.get_disk("jolpica", ident, ttl)
        if hit is not None:
            return hit

        url = f"{BASE_URL}/{path.strip('/')}.json"
        last_error: Exception | None = None
        async with self._throttle:
            for attempt in range(3):
                try:
                    response = await self.client.get(
                        url, params={"limit": limit, "offset": offset}
                    )
                    if response.status_code == 429:
                        await asyncio.sleep(2.0 * (attempt + 1))
                        continue
                    response.raise_for_status()
                    payload = response.json().get("MRData", {})
                    self.cache.set_disk("jolpica", ident, payload)
                    return payload
                except (httpx.HTTPError, ValueError) as exc:
                    last_error = exc
                    if attempt < 2:
                        await asyncio.sleep(0.8 * (attempt + 1))
        raise JolpicaError(f"{path} failed: {last_error}") from last_error

    async def driver_standings(self, season: str | int = "current") -> list[dict[str, Any]]:
        data = await self.get(f"{season}/driverStandings", limit=40)
        lists = data.get("StandingsTable", {}).get("StandingsLists", [])
        return lists[0].get("DriverStandings", []) if lists else []

    async def constructor_standings(
        self, season: str | int = "current"
    ) -> list[dict[str, Any]]:
        data = await self.get(f"{season}/constructorStandings", limit=40)
        lists = data.get("StandingsTable", {}).get("StandingsLists", [])
        return lists[0].get("ConstructorStandings", []) if lists else []

    async def season_results(self, season: str | int = "current") -> list[dict[str, Any]]:
        """Every race result for a season, following pagination."""
        races: list[dict[str, Any]] = []
        offset = 0
        while True:
            data = await self.get(f"{season}/results", limit=100, offset=offset)
            table = data.get("RaceTable", {}).get("Races", [])
            races.extend(table)
            total = int(data.get("total", 0))
            offset += 100
            if offset >= total or not table or offset > 2000:
                break
        merged: dict[str, dict[str, Any]] = {}
        for race in races:
            key = race.get("round", "")
            if key in merged:
                merged[key].setdefault("Results", []).extend(race.get("Results", []))
            else:
                merged[key] = race
        return [merged[k] for k in sorted(merged, key=lambda r: int(r or 0))]

    async def last_race(self) -> dict[str, Any] | None:
        data = await self.get("current/last/results", limit=40, ttl=1800)
        races = data.get("RaceTable", {}).get("Races", [])
        return races[0] if races else None

    async def driver_career(self, driver_id: str) -> dict[str, Any]:
        """Aggregate career totals for a driver from their full result history."""
        cached = self.cache.get_disk("jolpica-career", driver_id, ARCHIVE_TTL)
        if cached is not None:
            return cached

        results: list[dict[str, Any]] = []
        offset = 0
        while True:
            data = await self.get(f"drivers/{driver_id}/results", limit=100, offset=offset)
            races = data.get("RaceTable", {}).get("Races", [])
            results.extend(races)
            total = int(data.get("total", 0))
            offset += 100
            if offset >= total or not races or offset > 1200:
                break

        starts = wins = podiums = points_finishes = dnfs = 0
        points = 0.0
        best = 99
        seasons: set[str] = set()
        for race in results:
            for entry in race.get("Results", []):
                starts += 1
                seasons.add(race.get("season", ""))
                pos = entry.get("position")
                try:
                    pos_i = int(pos)
                except (TypeError, ValueError):
                    pos_i = 99
                best = min(best, pos_i)
                if pos_i == 1:
                    wins += 1
                if pos_i <= 3:
                    podiums += 1
                try:
                    scored = float(entry.get("points", 0))
                except (TypeError, ValueError):
                    scored = 0.0
                points += scored
                if scored > 0:
                    points_finishes += 1
                status = (entry.get("status") or "").lower()
                if "finished" not in status and "lap" not in status:
                    dnfs += 1

        summary = {
            "driver_id": driver_id,
            "starts": starts,
            "wins": wins,
            "podiums": podiums,
            "points": round(points, 1),
            "points_finishes": points_finishes,
            "dnfs": dnfs,
            "best_finish": None if best == 99 else best,
            "seasons": len(seasons),
            "first_season": min(seasons) if seasons else None,
        }
        self.cache.set_disk("jolpica-career", driver_id, summary)
        return summary

    async def circuit_history(self, circuit_id: str, limit: int = 30) -> list[dict[str, Any]]:
        """Past winners at a circuit, newest first.

        Results come back oldest-first, and no circuit has hosted more than a
        hundred championship races, so one full-size page holds the whole
        history. Requesting a short page would return the 1950s, not last year.
        """
        data = await self.get(f"circuits/{circuit_id}/results/1", limit=100, ttl=ARCHIVE_TTL)
        races = data.get("RaceTable", {}).get("Races", [])
        races.sort(key=lambda race: race.get("season", ""), reverse=True)
        return races[:limit]

    async def schedule(self, season: str | int = "current") -> list[dict[str, Any]]:
        data = await self.get(f"{season}", limit=40, ttl=SEASON_TTL)
        return data.get("RaceTable", {}).get("Races", [])
