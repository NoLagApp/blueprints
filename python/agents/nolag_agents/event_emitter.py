from __future__ import annotations

from collections import defaultdict
from typing import Any, Callable
import traceback


class EventEmitter:
    """Typed event emitter matching the JS SDK pattern."""

    def __init__(self) -> None:
        self._listeners: dict[str, list[Callable[..., Any]]] = defaultdict(list)

    def on(self, event: str, handler: Callable[..., Any]) -> EventEmitter:
        if handler not in self._listeners[event]:
            self._listeners[event].append(handler)
        return self

    def off(self, event: str, handler: Callable[..., Any] | None = None) -> EventEmitter:
        if handler is None:
            self._listeners.pop(event, None)
        elif event in self._listeners:
            try:
                self._listeners[event].remove(handler)
            except ValueError:
                pass
        return self

    def remove_all_listeners(self) -> EventEmitter:
        self._listeners.clear()
        return self

    def _emit(self, event: str, *args: Any) -> None:
        for handler in list(self._listeners.get(event, [])):
            try:
                handler(*args)
            except Exception:
                traceback.print_exc()

    def listener_count(self, event: str) -> int:
        return len(self._listeners.get(event, []))
