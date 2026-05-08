"""Remote Terminal Agent - Main Entry Point"""

import argparse
import asyncio
import base64
import json
import logging
import os
import platform
import signal
import socket
import subprocess
import sys
import time
from pathlib import Path
from typing import Any, Dict, Optional

import httpx

from .nolag_client import NoLagClient, NoLagOptions, Room
from .protocol import (
    APP_NAME,
    TOPIC_COMMANDS,
    TOPIC_RESPONSES,
    TOPIC_STATUS,
    CMD_TYPE_SHELL,
    CMD_TYPE_INFO,
    CMD_TYPE_PING,
    CMD_TYPE_COMPLETE,
    CMD_TYPE_LISTDIR,
    CMD_TYPE_DOWNLOAD,
    CMD_TYPE_UPLOAD,
    CMD_TYPE_SESSION_START,
    CMD_TYPE_SESSION_INPUT,
    CMD_TYPE_SESSION_RESIZE,
    CMD_TYPE_SESSION_END,
    Response,
    DeviceStatus,
    SessionStartPayload,
    SessionInputPayload,
    SessionResizePayload,
    SessionEndPayload,
)
from .session import SessionManager

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(message)s",
)
logger = logging.getLogger("remote-terminal")

# Global state
work_dir = os.getcwd()
session_manager: Optional[SessionManager] = None
room: Optional[Room] = None


async def create_room_via_api(api_url: str, api_key: str, app_id: str, device_id: str) -> None:
    """Create room via REST API"""
    try:
        async with httpx.AsyncClient() as client:
            response = await client.post(
                f"{api_url}/apps/{app_id}/rooms",
                headers={
                    "Authorization": f"Bearer {api_key}",
                    "Content-Type": "application/json",
                },
                json={
                    "name": f"Device: {device_id}",
                    "slug": device_id,
                },
                timeout=30.0,
            )
            if response.status_code == 200 or response.status_code == 201:
                logger.info(f"Room '{device_id}' created successfully")
            else:
                logger.info(f"Room creation: {response.status_code} (may already exist)")
    except Exception as e:
        logger.info(f"Room creation failed: {e}")


def handle_command(data: Any, meta: Dict) -> None:
    """Handle incoming command"""
    asyncio.create_task(_handle_command_async(data, meta))


async def _handle_command_async(data: Any, meta: Dict) -> None:
    """Handle incoming command (async)"""
    global work_dir, session_manager, room

    cmd_id = data.get("id") or data.get("ID")
    cmd_type = data.get("type") or data.get("Type")
    payload = data.get("payload") or data.get("Payload") or ""

    logger.info(f"Received command [{cmd_id}]: {cmd_type} - {payload}")

    response = {
        "commandId": cmd_id,
        "status": "success",
        "output": "",
        "exitCode": 0,
    }

    try:
        if cmd_type == CMD_TYPE_SHELL:
            await handle_shell(payload, response)

        elif cmd_type == CMD_TYPE_PING:
            response["output"] = "pong"

        elif cmd_type == CMD_TYPE_INFO:
            response["output"] = get_system_info()

        elif cmd_type == CMD_TYPE_COMPLETE:
            response["completions"] = get_completions(payload)

        elif cmd_type == CMD_TYPE_LISTDIR:
            handle_listdir(payload or work_dir, response)

        elif cmd_type == CMD_TYPE_DOWNLOAD:
            handle_download(payload, response)

        elif cmd_type == CMD_TYPE_UPLOAD:
            cmd_data = data.get("data") or data.get("Data")
            handle_upload(payload, cmd_data, response)

        elif cmd_type == CMD_TYPE_SESSION_START:
            await handle_session_start(cmd_id, payload, response)

        elif cmd_type == CMD_TYPE_SESSION_INPUT:
            await handle_session_input(payload)
            return  # No response needed

        elif cmd_type == CMD_TYPE_SESSION_RESIZE:
            await handle_session_resize(payload)
            return  # No response needed

        elif cmd_type == CMD_TYPE_SESSION_END:
            await handle_session_end(payload)
            return  # No response needed

        else:
            response["status"] = "error"
            response["error"] = f"Unknown command type: {cmd_type}"

    except Exception as e:
        response["status"] = "error"
        response["error"] = str(e)

    # Send response
    if room:
        await room.emit(TOPIC_RESPONSES, response)


async def handle_shell(command: str, response: Dict) -> None:
    """Handle shell command"""
    global work_dir

    # Handle cd command specially
    if command.startswith("cd "):
        new_dir = command[3:].strip()

        # Expand ~ to home directory
        if new_dir.startswith("~"):
            new_dir = new_dir.replace("~", str(Path.home()), 1)

        # Make absolute if relative
        if not os.path.isabs(new_dir):
            new_dir = os.path.join(work_dir, new_dir)

        # Clean the path
        new_dir = os.path.normpath(new_dir)

        # Check if directory exists
        if not os.path.exists(new_dir):
            response["status"] = "error"
            response["error"] = f"cd: {new_dir}: No such file or directory"
            response["exitCode"] = 1
            return

        if not os.path.isdir(new_dir):
            response["status"] = "error"
            response["error"] = f"cd: {new_dir}: Not a directory"
            response["exitCode"] = 1
            return

        work_dir = new_dir
        if session_manager:
            session_manager.update_work_dir(work_dir)
        response["output"] = f"Changed directory to {work_dir}"
        return

    # Execute command
    try:
        if platform.system() == "Windows":
            result = subprocess.run(
                command,
                shell=True,
                cwd=work_dir,
                capture_output=True,
                text=True,
                timeout=60,
            )
        else:
            result = subprocess.run(
                ["sh", "-c", command],
                cwd=work_dir,
                capture_output=True,
                text=True,
                timeout=60,
            )

        response["output"] = result.stdout + result.stderr
        response["exitCode"] = result.returncode
        if result.returncode != 0:
            response["status"] = "error"

    except subprocess.TimeoutExpired:
        response["status"] = "error"
        response["error"] = "Command timed out"
        response["exitCode"] = 1
    except Exception as e:
        response["status"] = "error"
        response["error"] = str(e)
        response["exitCode"] = 1


def get_system_info() -> str:
    """Get system information"""
    return f"""Hostname: {socket.gethostname()}
OS: {platform.system()}
Architecture: {platform.machine()}
CPUs: {os.cpu_count()}
Working Directory: {work_dir}
Python Version: {platform.python_version()}"""


def get_completions(partial: str) -> list:
    """Get tab completions"""
    if not partial:
        return []

    dir_path = os.path.dirname(partial) or "."
    prefix = os.path.basename(partial)

    # Handle relative paths
    if not os.path.isabs(dir_path):
        dir_path = os.path.join(work_dir, dir_path)

    # If partial ends with separator, list that directory
    if partial.endswith(os.sep) or partial.endswith("/"):
        dir_path = partial
        if not os.path.isabs(dir_path):
            dir_path = os.path.join(work_dir, dir_path)
        prefix = ""

    try:
        entries = os.listdir(dir_path)
        completions = []

        for entry in entries:
            if prefix == "" or entry.lower().startswith(prefix.lower()):
                full_path = os.path.join(dir_path, entry)
                if os.path.isdir(full_path):
                    completions.append(entry + os.sep)
                else:
                    completions.append(entry)

        return completions[:20]
    except Exception:
        return []


def handle_listdir(path: str, response: Dict) -> None:
    """List directory contents"""
    if not os.path.isabs(path):
        path = os.path.join(work_dir, path)

    try:
        entries = os.listdir(path)
        lines = []

        for entry in entries:
            full_path = os.path.join(path, entry)
            try:
                stat = os.stat(full_path)
                perm = "d" if os.path.isdir(full_path) else "-"
                size = str(stat.st_size).rjust(10)
                mtime = time.strftime("%b %d %H:%M", time.localtime(stat.st_mtime))
                name = entry + "/" if os.path.isdir(full_path) else entry
                lines.append(f"{perm} {size} {mtime} {name}")
            except Exception:
                pass

        response["output"] = "\n".join(lines)
    except Exception as e:
        response["status"] = "error"
        response["error"] = str(e)


def handle_download(path: str, response: Dict) -> None:
    """Download a file"""
    if not os.path.isabs(path):
        path = os.path.join(work_dir, path)

    try:
        stat = os.stat(path)
        if stat.st_size > 10 * 1024 * 1024:
            response["status"] = "error"
            response["error"] = "File too large (max 10MB)"
            return

        with open(path, "rb") as f:
            data = f.read()

        encoded = base64.b64encode(data).decode("ascii")
        response["data"] = list(encoded.encode("ascii"))
        response["output"] = f"Downloaded {len(data)} bytes"
    except Exception as e:
        response["status"] = "error"
        response["error"] = str(e)


def handle_upload(path: str, data: Optional[list], response: Dict) -> None:
    """Upload a file"""
    if not data:
        response["status"] = "error"
        response["error"] = "No data provided"
        return

    if not os.path.isabs(path):
        path = os.path.join(work_dir, path)

    try:
        encoded = bytes(data).decode("ascii")
        decoded = base64.b64decode(encoded)

        # Create directory if needed
        os.makedirs(os.path.dirname(path), exist_ok=True)

        with open(path, "wb") as f:
            f.write(decoded)

        response["output"] = f"Uploaded {len(decoded)} bytes to {path}"
    except Exception as e:
        response["status"] = "error"
        response["error"] = str(e)


async def handle_session_start(cmd_id: str, payload: str, response: Dict) -> None:
    """Start interactive PTY session"""
    global session_manager

    try:
        data = json.loads(payload)
        cols = data.get("cols", 80)
        rows = data.get("rows", 24)
    except Exception:
        response["status"] = "error"
        response["error"] = "Invalid session_start payload"
        return

    session_id = cmd_id

    try:
        await session_manager.start_session(session_id, cols, rows)
        response["output"] = session_id
    except Exception as e:
        response["status"] = "error"
        response["error"] = f"Failed to start session: {e}"


async def handle_session_input(payload: str) -> None:
    """Handle session input"""
    global session_manager

    try:
        data = json.loads(payload)
        session_id = data.get("sessionId")
        input_data = base64.b64decode(data.get("data", ""))
        await session_manager.send_input(session_id, input_data)
    except Exception as e:
        logger.error(f"Session input error: {e}")


async def handle_session_resize(payload: str) -> None:
    """Handle session resize"""
    global session_manager

    try:
        data = json.loads(payload)
        session_id = data.get("sessionId")
        cols = data.get("cols", 80)
        rows = data.get("rows", 24)
        await session_manager.resize(session_id, cols, rows)
    except Exception as e:
        logger.error(f"Session resize error: {e}")


async def handle_session_end(payload: str) -> None:
    """Handle session end"""
    global session_manager

    try:
        data = json.loads(payload)
        session_id = data.get("sessionId")
        await session_manager.end_session(session_id)
    except Exception as e:
        logger.error(f"Session end error: {e}")


async def broadcast_status() -> None:
    """Broadcast device status periodically"""
    global room

    while True:
        if room:
            status = {
                "deviceId": args.device,
                "hostname": socket.gethostname(),
                "os": platform.system().lower(),
                "arch": platform.machine(),
                "online": True,
                "timestamp": int(time.time()),
                "workDir": work_dir,
            }
            try:
                await room.emit(TOPIC_STATUS, status)
            except Exception as e:
                logger.error(f"Failed to broadcast status: {e}")

        await asyncio.sleep(30)


async def emit_wrapper(topic: str, data: Any) -> None:
    """Wrapper for session manager to emit"""
    global room
    if room:
        await room.emit(topic, data)


async def run_agent(args: argparse.Namespace) -> None:
    """Run the agent"""
    global room, session_manager, work_dir

    logger.info("Starting remote-terminal agent (Python)...")
    logger.info(f"Device ID: {args.device}")
    logger.info(f"Working directory: {work_dir}")

    # Create room via API
    await create_room_via_api(args.api, args.apikey, args.appid, args.device)

    # Create NoLag client
    options = NoLagOptions(
        url=args.broker,
        reconnect=True,
        reconnect_interval=5.0,
        debug=args.debug,
    )
    client = NoLagClient(args.token, options)

    # Set up event handlers
    client.on_event("disconnect", lambda r: logger.info(f"Disconnected: {r}"))
    client.on_event("reconnect", lambda: logger.info("Reconnecting..."))

    # Set up room
    room = client.set_app(APP_NAME).set_room(args.device)

    # Initialize session manager
    session_manager = SessionManager(emit_wrapper, work_dir)

    # Register handler BEFORE connection (handler gets full topic path)
    room.on(TOPIC_COMMANDS, handle_command)
    logger.info(f"Registered handler for topic: {room._full_topic(TOPIC_COMMANDS)}")

    # Subscribe to commands after connection
    async def on_connect():
        logger.info("Connected to NoLag broker")
        await room.subscribe(TOPIC_COMMANDS)
        logger.info(f"Subscribed to {room._full_topic(TOPIC_COMMANDS)}")

    client.on_event("connect", lambda: asyncio.create_task(on_connect()))

    # Start status broadcaster
    status_task = asyncio.create_task(broadcast_status())

    try:
        await client.connect()
    except asyncio.CancelledError:
        pass
    finally:
        status_task.cancel()
        await session_manager.close_all()
        await client.disconnect()


# Global args for status broadcast
args: argparse.Namespace


def main():
    """Main entry point"""
    global args

    parser = argparse.ArgumentParser(description="Remote Terminal Agent")
    parser.add_argument("-t", "--token", required=True, help="NoLag actor token")
    parser.add_argument("-k", "--apikey", required=True, help="NoLag API key")
    parser.add_argument("-a", "--appid", required=True, help="NoLag App ID")
    parser.add_argument("-d", "--device", default=socket.gethostname(), help="Device ID")
    parser.add_argument("-b", "--broker", default="wss://broker.nolag.app/ws", help="Broker URL")
    parser.add_argument("--api", default="https://api.nolag.app/v1", help="API URL")
    parser.add_argument("--debug", action="store_true", help="Enable debug logging")

    args = parser.parse_args()

    if args.debug:
        logging.getLogger().setLevel(logging.DEBUG)

    # Handle signals
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)

    def signal_handler():
        logger.info("Shutting down...")
        loop.stop()

    if platform.system() != "Windows":
        loop.add_signal_handler(signal.SIGINT, signal_handler)
        loop.add_signal_handler(signal.SIGTERM, signal_handler)

    try:
        loop.run_until_complete(run_agent(args))
    except KeyboardInterrupt:
        logger.info("Shutting down...")
    finally:
        loop.close()


if __name__ == "__main__":
    main()
