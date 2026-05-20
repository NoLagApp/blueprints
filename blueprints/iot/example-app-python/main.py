#!/usr/bin/env python3
"""
Simple IoT device simulator using the nolag Python SDK directly.

Validates basic pub/sub, presence, and message exchange with the JS IoT example app.

Usage:
    # Device mode — sends telemetry, receives commands
    python main.py --token YOUR_TOKEN --app YOUR_APP --role device --name TempSensor1

    # Controller mode — receives telemetry, sends commands
    python main.py --token YOUR_TOKEN --app YOUR_APP --role controller --name Dashboard
"""

from __future__ import annotations

import argparse
import asyncio
import json
import random
import time
import uuid
from typing import Any

from nolag import NoLag, NoLagOptions, EmitOptions


ROOM = "factory-floor"
TOPIC_TELEMETRY = "telemetry"
TOPIC_COMMANDS = "commands"
TOPIC_CMD_ACK = "_cmd_ack"


class IoTDevice:
    def __init__(self, args: argparse.Namespace) -> None:
        self.args = args
        self.device_id = str(uuid.uuid4())[:8]
        self.client: NoLag | None = None
        self.room = None
        self.running = True

    async def start(self) -> None:
        opts = NoLagOptions(
            url=self.args.url,
            debug=self.args.debug,
            reconnect=True,
        )
        self.client = NoLag(self.args.token, opts)

        self.client.on("connect", lambda *a: print("Connected!"))
        self.client.on("disconnect", lambda *a: print(f"Disconnected: {a}"))
        self.client.on("reconnect", lambda *a: print("Reconnected!"))
        # Intercept raw messages to see error details from broker
        _orig_handle = self.client._handle_message.__func__ if hasattr(self.client._handle_message, '__func__') else None
        _client_ref = self.client
        async def _debug_handle(data: bytes):
            import msgpack
            try:
                msg = msgpack.unpackb(data, raw=False) if data else None
                if isinstance(msg, dict) and msg.get("type") == "error":
                    print(f"BROKER ERROR: {msg}")
            except Exception:
                pass
            return await type(_client_ref)._handle_message(_client_ref, data)
        self.client._handle_message = _debug_handle

        def _on_error(*a):
            for arg in a:
                print(f"Error: {repr(arg)}")
        self.client.on("error", _on_error)

        # Presence events
        self.client.on("presence:join", lambda data: self._on_presence("JOIN", data))
        self.client.on("presence:leave", lambda data: self._on_presence("LEAVE", data))

        print(f"Connecting as {self.args.role} '{self.args.name}' (id: {self.device_id})...")
        await self.client.connect()
        print(f"Actor ID: {self.client.actor_id}")

        # Set presence at connection level
        await self.client.set_presence({
            "deviceId": self.device_id,
            "deviceName": self.args.name,
            "role": self.args.role,
        })
        print(f"Presence set.")

        # Set up room and lobby
        app = self.client.set_app(self.args.app)
        self.room = app.set_room(ROOM)

        # Subscribe to lobby for global device presence (required for JS app interop)
        self.lobby = app.set_lobby("online")
        self.lobby.on("presence:join", lambda e: print(f"  [lobby:join] {e.data.get('deviceName', '?')} ({e.actor_id[:8]})"))
        self.lobby.on("presence:leave", lambda e: print(f"  [lobby:leave] {e.actor_id[:8]}"))
        state = await self.lobby.subscribe()
        print(f"Lobby subscribed. Online devices: {sum(len(actors) for actors in state.values())}")

        if self.args.role == "device":
            await self._run_device()
        else:
            await self._run_controller()

    async def _run_device(self) -> None:
        """Device: send telemetry, listen for commands."""
        # Subscribe to commands filtered by our device ID
        await self.room.subscribe(TOPIC_COMMANDS)
        self.room.on(TOPIC_COMMANDS, self._on_command)
        print(f"Subscribed to commands on {ROOM}")

        # Also subscribe to telemetry to see our own + others
        await self.room.subscribe(TOPIC_TELEMETRY)
        self.room.on(TOPIC_TELEMETRY, self._on_telemetry_received)
        print(f"Subscribed to telemetry on {ROOM}")

        print(f"\nSending telemetry every 3 seconds... (Ctrl+C to stop)\n")

        while self.running:
            temp = round(20 + random.uniform(-5, 10), 1)
            humidity = round(40 + random.uniform(-10, 20), 1)

            reading = {
                "id": str(uuid.uuid4()),
                "deviceId": self.device_id,
                "sensorId": "temperature",
                "value": temp,
                "unit": "°C",
                "timestamp": int(time.time() * 1000),
                "isReplay": False,
            }
            await self.room.emit(TOPIC_TELEMETRY, reading)
            print(f"  Sent: temp={temp}°C")

            reading2 = {
                "id": str(uuid.uuid4()),
                "deviceId": self.device_id,
                "sensorId": "humidity",
                "value": humidity,
                "unit": "%",
                "timestamp": int(time.time() * 1000),
                "isReplay": False,
            }
            await self.room.emit(TOPIC_TELEMETRY, reading2)
            print(f"  Sent: humidity={humidity}%")

            await asyncio.sleep(10)

    async def _run_controller(self) -> None:
        """Controller: listen for telemetry, can send commands."""
        # Subscribe to telemetry
        await self.room.subscribe(TOPIC_TELEMETRY)
        self.room.on(TOPIC_TELEMETRY, self._on_telemetry_received)
        print(f"Subscribed to telemetry on {ROOM}")

        # Subscribe to command acks
        await self.room.subscribe(TOPIC_CMD_ACK)
        self.room.on(TOPIC_CMD_ACK, self._on_cmd_ack)
        print(f"Subscribed to command acks on {ROOM}")

        # Subscribe to commands too (to see what's being sent)
        await self.room.subscribe(TOPIC_COMMANDS)
        self.room.on(TOPIC_COMMANDS, self._on_command)
        print(f"Subscribed to commands on {ROOM}")

        print(f"\nListening for telemetry... Type a command or 'quit':")
        print(f"  send <targetDeviceId> <command> [params_json]")
        print(f"  Example: send abc123 setThreshold {{\"value\": 80}}")
        print()

        # Read stdin in a non-blocking way
        while self.running:
            try:
                line = await asyncio.wait_for(
                    asyncio.get_event_loop().run_in_executor(None, input, "> "),
                    timeout=60,
                )
                line = line.strip()
                if line == "quit":
                    break
                if line.startswith("send "):
                    await self._send_command(line)
            except asyncio.TimeoutError:
                continue
            except EOFError:
                break

    async def _send_command(self, line: str) -> None:
        parts = line.split(None, 3)
        if len(parts) < 3:
            print("Usage: send <targetDeviceId> <command> [params_json]")
            return

        target = parts[1]
        command = parts[2]
        params = {}
        if len(parts) > 3:
            try:
                params = json.loads(parts[3])
            except json.JSONDecodeError:
                print("Invalid JSON params")
                return

        cmd = {
            "id": str(uuid.uuid4()),
            "targetDeviceId": target,
            "command": command,
            "params": params,
            "status": "pending",
            "sentBy": self.device_id,
            "sentAt": int(time.time() * 1000),
        }
        await self.room.emit(TOPIC_COMMANDS, cmd)
        print(f"  Command sent: {command} -> {target}")

    def _on_telemetry_received(self, data: Any, meta: Any = None) -> None:
        if not isinstance(data, dict):
            print(f"  [telemetry] raw: {data}")
            return
        device = data.get("deviceId", "?")
        sensor = data.get("sensorId", "?")
        value = data.get("value", "?")
        unit = data.get("unit", "")
        print(f"  [telemetry] {device}: {sensor}={value}{unit}")

    def _on_command(self, data: Any, meta: Any = None) -> None:
        if not isinstance(data, dict):
            print(f"  [command] raw: {data}")
            return
        cmd_id = data.get("id", "?")
        target = data.get("targetDeviceId", "?")
        command = data.get("command", "?")
        print(f"  [command] {command} -> {target} (id: {cmd_id[:8]})")

        # If we're a device and this command targets us, auto-ack it
        if self.args.role == "device" and target == self.device_id:
            print(f"    -> Command targets us! Auto-acking...")
            asyncio.ensure_future(self._ack_command(data))

    async def _ack_command(self, cmd: dict) -> None:
        ack = {
            "commandId": cmd["id"],
            "status": "completed",
            "result": {"message": f"Command '{cmd.get('command')}' executed successfully"},
            "ackedBy": self.device_id,
            "ackedAt": int(time.time() * 1000),
        }
        await self.room.emit(TOPIC_CMD_ACK, ack)
        print(f"    Ack sent for command {cmd['id'][:8]}")

    def _on_cmd_ack(self, data: Any, meta: Any = None) -> None:
        if not isinstance(data, dict):
            return
        cmd_id = data.get("commandId", "?")
        status = data.get("status", "?")
        acked_by = data.get("ackedBy", "?")
        print(f"  [ack] command {cmd_id[:8]} -> {status} (by {acked_by})")

    def _on_presence(self, event_type: str, data: Any) -> None:
        actor_id = data.actor_token_id if hasattr(data, "actor_token_id") else "?"
        presence = data.presence if hasattr(data, "presence") else {}
        name = presence.get("deviceName", "?")
        role = presence.get("role", "?")
        print(f"  [presence:{event_type}] {name} ({role}) actor={actor_id[:8]}")

    async def stop(self) -> None:
        self.running = False
        if self.client:
            self.client.disconnect()
        print("Stopped.")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="NoLag IoT Device Simulator (Python)")
    parser.add_argument("--token", required=True, help="NoLag actor token")
    parser.add_argument("--app", required=True, help="NoLag app slug")
    parser.add_argument("--role", choices=["device", "controller"], default="device",
                        help="Device role (default: device)")
    parser.add_argument("--name", default="PySensor", help="Device name")
    parser.add_argument("--url", default=None, help="Broker URL (uses SDK default if not set)")
    parser.add_argument("--debug", action="store_true", help="Enable debug logging")
    return parser.parse_args()


async def main() -> None:
    args = parse_args()

    if args.debug:
        import logging
        logging.basicConfig(level=logging.DEBUG)

    device = IoTDevice(args)
    try:
        await device.start()
    except KeyboardInterrupt:
        print("\nInterrupted.")
    finally:
        await device.stop()


if __name__ == "__main__":
    asyncio.run(main())
