from __future__ import annotations

import uuid
import time
from typing import Any

FilterValue = str | list[str]
"""A single subscription filter value.

A plain string is an OR term: ``["alice", "bob"]`` matches either. A nested
list is an AND group: ``[["alice", "admin"]]`` matches only what was published
tagged with both.
"""


def generate_id() -> str:
    return str(uuid.uuid4())


def merge_filters(existing: list[FilterValue], add: list[str]) -> list[FilterValue]:
    """Merge OR terms into a filter set, preserving AND groups (nested lists)."""
    simple: list[str] = []
    groups: list[list[str]] = []
    for item in existing:
        if isinstance(item, str):
            if item not in simple:
                simple.append(item)
        else:
            groups.append(item)
    for value in add:
        if value not in simple:
            simple.append(value)
    return [*simple, *groups]


def without_filters(existing: list[FilterValue], remove: list[str]) -> list[FilterValue]:
    """Drop OR terms from a filter set. AND groups are left untouched."""
    drop = set(remove)
    return [item for item in existing if not (isinstance(item, str) and item in drop)]


def composite_filter_key(values: list[str]) -> str:
    """The composite key the server derives from an AND filter group.

    Values are lowercased, sorted, and joined with '|'. Mirrored here so an
    item created locally carries the same filter string as one off the wire.
    """
    return "|".join(sorted(v.lower() for v in values))


def inherit_filter(filter_value: str | None) -> dict[str, Any]:
    """Rebuild publish kwargs from the filter a message arrived with.

    The server joins AND groups into one composite value with '|', which is not
    a legal character in a plain filter, so split those back apart.
    """
    if not filter_value:
        return {}
    if "|" in filter_value:
        return {"filters": filter_value.split("|")}
    return {"filter": filter_value}


def create_timestamp() -> int:
    return int(time.time() * 1000)


def create_logger(prefix: str, enabled: bool):
    if not enabled:
        return lambda *args: None
    def _log(*args):
        print(f"[{prefix}]", *args)
    return _log
