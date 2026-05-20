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

    def __init__(self, token: str, options: NoLagSignalOptions | None = None) -> None:
        super().__init__()
        self._token = token
        self._options = options or NoLagSignalOptions()
        self._peer_id = str(uuid.uuid4())
        self._log = _create_logger("NoLagSignal", self._options.debug)

        self._client: Any = None
        self._local_peer: Peer | None = None
        self._rooms: dict[str, SignalRoom] = {}
        self._online_peers: dict[str, Peer] = {}  # peerId -> Peer
        self._actor_to_peer_id: dict[str, str] = {}  # actorTokenId -> peerId
        self._lobby: Any = None
        self._connected = False

    # -- Public properties --

    @property
    def connected(self) -> bool:
        return self._connected

    @property
    def local_peer(self) -> Peer | None:
        return self._local_peer

    @property
    def rooms(self) -> dict[str, SignalRoom]:
        return dict(self._rooms)

    # -- Public methods --

    async def connect(self) -> None:
        """Connect to NoLag and set up lobby for global presence."""
        if NoLag is None:
            raise ImportError("nolag package is required: pip install nolag>=2.0.0")

        app_name = self._options.app_name or DEFAULT_APP_NAME

        client_options = NoLagOptions(
            debug=self._options.debug,
            reconnect=self._options.reconnect,
        )
        if self._options.url:
            client_options.url = self._options.url

        self._client = NoLag(self._token, client_options)

        # Wire lifecycle events
        self._client.on("connect", self._on_connect)
        self._client.on("disconnect", self._on_disconnect)
        self._client.on("reconnect", self._on_reconnect)
        self._client.on("error", self._on_error)

        # Wire presence events (room-level)
        self._client.on("presence:join", self._handle_room_presence_join)
        self._client.on("presence:leave", self._handle_room_presence_leave)
        self._client.on("presence:update", self._handle_room_presence_update)

        # Connect
        await self._client.connect()

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
        self.emit("connected")

        # Deferred refetch after 2s to catch peers who joined during setup
        asyncio.get_event_loop().call_later(2.0, lambda: asyncio.ensure_future(self._deferred_refetch()))

    def disconnect(self) -> None:
        """Clean up rooms, lobby, and client connection."""
        for name in list(self._rooms.keys()):
            asyncio.ensure_future(self._leave_room_async(name))

        if self._lobby:
            self._lobby.unsubscribe()
            self._lobby = None

        if self._client:
            self._client.disconnect()
            self._client = None

        self._rooms.clear()
        self._online_peers.clear()
        self._actor_to_peer_id.clear()
        self._local_peer = None
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
        self._log("Connected")

    def _on_disconnect(self, *args: Any) -> None:
        self._connected = False
        reason = args[0] if args else "unknown"
        self._log(f"Disconnected: {reason}")
        self.emit("disconnected", str(reason))

    def _on_reconnect(self, *args: Any) -> None:
        self._connected = True
        self._log("Reconnected")
        self.emit("reconnected")
        asyncio.ensure_future(self._restore_rooms())

    def _on_error(self, *args: Any) -> None:
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
