"""PTY Session Manager"""

import asyncio
import base64
import logging
import os
import platform
import sys
from dataclasses import dataclass
from typing import Callable, Dict, Optional, Any

from .protocol import TOPIC_SESSION_OUTPUT, SessionOutput

logger = logging.getLogger("remote-terminal")

# Platform-specific PTY imports
if platform.system() == "Windows":
    import winpty
else:
    import ptyprocess


@dataclass
class PTYSession:
    """Represents an active PTY session"""
    id: str
    pty: Any
    closed: bool = False
    read_task: Optional[asyncio.Task] = None


class SessionManager:
    """Manages PTY sessions"""

    def __init__(self, emit_func: Callable, work_dir: str):
        self._sessions: Dict[str, PTYSession] = {}
        self._emit = emit_func
        self._work_dir = work_dir

    async def start_session(self, session_id: str, cols: int, rows: int) -> None:
        """Create a new PTY session"""
        # Close existing session if any
        if session_id in self._sessions:
            await self.end_session(session_id)

        # Determine shell to use
        if platform.system() == "Windows":
            shell = r"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe"
            pty = winpty.PtyProcess.spawn(
                shell,
                dimensions=(rows, cols),
                cwd=self._work_dir,
                env=os.environ.copy(),
            )
        else:
            shell = os.environ.get("SHELL", "/bin/sh")
            pty = ptyprocess.PtyProcess.spawn(
                [shell],
                dimensions=(rows, cols),
                cwd=self._work_dir,
                env=os.environ.copy(),
            )

        session = PTYSession(id=session_id, pty=pty)
        self._sessions[session_id] = session

        # Start read task
        session.read_task = asyncio.create_task(self._read_output(session))

        logger.info(f"Session {session_id} started with {shell}")

    async def _read_output(self, session: PTYSession) -> None:
        """Read output from PTY and send to client"""
        try:
            loop = asyncio.get_event_loop()
            while not session.closed:
                try:
                    # Read from PTY (non-blocking with timeout)
                    if platform.system() == "Windows":
                        # winpty read is blocking, run in executor
                        data = await asyncio.wait_for(
                            loop.run_in_executor(None, session.pty.read, 4096),
                            timeout=0.1
                        )
                    else:
                        # ptyprocess read
                        data = await asyncio.wait_for(
                            loop.run_in_executor(None, session.pty.read, 4096),
                            timeout=0.1
                        )

                    if data:
                        # Encode and send
                        if isinstance(data, str):
                            data = data.encode('utf-8')
                        encoded = base64.b64encode(data).decode('ascii')
                        output = SessionOutput(sessionId=session.id, data=encoded)
                        await self._emit(TOPIC_SESSION_OUTPUT, {
                            "sessionId": output.sessionId,
                            "data": output.data,
                            "closed": output.closed,
                        })
                except asyncio.TimeoutError:
                    # No data available, continue
                    await asyncio.sleep(0.01)
                except EOFError:
                    # PTY closed
                    break
                except Exception as e:
                    if not session.closed:
                        logger.error(f"Session {session.id} read error: {e}")
                    break

        except Exception as e:
            logger.error(f"Session {session.id} reader error: {e}")
        finally:
            await self.end_session(session.id)

    async def send_input(self, session_id: str, data: bytes) -> None:
        """Send input to a PTY session"""
        session = self._sessions.get(session_id)
        if not session or session.closed:
            return

        try:
            if platform.system() == "Windows":
                session.pty.write(data.decode('utf-8'))
            else:
                session.pty.write(data)
        except Exception as e:
            logger.error(f"Failed to send input to session {session_id}: {e}")

    async def resize(self, session_id: str, cols: int, rows: int) -> None:
        """Resize a PTY session"""
        session = self._sessions.get(session_id)
        if not session or session.closed:
            return

        try:
            if platform.system() == "Windows":
                session.pty.set_size(rows, cols)
            else:
                session.pty.setwinsize(rows, cols)
        except Exception as e:
            logger.error(f"Failed to resize session {session_id}: {e}")

    async def end_session(self, session_id: str) -> None:
        """Close a PTY session"""
        session = self._sessions.pop(session_id, None)
        if not session:
            return

        if not session.closed:
            session.closed = True

            # Cancel read task
            if session.read_task:
                session.read_task.cancel()
                try:
                    await session.read_task
                except asyncio.CancelledError:
                    pass

            # Close PTY
            try:
                if platform.system() == "Windows":
                    session.pty.close()
                else:
                    session.pty.terminate(force=True)
            except Exception:
                pass

            # Notify client
            output = SessionOutput(sessionId=session_id, closed=True)
            await self._emit(TOPIC_SESSION_OUTPUT, {
                "sessionId": output.sessionId,
                "data": output.data,
                "closed": output.closed,
            })

            logger.info(f"Session {session_id} ended")

    async def close_all(self) -> None:
        """Close all sessions"""
        session_ids = list(self._sessions.keys())
        for session_id in session_ids:
            await self.end_session(session_id)

    def update_work_dir(self, work_dir: str) -> None:
        """Update the working directory"""
        self._work_dir = work_dir
