"""Async rate limiter for external API providers."""

from __future__ import annotations

import asyncio
import time


class ProviderRateLimiter:
    """Rate limiter using asyncio.Semaphore and monotonic timer."""

    def __init__(self, calls_per_second: float = 10.0, min_delay: float = 0.0):
        self._semaphore = asyncio.Semaphore(1)
        self._min_interval = max(1.0 / calls_per_second, min_delay)
        self._last_call = 0.0

    async def acquire(self) -> None:
        async with self._semaphore:
            now = time.monotonic()
            wait = self._min_interval - (now - self._last_call)
            if wait > 0:
                await asyncio.sleep(wait)
            self._last_call = time.monotonic()
