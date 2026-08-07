from __future__ import annotations

import asyncio
import time
import uuid
from typing import Any, Callable

from .constants import DEFAULT_APP_NAME, LOBBY_ID
from .event_emitter import EventEmitter
from .signal_room import SignalRoom
from .types import NoLagSignalOptions, Peer

try:
    from nolag import NoLag, NoLagOptions

    # Patch nolag client to copy handler sets before iterating,
    # preventing "Set changed size during iteration" errors.
    # The nolag client uses `set()` for handler storage and iterates
    # without copying in _emit_event, _handle_message (topic + any handlers).

    class _SafeSet(set):
        """A set that yields a snapshot when iterated, safe against concurrent mutation."""

        def __iter__(self):
            return iter(list(set.__iter__(self)))

    def _patched_on(self: Any, event: str, handler: Callable) -> Any:
        if (event in ("connect", "disconnect", "reconnect", "error",
                      "presence:join", "presence:leave", "presence:update")
                or event.startswith("lobby:") or event.startswith("lobbyPresence:")
                or event.startswith("lobbySubscribed:") or event.startswith("lobbyPresenceList:")):
            if event not in self._event_handlers:
                self._event_handlers[event] = _SafeSet()
            self._event_handlers[event].add(handler)
        else:
            if event not in self._message_handlers:
                self._message_handlers[event] = _SafeSet()
            self._message_handlers[event].add(handler)
        return self

    NoLag.on = _patched_on  # type: ignore[assignment]

    # Also patch __init__ to use _SafeSet for _any_handlers
    _original_init = NoLag.__init__

    def _patched_init(self: Any, *args: Any, **kwargs: Any) -> None:
        _original_init(self, *args, **kwargs)
        self._any_handlers = _SafeSet(self._any_handlers)

    NoLag.__init__ = _patched_init  # type: ignore[assignment]

except ImportError:
    NoLag = None  # type: ignore[assignment,misc]
    NoLagOptions = None  # type: ignore[assignment,misc]


def _create_logger(prefix: str, enabled: bool) -> Callable[..., None]:
    if not enabled:
        return lambda *a, **kw: None

    def _log(*args: Any) -> None:
        print(f"[{prefix}]", *args)

    return _log


class NoLagSignal(EventEmitter):
    """
    Main signaling client — manages connection, rooms, and global presence.

    Events:
        connected() — Connection established
        disconnected(reason: str) — Connection lost
        reconnected() — Reconnected after disconnect
        error(error: Exception) — Connection error
        peer_online(peer: Peer) — Peer came online (global)
        peer_offline(peer: Peer) — Peer went offline (global)
    """

    def __init__(self, client: Any, options: NoLagSignalOptions | None = None) -> None:
        """Attach to an injected NoLag client.

        The application owns the connection: it creates the client, connects it,
        and disconnects it. This wrapper only attaches, so one connection can be
        shared by several wrappers.

            client = NoLag(token)
            await client.connect()
            signal = NoLagSignal(client)
            await signal.ready()
            ...
            await signal.detach()   # leaves the connection open
        """
        super().__init__()
        if client is None:
            raise TypeError(
                "NoLagSignal requires an injected NoLag client: "
                "NoLagSignal(client, options). Create and connect the client yourself."
            )
        self._options = options or NoLagSignalOptions()
        self._peer_id = str(uuid.uuid4())
        self._log = _create_logger("NoLagSignal", self._options.debug)

        self._client: Any = client
        self._local_peer: Peer | None = None
        self._rooms: dict[str, SignalRoom] = {}
        self._online_peers: dict[str, Peer] = {}  # peerId -> Peer
        self._actor_to_peer_id: dict[str, str] = {}  # actorTokenId -> peerId
        self._lobby: Any = None
        self._connected = False

        self._detached = False
        self._is_ready = False
        self._ready_event = asyncio.Event()
        self._ready_error: BaseException | None = None
        self._setup_task: Any = None

        # Construction = attach. Stored refs so detach() removes exactly ours and
        # leaves any sibling wrapper on this client untouched.
        self._client_handlers: list[tuple[str, Any]] = [
            ("connect", self._on_connect),
            ("disconnect", self._on_disconnect),
            ("reconnect", self._on_reconnect),
            ("error", self._on_error),
            ("presence:join", self._handle_room_presence_join),
            ("presence:leave", self._handle_room_presence_leave),
            ("presence:update", self._handle_room_presence_update),
        ]
        for event, handler in self._client_handlers:
            self._client.on(event, handler)

        if getattr(self._client, "connected", False):
            self._schedule_setup()

    # -- Public properties --

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
    def local_peer(self) -> Peer | None:
        return self._local_peer

    @property
    def rooms(self) -> dict[str, SignalRoom]:
        return dict(self._rooms)

    # -- Public methods --

    async def ready(self) -> None:
        """Wait until wrapper setup completes.

        Resolves once the local peer is established and the lobby is subscribed.
        Raises RuntimeError if detach() happened first. Safe to await repeatedly.
        """
        if self._detached and not self._is_ready:
            raise RuntimeError("NoLagSignal detached before ready")
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
        """Kick a setup pass. Client events are sync, so setup runs as a task."""
        if self._detached:
            return
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            # Constructed outside a running loop; ready() will start setup.
            return
        self._setup_task = loop.create_task(self._run_setup())

    async def _run_setup(self) -> None:
        try:
            await self._setup()
        except Exception as err:  # noqa: BLE001 - surfaced through ready()
            if self._detached:
                return
            self._log(f"setup failed: {err}")
            if not self._is_ready:
                self._ready_error = err
                self._ready_event.set()
            self.emit("error", err)

    async def _setup(self) -> None:
        """Establish the local peer and subscribe the lobby."""
        if self._detached:
            return

        app_name = self._options.app_name or DEFAULT_APP_NAME

        # Create local peer
        self._local_peer = Peer(
            peer_id=self._peer_id,
            actor_token_id=self._client.actor_id or "",
            connection_state="connected",
            metadata=self._options.metadata,
            joined_at=time.time(),
            is_local=True,
        )
        self._log(f"Local peer: {self._peer_id[:8]} (actor: {self._local_peer.actor_token_id})")

        # Set up lobby for global presence tracking
        app = self._client.set_app(app_name)
        self._lobby = app.set_lobby(LOBBY_ID)

        # Wire lobby presence events
        self._lobby.on("presence:join", self._handle_lobby_join)
        self._lobby.on("presence:leave", self._handle_lobby_leave)
        self._lobby.on("presence:update", self._handle_lobby_update)

        # Subscribe to lobby and hydrate online peers
        state = await self._lobby.subscribe()
        self._hydrate_online_peers(state)

        self._connected = True
        was_ready = self._is_ready
        self._is_ready = True
        if not was_ready:
            self._ready_event.set()
            self.emit("connected")
        else:
            self.emit("reconnected")

        # Deferred refetch after 2s to catch peers who joined during setup.
        # get_running_loop, since Python 3.12 no longer provides an implicit loop.
        asyncio.get_running_loop().call_later(
            2.0, lambda: asyncio.ensure_future(self._deferred_refetch())
        )

    async def detach(self) -> None:
        """Release the wrapper. Terminal and idempotent.

        Removes this wrapper's handlers, leaves its rooms, and unsubscribes its
        lobby. It never disconnects the injected client, so any sibling wrapper
        sharing that connection keeps working.
        """
        if self._detached:
            return
        self._detached = True
        self._log("detaching...")

        off = getattr(self._client, "off", None)
        if callable(off):
            for event, handler in self._client_handlers:
                off(event, handler)
        self._client_handlers.clear()

        for name in list(self._rooms.keys()):
            try:
                await self._leave_room_async(name)
            except Exception as err:  # noqa: BLE001 - teardown is best-effort
                self._log(f"leave room {name} failed: {err}")

        if self._lobby:
            try:
                self._lobby.unsubscribe()
            except Exception as err:  # noqa: BLE001 - teardown is best-effort
                self._log(f"lobby unsubscribe failed: {err}")
            self._lobby = None

        self._rooms.clear()
        self._online_peers.clear()
        self._actor_to_peer_id.clear()
        self._local_peer = None
        self._connected = False

        if not self._is_ready:
            self._ready_error = RuntimeError("NoLagSignal detached before ready")
            self._ready_event.set()
        self.emit("detached")
        self._connected = False

    async def join_room(self, name: str) -> SignalRoom:
        """Join a signaling room. Returns existing room if already joined."""
        if not self._connected or not self._client:
            raise RuntimeError("Not connected. Call connect() first.")

        if name in self._rooms:
            return self._rooms[name]

        room = await self._subscribe_room(name)
        await room._activate(self._client)
        self._rooms[name] = room
        self._log(f"Joined room: {name}")
        return room

    async def leave_room(self, name: str) -> None:
        """Leave a signaling room."""
        room = self._rooms.pop(name, None)
        if room:
            await room._cleanup()
            self._log(f"Left room: {name}")

    def get_rooms(self) -> list[SignalRoom]:
        return list(self._rooms.values())

    def get_online_peers(self) -> list[Peer]:
        return list(self._online_peers.values())

    # -- Private: room setup --

    async def _subscribe_room(self, name: str) -> SignalRoom:
        app_name = self._options.app_name or DEFAULT_APP_NAME
        app = self._client.set_app(app_name)
        room_context = app.set_room(name)

        room = SignalRoom(
            name=name,
            room_context=room_context,
            local_peer=self._local_peer,  # type: ignore[arg-type]
            options=self._options,
            log=self._log,
        )
        await room._subscribe()
        return room

    async def _leave_room_async(self, name: str) -> None:
        room = self._rooms.pop(name, None)
        if room:
            await room._cleanup()

    # -- Private: lifecycle event handlers --

    def _on_connect(self, *args: Any) -> None:
        if self._detached:
            return
        self._log("Connected")
        # With an injected client the wrapper does not drive the connection, so
        # this is where setup starts (including after a reconnect).
        if not self._is_ready:
            self._schedule_setup()

    def _on_disconnect(self, *args: Any) -> None:
        if self._detached:
            return
        self._connected = False
        reason = args[0] if args else "unknown"
        self._log(f"Disconnected: {reason}")
        self.emit("disconnected", str(reason))

    def _on_reconnect(self, *args: Any) -> None:
        if self._detached:
            return
        self._connected = True
        self._log("Reconnected")
        self.emit("reconnected")
        asyncio.ensure_future(self._restore_rooms())

    def _on_error(self, *args: Any) -> None:
        if self._detached:
            return
        error = args[0] if args else Exception("Unknown error")
        if not isinstance(error, Exception):
            error = Exception(str(error))
        self._log(f"Error: {error}")
        self.emit("error", error)

    # -- Private: room-level presence --

    def _handle_room_presence_join(self, data: Any) -> None:
        actor_id = data.actor_token_id if hasattr(data, "actor_token_id") else data.get("actor_token_id", "") if isinstance(data, dict) else ""
        presence = data.presence if hasattr(data, "presence") else data.get("presence", {}) if isinstance(data, dict) else {}
        if not actor_id or actor_id == (self._local_peer.actor_token_id if self._local_peer else ""):
            return

        peer_id = presence.get("peerId", actor_id)
        if peer_id not in self._online_peers:
            peer = self._presence_to_peer(actor_id, presence)
            self._online_peers[peer_id] = peer
            self._actor_to_peer_id[actor_id] = peer_id
            self.emit("peer_online", peer)

        for room in self._rooms.values():
            room._handle_presence_join(actor_id, presence)

    def _handle_room_presence_leave(self, data: Any) -> None:
        actor_id = data.actor_token_id if hasattr(data, "actor_token_id") else data.get("actor_token_id", "") if isinstance(data, dict) else ""
        if not actor_id:
            return

        for room in self._rooms.values():
            room._handle_presence_leave(actor_id)

    def _handle_room_presence_update(self, data: Any) -> None:
        actor_id = data.actor_token_id if hasattr(data, "actor_token_id") else data.get("actor_token_id", "") if isinstance(data, dict) else ""
        presence = data.presence if hasattr(data, "presence") else data.get("presence", {}) if isinstance(data, dict) else {}
        if not actor_id:
            return

        peer_id = self._actor_to_peer_id.get(actor_id)
        if peer_id and peer_id in self._online_peers:
            peer = self._presence_to_peer(actor_id, presence)
            self._online_peers[peer_id] = peer

        for room in self._rooms.values():
            room._handle_presence_update(actor_id, presence)

    # -- Private: lobby presence --

    def _handle_lobby_join(self, event: Any) -> None:
        actor_id = event.actor_id if hasattr(event, "actor_id") else ""
        presence = event.data if hasattr(event, "data") else {}
        if not actor_id or actor_id == (self._local_peer.actor_token_id if self._local_peer else ""):
            return

        peer_id = presence.get("peerId", actor_id)
        if peer_id not in self._online_peers:
            peer = self._presence_to_peer(actor_id, presence)
            self._online_peers[peer_id] = peer
            self._actor_to_peer_id[actor_id] = peer_id
            self._log(f"Peer online (lobby): {peer_id[:8]}")
            self.emit("peer_online", peer)

        for room in self._rooms.values():
            room._handle_presence_join(actor_id, presence)

    def _handle_lobby_leave(self, event: Any) -> None:
        actor_id = event.actor_id if hasattr(event, "actor_id") else ""
        if not actor_id:
            return

        peer_id = self._actor_to_peer_id.pop(actor_id, None)
        if peer_id:
            peer = self._online_peers.pop(peer_id, None)
            if peer:
                self._log(f"Peer offline (lobby): {peer_id[:8]}")
                self.emit("peer_offline", peer)

        for room in self._rooms.values():
            room._handle_presence_leave(actor_id)

    def _handle_lobby_update(self, event: Any) -> None:
        actor_id = event.actor_id if hasattr(event, "actor_id") else ""
        presence = event.data if hasattr(event, "data") else {}
        if not actor_id:
            return

        peer_id = self._actor_to_peer_id.get(actor_id)
        if peer_id and peer_id in self._online_peers:
            peer = self._presence_to_peer(actor_id, presence)
            self._online_peers[peer_id] = peer

    # -- Private: helpers --

    def _hydrate_online_peers(self, state: dict[str, dict[str, dict[str, Any]]]) -> None:
        """Process lobby presence state: {roomId: {actorId: presenceData}}"""
        if not state:
            return
        for room_id, actors in state.items():
            for actor_id, presence_data in actors.items():
                if actor_id == (self._local_peer.actor_token_id if self._local_peer else ""):
                    continue
                peer_id = presence_data.get("peerId", actor_id)
                if peer_id not in self._online_peers:
                    peer = self._presence_to_peer(actor_id, presence_data)
                    self._online_peers[peer_id] = peer
                    self._actor_to_peer_id[actor_id] = peer_id
                    self._log(f"Hydrated peer: {peer_id[:8]}")
                    self.emit("peer_online", peer)

    def _presence_to_peer(self, actor_token_id: str, data: dict[str, Any]) -> Peer:
        return Peer(
            peer_id=data.get("peerId", actor_token_id),
            actor_token_id=actor_token_id,
            connection_state="new",
            metadata=data.get("metadata"),
            joined_at=time.time(),
            is_local=False,
        )

    async def _deferred_refetch(self) -> None:
        """Re-fetch lobby presence after a delay to catch peers who joined during setup."""
        try:
            if self._lobby and self._connected:
                state = await self._lobby.fetch_presence()
                self._hydrate_online_peers(state)
        except Exception as e:
            self._log(f"Deferred refetch failed: {e}")

    async def _restore_rooms(self) -> None:
        """Re-set presence in all rooms after reconnect."""
        if not self._client:
            return
        for room in self._rooms.values():
            await room._update_local_presence(self._client)
        try:
            if self._lobby:
                state = await self._lobby.fetch_presence()
                self._hydrate_online_peers(state)
        except Exception as e:
            self._log(f"Room restore failed: {e}")
