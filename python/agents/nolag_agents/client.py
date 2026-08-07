from __future__ import annotations

import asyncio
import time
from typing import Any

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

    def __init__(self, client: Any, options: NoLagAgentsOptions | None = None) -> None:
        """Attach to an injected NoLag client.

        The application owns the connection: it creates the client, connects it,
        and disconnects it. This wrapper only attaches, so one connection can be
        shared by several wrappers.

            client = NoLag(token)
            await client.connect()
            agents = NoLagAgents(client, NoLagAgentsOptions(rooms=["workflow"]))
            await agents.ready()
            ...
            await agents.detach()   # leaves the connection open
        """
        super().__init__()
        if client is None:
            raise TypeError(
                "NoLagAgents requires an injected NoLag client: "
                "NoLagAgents(client, options). Create and connect the client yourself."
            )
        opts = options or NoLagAgentsOptions()
        self._client: Any = client
        self._app_name = opts.app_name or DEFAULT_APP_NAME
        self._agent_id = opts.agent_id or generate_id()
        self._debug = opts.debug
        self._room_names = opts.rooms or [DEFAULT_ROOM]
        self._lobby = opts.lobby
        self._presence = opts.presence
        self._load_balance = opts.load_balance
        self._load_balance_group = opts.load_balance_group
        self._load_balance_topics = opts.load_balance_topics

        self._app_context: Any = self._client.set_app(self._app_name)
        self._rooms: dict[str, AgentRoom] = {}
        self._connected = False
        self._log = create_logger("NoLagAgents", self._debug)

        self._detached = False
        self._epoch = 0
        self._is_ready = False
        self._ready_event = asyncio.Event()
        self._ready_error: BaseException | None = None
        self._setup_task: asyncio.Task | None = None
        self._lobby_handlers: list[tuple[str, Any]] = []

        # Construction = attach. Handlers are stored so detach() can remove
        # exactly ours and leave any sibling wrapper on this client untouched.
        self._on_connect_ref = self._on_connected
        self._on_disconnect_ref = self._on_disconnected
        self._on_reconnect_ref = self._on_reconnected
        self._on_error_ref = self._on_error
        self._client.on("connect", self._on_connect_ref)
        self._client.on("disconnect", self._on_disconnect_ref)
        self._client.on("reconnect", self._on_reconnect_ref)
        self._client.on("error", self._on_error_ref)

        # Attach-to-connected: the client may already be up.
        if getattr(self._client, "connected", False):
            self._schedule_setup()

    @property
    def agent_id(self) -> str:
        return self._agent_id

    @property
    def connected(self) -> bool:
        """Whether the injected client is connected and this wrapper is attached."""
        if self._detached:
            return False
        return bool(getattr(self._client, "connected", self._connected))

    @property
    def detached(self) -> bool:
        return self._detached

    @property
    def client(self) -> Any:
        """The injected client, owned by the application, not this wrapper."""
        return self._client

    @property
    def rooms(self) -> dict[str, AgentRoom]:
        return dict(self._rooms)

    async def ready(self) -> None:
        """Wait until wrapper setup completes.

        Resolves once the configured rooms are joined and the lobby, if any, is
        subscribed. Raises RuntimeError if detach() happened first. Safe to await
        more than once and after setup has already finished.
        """
        if self._detached and not self._is_ready:
            raise RuntimeError("NoLagAgents detached before ready")
        if (
            not self._is_ready
            and self._setup_task is None
            and getattr(self._client, "connected", False)
        ):
            self._schedule_setup()
        await self._ready_event.wait()
        if self._ready_error is not None:
            raise self._ready_error

    def _schedule_setup(self) -> None:
        """Kick a setup pass. Event handlers are sync, so setup runs as a task."""
        if self._detached:
            return
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            # Constructed outside a running loop; ready() will start setup.
            return
        self._epoch += 1
        self._setup_task = loop.create_task(self._run_setup(self._epoch))

    def _stale(self, epoch: int) -> bool:
        return self._detached or epoch != self._epoch

    async def _run_setup(self, epoch: int) -> None:
        """Join configured rooms and subscribe the lobby.

        Runs on every connect, so a reconnect re-establishes subscriptions. The
        epoch guard stops a superseded pass from completing over a newer one.
        """
        try:
            for room_name in self._room_names:
                if self._stale(epoch):
                    return
                await self.room(room_name)

            if self._lobby:
                if self._stale(epoch):
                    return
                await self.subscribe_lobby(self._lobby)
        except Exception as err:  # noqa: BLE001 - surfaced to the caller
            if self._stale(epoch):
                return
            self._log(f"setup failed: {err}")
            if not self._is_ready:
                self._ready_error = err
                self._ready_event.set()
            self._emit("error", err)
            return

        if self._stale(epoch):
            return

        was_ready = self._is_ready
        self._is_ready = True
        if not was_ready:
            self._ready_event.set()
            self._emit("connected")
        else:
            self._emit("reconnected")

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

        for event, handler in (
            ("lobbyPresence:join", _on_lobby_join),
            ("lobbyPresence:leave", _on_lobby_leave),
            ("lobbyPresence:update", _on_lobby_update),
        ):
            self._client.on(event, handler)
            self._lobby_handlers.append((event, handler))

        try:
            initial_state = await lobby.subscribe()
            self._log(f"lobby subscribed, initial state: {list((initial_state or {}).keys())}")
            return initial_state or {}
        except Exception as err:
            self._log(f"lobby subscription failed: {err}")
            return {}

    async def detach(self) -> None:
        """Release the wrapper. Terminal and idempotent.

        Removes this wrapper's handlers, tears down its rooms, and never
        disconnects the injected client, so any sibling wrapper sharing that
        connection keeps working.
        """
        if self._detached:
            return
        self._detached = True
        self._epoch += 1  # invalidate any setup still in flight
        self._log("detaching...")

        # Remove exactly our handlers; the core SDK supports per-handler removal.
        self._client.off("connect", self._on_connect_ref)
        self._client.off("disconnect", self._on_disconnect_ref)
        self._client.off("reconnect", self._on_reconnect_ref)
        self._client.off("error", self._on_error_ref)
        for event, handler in self._lobby_handlers:
            self._client.off(event, handler)
        self._lobby_handlers.clear()

        connected = bool(getattr(self._client, "connected", False))
        for room in list(self._rooms.values()):
            try:
                await room.teardown(connected)
            except Exception as err:  # noqa: BLE001 - teardown is best-effort
                self._log(f"room teardown failed: {err}")
        self._rooms.clear()

        self._connected = False
        if not self._is_ready:
            self._ready_error = RuntimeError("NoLagAgents detached before ready")
            self._ready_event.set()
        self._emit("detached")

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
        if self._detached:
            return
        self._connected = True
        self._log("connected")
        self._schedule_setup()

    def _on_disconnected(self, *args: Any) -> None:
        if self._detached:
            return
        self._connected = False
        reason = args[0] if args else "unknown"
        self._log("disconnected:", reason)
        self._emit("disconnected", reason)

    def _on_reconnected(self, *_args: Any) -> None:
        if self._detached:
            return
        self._connected = True
        self._log("reconnected")
        self._schedule_setup()

    def _on_error(self, *args: Any) -> None:
        if self._detached:
            return
        err = args[0] if args else Exception("unknown error")
        self._log("error:", err)
        self._emit("error", err)
