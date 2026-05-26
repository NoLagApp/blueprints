from __future__ import annotations

import time
from typing import Any

from nolag import NoLag as NoLagClient

from .event_emitter import EventEmitter
from .agent_room import AgentRoom
from .utils import generate_id, create_logger
from .constants import DEFAULT_APP_NAME, DEFAULT_ROOM
from .types import NoLagAgentsOptions, AgentPresenceData


class NoLagAgents(EventEmitter):
    """High-level agent coordination SDK built on the nolag Python SDK.

    Provides typed rooms for multi-agent patterns: Handoff, Blackboard,
    Inbox, Tools, Approval, and Observe.
    """

    def __init__(self, token: str, options: NoLagAgentsOptions | None = None) -> None:
        super().__init__()
        opts = options or NoLagAgentsOptions()
        self._token = token
        self._app_name = opts.app_name or DEFAULT_APP_NAME
        self._agent_id = opts.agent_id or generate_id()
        self._debug = opts.debug
        self._room_names = opts.rooms or [DEFAULT_ROOM]
        self._lobby = opts.lobby
        self._presence = opts.presence
        self._client_options = opts.client_options or {}
        self._load_balance = opts.load_balance
        self._load_balance_group = opts.load_balance_group
        self._load_balance_topics = opts.load_balance_topics

        self._client: Any = None
        self._app_context: Any = None
        self._rooms: dict[str, AgentRoom] = {}
        self._connected = False
        self._log = create_logger("NoLagAgents", self._debug)

    @property
    def agent_id(self) -> str:
        return self._agent_id

    @property
    def connected(self) -> bool:
        return self._connected

    @property
    def rooms(self) -> dict[str, AgentRoom]:
        return dict(self._rooms)

    async def connect(self) -> None:
        self._log("connecting...")

        self._client = NoLagClient(self._token, **self._client_options)

        self._app_context = self._client.set_app(self._app_name)

        self._client.on("connect", self._on_connected)
        self._client.on("disconnect", self._on_disconnected)
        self._client.on("reconnect", self._on_reconnected)
        self._client.on("error", self._on_error)

        await self._client.connect()

        for room_name in self._room_names:
            await self.room(room_name)

        if self._lobby:
            await self.subscribe_lobby(self._lobby)

    async def subscribe_lobby(self, lobby_slug: str) -> dict[str, Any]:
        if not self._app_context:
            raise RuntimeError("Not connected. Call connect() before subscribing to lobbies.")

        self._log(f"subscribing to lobby: {lobby_slug}")
        lobby = self._app_context.set_lobby(lobby_slug)

        def _on_lobby_join(evt: Any) -> None:
            d = evt if isinstance(evt, dict) else {}
            actor_id = d.get("actor_id")
            data = d.get("data", {})
            if actor_id:
                self._log(f"lobby presence:join - {data.get('name', actor_id)}")
                for rm in self._rooms.values():
                    if actor_id not in rm._agents:
                        from .types import ConnectedAgent
                        rm._agents[actor_id] = ConnectedAgent(
                            actor_id=actor_id,
                            name=data.get("name", actor_id),
                            role=data.get("role", "agent"),
                            capabilities=data.get("capabilities", []),
                            metadata=data.get("metadata"),
                            connected_at=int(time.time() * 1000),
                        )
                    pdata = AgentPresenceData(
                        name=data.get("name", actor_id),
                        role=data.get("role", "agent"),
                        capabilities=data.get("capabilities", []),
                        metadata=data.get("metadata"),
                    )
                    rm.emit_presence("presence_join", actor_id, pdata)

        def _on_lobby_leave(evt: Any) -> None:
            d = evt if isinstance(evt, dict) else {}
            actor_id = d.get("actor_id")
            if actor_id:
                self._log(f"lobby presence:leave - {actor_id}")
                for rm in self._rooms.values():
                    rm._agents.pop(actor_id, None)
                    rm.emit_presence("presence_leave", actor_id)

        def _on_lobby_update(evt: Any) -> None:
            d = evt if isinstance(evt, dict) else {}
            actor_id = d.get("actor_id")
            data = d.get("data", {})
            if actor_id:
                for rm in self._rooms.values():
                    existing = rm._agents.get(actor_id)
                    if existing:
                        if data.get("name"):
                            existing.name = data["name"]
                        if data.get("role"):
                            existing.role = data["role"]
                        if data.get("capabilities"):
                            existing.capabilities = data["capabilities"]
                        if data.get("metadata"):
                            existing.metadata = data["metadata"]
                    pdata = AgentPresenceData(
                        name=data.get("name", ""),
                        role=data.get("role", "agent"),
                        capabilities=data.get("capabilities", []),
                        metadata=data.get("metadata"),
                    )
                    rm.emit_presence("presence_update", actor_id, pdata)

        self._client.on("lobbyPresence:join", _on_lobby_join)
        self._client.on("lobbyPresence:leave", _on_lobby_leave)
        self._client.on("lobbyPresence:update", _on_lobby_update)

        try:
            initial_state = await lobby.subscribe()
            self._log(f"lobby subscribed, initial state: {list((initial_state or {}).keys())}")
            return initial_state or {}
        except Exception as err:
            self._log(f"lobby subscription failed: {err}")
            return {}

    def disconnect(self) -> None:
        self._log("disconnecting...")
        if self._client:
            self._client.disconnect()
        self._rooms.clear()
        self._client = None
        self._app_context = None
        self._connected = False

    async def room(self, name: str) -> AgentRoom:
        agent_room = self._rooms.get(name)
        if agent_room:
            return agent_room

        if not self._app_context:
            raise RuntimeError("Not connected. Call connect() before accessing rooms.")

        self._log(f"joining room: {name}")
        room_context = self._app_context.set_room(name)
        agent_room = AgentRoom(
            name=name,
            room_context=room_context,
            client=self._client,
            log=self._log,
            agent_id=self._agent_id,
            presence=self._presence,
            load_balance=self._load_balance,
            load_balance_group=self._load_balance_group,
            load_balance_topics=self._load_balance_topics,
        )
        await agent_room.initialize()
        self._rooms[name] = agent_room
        return agent_room

    # ── Internal event handlers ──

    def _on_connected(self, *_args: Any) -> None:
        self._connected = True
        self._log("connected")
        self._emit("connected")

    def _on_disconnected(self, *args: Any) -> None:
        self._connected = False
        reason = args[0] if args else "unknown"
        self._log("disconnected:", reason)
        self._emit("disconnected", reason)

    def _on_reconnected(self, *_args: Any) -> None:
        self._connected = True
        self._log("reconnected")
        self._emit("reconnected")

    def _on_error(self, *args: Any) -> None:
        err = args[0] if args else Exception("unknown error")
        self._log("error:", err)
        self._emit("error", err)
