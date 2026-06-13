from __future__ import annotations

import asyncio
from typing import Any, Generic, TypeVar

T = TypeVar("T")


class CorrelationManager(Generic[T]):
    """Maps correlation IDs to pending asyncio.Future with optional timeout."""

    def __init__(self) -> None:
        self._pending: dict[str, _Entry] = {}

    def register(
        self,
        correlation_id: str,
        timeout_ms: int | None = None,
        context: str | None = None,
    ) -> asyncio.Future[T]:
        loop = asyncio.get_running_loop()
        future: asyncio.Future[T] = loop.create_future()
        handle: asyncio.TimerHandle | None = None

        if timeout_ms and timeout_ms > 0:
            def _on_timeout():
                self._pending.pop(correlation_id, None)
                if not future.done():
                    # Context turns an opaque correlation id into an
                    # actionable error — callers supply what they were
                    # waiting for and the likely causes.
                    what = context or f"Correlation {correlation_id}"
                    future.set_exception(
                        TimeoutError(f"{what} timed out after {timeout_ms}ms")
                    )
            handle = loop.call_later(timeout_ms / 1000.0, _on_timeout)

        self._pending[correlation_id] = _Entry(future=future, handle=handle)
        return future

    def resolve(self, correlation_id: str, value: T) -> bool:
        entry = self._pending.pop(correlation_id, None)
        if entry is None:
            return False
        if entry.handle:
            entry.handle.cancel()
        if not entry.future.done():
            entry.future.set_result(value)
        return True

    def reject(self, correlation_id: str, error: Exception) -> bool:
        entry = self._pending.pop(correlation_id, None)
        if entry is None:
            return False
        if entry.handle:
            entry.handle.cancel()
        if not entry.future.done():
            entry.future.set_exception(error)
        return True

    def has(self, correlation_id: str) -> bool:
        return correlation_id in self._pending

    def clear(self) -> None:
        for cid, entry in list(self._pending.items()):
            if entry.handle:
                entry.handle.cancel()
            if not entry.future.done():
                entry.future.set_exception(Exception(f"Correlation {cid} cancelled"))
        self._pending.clear()

    @property
    def size(self) -> int:
        return len(self._pending)


class _Entry:
    __slots__ = ("future", "handle")

    def __init__(self, future: asyncio.Future, handle: asyncio.TimerHandle | None) -> None:
        self.future = future
        self.handle = handle
