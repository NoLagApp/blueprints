"""Simple NoLag WebSocket Client"""

import asyncio
import logging
from typing import Any, Callable, Dict, Optional, Set
from dataclasses import dataclass

import msgpack
import websockets
from websockets.client import WebSocketClientProtocol

logger = logging.getLogger("nolag")


@dataclass
class NoLagOptions:
    """Connection options"""
    url: str = "wss://broker.nolag.app/ws"
    reconnect: bool = True
    reconnect_interval: float = 5.0
    debug: bool = False


class Room:
    """Room context for pub/sub"""

    def __init__(self, client: "NoLagClient", app_name: str, room_name: str):
        self._client = client
        self._app_name = app_name
        self._room_name = room_name

    @property
    def prefix(self) -> str:
        return f"{self._app_name}/{self._room_name}"

    def _full_topic(self, topic: str) -> str:
        return f"{self.prefix}/{topic}"

    async def subscribe(self, topic: str) -> None:
        await self._client.subscribe(self._full_topic(topic))

    async def emit(self, topic: str, data: Any) -> None:
        await self._client.emit(self._full_topic(topic), data)

    def on(self, topic: str, handler: Callable[[Any, Dict], None]) -> "Room":
        self._client.on(self._full_topic(topic), handler)
        return self


class App:
    """App context"""

    def __init__(self, client: "NoLagClient", app_name: str):
        self._client = client
        self._app_name = app_name

    def set_room(self, room_name: str) -> Room:
        return Room(self._client, self._app_name, room_name)


class NoLagClient:
    """Simple NoLag WebSocket client"""

    def __init__(self, token: str, options: Optional[NoLagOptions] = None):
        self._token = token
        self._options = options or NoLagOptions()
        self._ws: Optional[WebSocketClientProtocol] = None
        self._handlers: Dict[str, Set[Callable]] = {}
        self._event_handlers: Dict[str, Set[Callable]] = {}
        self._connected = False
        self._authenticated = False
        self._running = False
        self._auth_future: Optional[asyncio.Future] = None

    def set_app(self, app_name: str) -> App:
        return App(self, app_name)

    def on_event(self, event: str, handler: Callable) -> None:
        """Register event handler (connect, disconnect, etc.)"""
        if event not in self._event_handlers:
            self._event_handlers[event] = set()
        self._event_handlers[event].add(handler)

    def on(self, topic: str, handler: Callable[[Any, Dict], None]) -> None:
        """Register message handler for topic"""
        if topic not in self._handlers:
            self._handlers[topic] = set()
        self._handlers[topic].add(handler)
        if self._options.debug:
            logger.debug(f"Registered handler for topic: {topic}")

    async def connect(self) -> None:
        """Connect to broker"""
        self._running = True

        while self._running:
            try:
                if self._options.debug:
                    logger.debug(f"Connecting to {self._options.url}")

                self._ws = await websockets.connect(self._options.url)
                self._connected = True

                if self._options.debug:
                    logger.debug("WebSocket connected, authenticating...")

                # Authenticate
                await self._authenticate()

                # Fire connect event
                await self._fire_event("connect")

                if self._options.debug:
                    logger.debug("Connected and authenticated")

                # Start read loop
                await self._read_loop()

            except Exception as e:
                self._connected = False
                self._authenticated = False
                await self._fire_event("disconnect", str(e))

                if self._options.debug:
                    logger.debug(f"Connection error: {e}")

                if self._options.reconnect and self._running:
                    await self._fire_event("reconnect")
                    await asyncio.sleep(self._options.reconnect_interval)
                else:
                    break

    async def _authenticate(self) -> None:
        """Authenticate with the server"""
        self._auth_future = asyncio.get_event_loop().create_future()

        message = {
            "type": "auth",
            "token": self._token,
        }

        await self._send(message)

        # Wait for auth response
        try:
            await asyncio.wait_for(self._auth_future, timeout=10.0)
            self._authenticated = True
        except asyncio.TimeoutError:
            raise Exception("Authentication timeout")

    async def _read_loop(self) -> None:
        """Read messages from WebSocket"""
        try:
            async for message in self._ws:
                if isinstance(message, bytes):
                    await self._handle_message(message)
        except websockets.ConnectionClosed:
            pass
        except Exception as e:
            if self._options.debug:
                logger.debug(f"Read error: {e}")

    async def _handle_message(self, data: bytes) -> None:
        """Handle incoming message"""
        # Handle empty binary (heartbeat response)
        if len(data) == 0:
            if self._options.debug:
                logger.debug("Heartbeat pong received")
            return

        try:
            msg = msgpack.unpackb(data, raw=False)
        except Exception as e:
            logger.error(f"Failed to decode message: {e}")
            return

        if self._options.debug:
            logger.debug(f"Received: {msg}")

        msg_type = msg.get("type")

        # Handle auth response
        if msg_type == "auth" and self._auth_future and not self._auth_future.done():
            if msg.get("success"):
                if self._options.debug:
                    logger.debug(f"Auth successful: actorTokenId={msg.get('actorTokenId')}")
                self._auth_future.set_result(True)
            else:
                error = msg.get("error", "Authentication failed")
                self._auth_future.set_exception(Exception(error))
            return

        # Handle subscribed confirmation
        if msg_type == "subscribed":
            if self._options.debug:
                logger.debug(f"Subscribed to {msg.get('topic')}")
            return

        # Handle message
        if msg_type == "message":
            topic = msg.get("topic", "")
            payload = msg.get("data")
            meta = {"from": msg.get("from"), "timestamp": msg.get("timestamp")}

            if self._options.debug:
                logger.debug(f"Message on topic '{topic}': {payload}")
                logger.debug(f"Registered handlers for topics: {list(self._handlers.keys())}")

            # Call handlers
            handlers = self._handlers.get(topic, set())
            if self._options.debug:
                logger.debug(f"Found {len(handlers)} handlers for topic '{topic}'")

            for handler in handlers:
                try:
                    if asyncio.iscoroutinefunction(handler):
                        await handler(payload, meta)
                    else:
                        handler(payload, meta)
                except Exception as e:
                    logger.error(f"Handler error: {e}")
            return

        # Handle error
        if msg_type == "error":
            logger.error(f"Server error: {msg.get('message')}")
            return

    async def _send(self, message: dict) -> None:
        """Send a message to the server"""
        if not self._ws:
            return

        if self._options.debug:
            logger.debug(f"Sending: {message}")

        payload = msgpack.packb(message)
        await self._ws.send(payload)

    async def subscribe(self, topic: str) -> None:
        """Subscribe to topic"""
        if not self._ws or not self._authenticated:
            logger.warning(f"Cannot subscribe to {topic}: not connected/authenticated")
            return

        message = {"type": "subscribe", "topic": topic}
        await self._send(message)

        if self._options.debug:
            logger.debug(f"Subscribing to {topic}")

    async def emit(self, topic: str, data: Any) -> None:
        """Emit to topic"""
        if not self._ws or not self._authenticated:
            logger.warning(f"Cannot emit to {topic}: not connected/authenticated")
            return

        message = {"type": "publish", "topic": topic, "data": data}
        await self._send(message)

        if self._options.debug:
            logger.debug(f"Emitting to {topic}: {data}")

    async def _fire_event(self, event: str, *args) -> None:
        """Fire event handlers"""
        handlers = self._event_handlers.get(event, set())
        for handler in handlers:
            try:
                if asyncio.iscoroutinefunction(handler):
                    await handler(*args)
                else:
                    handler(*args)
            except Exception as e:
                logger.error(f"Event handler error: {e}")

    async def disconnect(self) -> None:
        """Disconnect from broker"""
        self._running = False
        if self._ws:
            await self._ws.close()
            self._ws = None
        self._connected = False
        self._authenticated = False

    @property
    def connected(self) -> bool:
        return self._connected and self._authenticated
