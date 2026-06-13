"""IncompatibleProtocolError — thrown when an operation would deterministically
fail because every relevant counterpart runs an older agents-protocol
(pre-directed-replies). Failing fast beats burning the correlation timeout.
"""
from __future__ import annotations


class IncompatibleProtocolError(Exception):
    def __init__(self, operation: str, agents: list[tuple[str, int]]) -> None:
        listed = ", ".join(f"{name} (protocol {proto})" for name, proto in agents)
        super().__init__(
            f"{operation} cannot succeed: every relevant agent advertises agents-protocol < 2 "
            f"[{listed}]. Protocol >= 2 responders direct replies to the requester; older ones "
            f"broadcast and their replies never reach this SDK's filtered subscription. "
            f"Upgrade the responders to nolag-agents >= 0.3.0 / @nolag/agents >= 0.2.0. "
            f"NOTE: 0.3.0/0.2.x responders DO have directed replies but do not yet advertise "
            f"protocol — if your responders run those versions, pass allow_legacy_responders=True."
        )
