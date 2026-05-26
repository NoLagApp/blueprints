from __future__ import annotations

import asyncio
from typing import Any, Callable

from .event_emitter import EventEmitter
from .types import AgentPresenceData, ConnectedAgent
from .constants import (
    TOPIC_TASKS,
    TOPIC_RESULTS,
    TOPIC_STATE,
    TOPIC_EVENTS,
    TOPIC_INBOX,
    TOPIC_TOOLS,
    TOPIC_APPROVAL,
)


class AgentRoom(EventEmitter):
    """Wraps a nolag Room for agent coordination topics.

    Provides typed pub/sub, presence-based service discovery,
    and capability routing.
    """

    def __init__(
        self,
        name: str,
        room_context: Any,
        client: Any,
        log: Callable[..., None],
        agent_id: str,
        presence: AgentPresenceData | None = None,
        load_balance: bool = False,
        load_balance_group: str | None = None,
        load_balance_topics: list[str] | None = None,
    ) -> None:
        super().__init__()
        self.name = name
        self.agent_id = agent_id
        self._room_context = room_context
        self._client = client
        self._log = log
        self._presence = presence
        self._agents: dict[str, ConnectedAgent] = {}
        self._load_balance = load_balance
        self._load_balance_group = load_balance_group
        self._load_balance_topics = set(load_balance_topics or [TOPIC_TASKS, TOPIC_TOOLS])

        self._wire_topic_listeners()
        self._wire_presence_listeners()

    async def initialize(self) -> None:
        """Async initialization — subscribe to topics and set presence."""
        from nolag import SubscribeOptions

        all_topics = [
            TOPIC_TASKS, TOPIC_RESULTS, TOPIC_STATE,
            TOPIC_EVENTS, TOPIC_INBOX, TOPIC_TOOLS, TOPIC_APPROVAL,
        ]
        for topic in all_topics:
            if self._load_balance and topic in self._load_balance_topics:
                opts = SubscribeOptions(
                    load_balance=True,
                    load_balance_group=self._load_balance_group or self.agent_id,
                )
                self._log(f"subscribing to {topic} with load balance (group={opts.load_balance_group})")
                await self._room_context.subscribe(topic, opts)
            else:
                await self._room_context.subscribe(topic)

        if self._presence:
            self._log(f"setting presence in room {self.name}:", self._presence)
            await self._room_context.set_presence(self._presence.to_dict())

        await self._fetch_initial_presence()

    # ── Service Discovery ──

    def get_connected_agents(self) -> list[ConnectedAgent]:
        return list(self._agents.values())

    def find_agents(self, capability: str) -> list[ConnectedAgent]:
        return [a for a in self._agents.values() if capability in a.capabilities]

    def has_capability(self, capability: str) -> bool:
        return len(self.find_agents(capability)) > 0

    def get_available_capabilities(self) -> list[str]:
        caps: set[str] = set()
        for agent in self._agents.values():
            caps.update(agent.capabilities)
        return list(caps)

    # ── Presence ──

    async def set_presence(self, data: AgentPresenceData) -> None:
        self._presence = data
        self._log(f"updating presence in room {self.name}")
        await self._room_context.set_presence(data.to_dict())

    async def fetch_presence(self) -> list[ConnectedAgent]:
        try:
            actors = await self._room_context.fetch_presence()
            return [self._to_connected_agent(a) for a in (actors or [])]
        except Exception:
            return []

    def emit_presence(
        self,
        event: str,
        actor_id: str,
        data: AgentPresenceData | None = None,
    ) -> None:
        if event == "presence_leave":
            self._emit("presence_leave", actor_id)
        else:
            self._emit(event, actor_id, data or AgentPresenceData(name="", role="agent"))

    # ── Publish ──

    @property
    def context(self) -> Any:
        return self._room_context

    async def publish_task(self, envelope: Any) -> None:
        d = envelope.to_dict() if hasattr(envelope, "to_dict") else envelope
        if not d.get("createdBy"):
            d["createdBy"] = self.agent_id
        await self._publish(TOPIC_TASKS, d)

    async def publish_result(self, envelope: Any) -> None:
        d = envelope.to_dict() if hasattr(envelope, "to_dict") else envelope
        if not d.get("completedBy"):
            d["completedBy"] = self.agent_id
        await self._publish(TOPIC_RESULTS, d)

    async def publish_state(self, data: dict[str, Any]) -> None:
        if not data.get("updatedBy"):
            data["updatedBy"] = self.agent_id
        await self._publish(TOPIC_STATE, data, retain=True)

    async def publish_event(self, data: dict[str, Any]) -> None:
        if not data.get("emittedBy"):
            data["emittedBy"] = self.agent_id
        await self._publish(TOPIC_EVENTS, data)

    async def publish_inbox(self, data: dict[str, Any]) -> None:
        await self._publish(TOPIC_INBOX, data)

    async def publish_tools(self, data: dict[str, Any]) -> None:
        await self._publish(TOPIC_TOOLS, data)

    async def publish_approval(self, data: dict[str, Any]) -> None:
        await self._publish(TOPIC_APPROVAL, data, retain=True)

    # ── Internals ──

    async def _publish(self, topic: str, data: Any, retain: bool = False) -> None:
        self._log(f"publish to {topic} in room {self.name}")
        from .types import _to_camel_dict
        from nolag import EmitOptions
        if retain:
            await self._room_context.emit(topic, data, EmitOptions(retain=True))
        else:
            await self._room_context.emit(topic, data)

    def _to_connected_agent(self, actor: Any) -> ConnectedAgent:
        if isinstance(actor, dict):
            presence = actor.get("presence") or actor.get("data") or {}
            return ConnectedAgent(
                actor_id=actor.get("actor_token_id") or actor.get("actor_id") or "",
                name=presence.get("name") or actor.get("actor_token_id") or "",
                role=presence.get("role", "agent"),
                capabilities=presence.get("capabilities", []),
                metadata=presence.get("metadata"),
                connected_at=actor.get("joined_at") or 0,
            )
        # ActorPresence object from SDK
        if hasattr(actor, "actor_token_id"):
            p = getattr(actor, "presence", {}) or {}
            return ConnectedAgent(
                actor_id=actor.actor_token_id,
                name=p.get("name", actor.actor_token_id),
                role=p.get("role", "agent"),
                capabilities=p.get("capabilities", []),
                metadata=p.get("metadata"),
                connected_at=getattr(actor, "joined_at", 0) or 0,
            )
        return ConnectedAgent()

    async def _fetch_initial_presence(self) -> None:
        try:
            actors = await self._room_context.fetch_presence()
            if isinstance(actors, list):
                for actor in actors:
                    connected = self._to_connected_agent(actor)
                    if connected.actor_id:
                        self._agents[connected.actor_id] = connected
                self._log(f"discovered {len(self._agents)} agents in room {self.name}")
        except Exception:
            pass

    def _wire_presence_listeners(self) -> None:
        if not self._client:
            return

        def _on_join(actor: Any) -> None:
            # SDK sends ActorPresence objects for presence:join
            actor_id = getattr(actor, "actor_token_id", None)
            if not actor_id:
                return
            p = getattr(actor, "presence", {}) or {}
            agent = ConnectedAgent(
                actor_id=actor_id,
                name=p.get("name", actor_id),
                role=p.get("role", "agent"),
                capabilities=p.get("capabilities", []),
                metadata=p.get("metadata"),
                connected_at=0,
            )
            self._agents[actor_id] = agent
            self._log(f"agent joined room {self.name}:", agent.name)
            pdata = AgentPresenceData(
                name=agent.name,
                role=agent.role,
                capabilities=agent.capabilities,
                metadata=agent.metadata,
            )
            self._emit("presence_join", actor_id, pdata)

        def _on_leave(actor: Any) -> None:
            actor_id = getattr(actor, "actor_token_id", None)
            if not actor_id:
                return
            self._agents.pop(actor_id, None)
            self._log(f"agent left room {self.name}:", actor_id)
            self._emit("presence_leave", actor_id)

        def _on_update(actor: Any) -> None:
            actor_id = getattr(actor, "actor_token_id", None)
            if not actor_id:
                return
            p = getattr(actor, "presence", {}) or {}
            existing = self._agents.get(actor_id)
            agent = ConnectedAgent(
                actor_id=actor_id,
                name=p.get("name") or (existing.name if existing else actor_id),
                role=p.get("role") or (existing.role if existing else "agent"),
                capabilities=p.get("capabilities") or (existing.capabilities if existing else []),
                metadata=p.get("metadata") or (existing.metadata if existing else None),
                connected_at=existing.connected_at if existing else 0,
            )
            self._agents[actor_id] = agent
            pdata = AgentPresenceData(
                name=agent.name,
                role=agent.role,
                capabilities=agent.capabilities,
                metadata=agent.metadata,
            )
            self._emit("presence_update", actor_id, pdata)

        self._client.on("presence:join", _on_join)
        self._client.on("presence:leave", _on_leave)
        self._client.on("presence:update", _on_update)

    def _wire_topic_listeners(self) -> None:
        # Topic subscriptions are done in initialize() (async)
        # Here we just wire the message handlers (sync .on() calls)
        simple_map = [
            (TOPIC_TASKS, "task"),
            (TOPIC_RESULTS, "result"),
            (TOPIC_STATE, "state_change"),
            (TOPIC_EVENTS, "event"),
            (TOPIC_INBOX, "inbox"),
        ]
        for topic, event_name in simple_map:
            self._room_context.on(topic, self._make_handler(topic, event_name))

        def _on_approval(data: Any, *_args: Any) -> None:
            self._log(f"received {TOPIC_APPROVAL} in room {self.name}")
            d = data if isinstance(data, dict) else {}
            if d.get("type") == "approval_response":
                self._emit("approval_response", data)
            else:
                self._emit("approval_request", data)

        def _on_tools(data: Any, *_args: Any) -> None:
            self._log(f"received {TOPIC_TOOLS} in room {self.name}")
            d = data if isinstance(data, dict) else {}
            if d.get("type") == "tool_response":
                self._emit("tool_response", data)
            else:
                self._emit("tool_request", data)

        self._room_context.on(TOPIC_APPROVAL, _on_approval)
        self._room_context.on(TOPIC_TOOLS, _on_tools)

    def _make_handler(self, topic: str, event_name: str) -> Callable[..., None]:
        def handler(data: Any, *_args: Any) -> None:
            self._log(f"received {topic} in room {self.name}")
            self._emit(event_name, data)
        return handler
