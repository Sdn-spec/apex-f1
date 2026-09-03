"""Two-tier cache: in-process memory plus a JSON file cache under ~/.cache/f1terminal.

Static race data (circuit geometry, finished sessions, historical standings) never
changes once published, so it is cached to disk with a long TTL. Live timing is
cached in memory only, for a few seconds, to collapse duplicate polls.
"""

from __future__ import annotations

import hashlib
import json
import os
import time
from pathlib import Path
from typing import Any

CACHE_ROOT = Path(os.environ.get("F1TERMINAL_CACHE", Path.home() / ".cache" / "f1terminal"))


def _key(namespace: str, ident: str) -> str:
    digest = hashlib.sha256(ident.encode("utf-8")).hexdigest()[:24]
    return f"{namespace}-{digest}"


class Cache:
    def __init__(self, root: Path | None = None, enabled: bool = True) -> None:
        self.root = root or CACHE_ROOT
        self.enabled = enabled
        self._memory: dict[str, tuple[float, Any]] = {}
        if self.enabled:
            try:
                self.root.mkdir(parents=True, exist_ok=True)
            except OSError:
                self.enabled = False

    def get_memory(self, namespace: str, ident: str, ttl: float) -> Any | None:
        entry = self._memory.get(_key(namespace, ident))
        if entry is None:
            return None
        stored_at, value = entry
        if time.monotonic() - stored_at > ttl:
            return None
        return value

    def set_memory(self, namespace: str, ident: str, value: Any) -> None:
        self._memory[_key(namespace, ident)] = (time.monotonic(), value)

    def _path(self, namespace: str, ident: str) -> Path:
        return self.root / f"{_key(namespace, ident)}.json"

    def get_disk(self, namespace: str, ident: str, ttl: float | None = None) -> Any | None:
        if not self.enabled:
            return None
        path = self._path(namespace, ident)
        try:
            raw = path.read_text("utf-8")
        except (OSError, ValueError):
            return None
        try:
            payload = json.loads(raw)
        except json.JSONDecodeError:
            return None
        if ttl is not None and time.time() - payload.get("stored_at", 0) > ttl:
            return None
        return payload.get("value")

    def set_disk(self, namespace: str, ident: str, value: Any) -> None:
        if not self.enabled:
            return
        path = self._path(namespace, ident)
        tmp = path.with_suffix(".tmp")
        try:
            tmp.write_text(json.dumps({"stored_at": time.time(), "value": value}), "utf-8")
            tmp.replace(path)
        except (OSError, TypeError):
            tmp.unlink(missing_ok=True)

    def clear(self) -> int:
        self._memory.clear()
        if not self.enabled:
            return 0
        removed = 0
        for path in self.root.glob("*.json"):
            try:
                path.unlink()
                removed += 1
            except OSError:
                pass
        return removed
