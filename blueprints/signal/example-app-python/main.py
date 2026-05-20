#!/usr/bin/env python3
"""
CLI Video Call App using NoLag Signal SDK + aiortc + OpenCV.

Usage:
    python main.py --token YOUR_TOKEN --app YOUR_APP --room call-room --name Alice

Controls:
    q - Quit
    v - Toggle video on/off
    m - Toggle audio mute
"""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
import sys
import time
from dataclasses import dataclass, field
from typing import Any

import cv2
import numpy as np
from aiortc import (
    MediaStreamTrack,
    RTCIceCandidate,
    RTCPeerConnection,
    RTCSessionDescription,
)
from aiortc.contrib.media import MediaPlayer
from av import VideoFrame

from nolag_signal import NoLagSignal, NoLagSignalOptions, Peer, SignalMessage, SignalRoom

STUN_SERVERS = [
    "stun:stun.l.google.com:19302",
    "stun:stun1.l.google.com:19302",
]


@dataclass
class PeerConnectionEntry:
    peer_id: str
    pc: RTCPeerConnection
    display_name: str = ""
    latest_frame: np.ndarray | None = None
    video_track: MediaStreamTrack | None = None


class CameraTrack(MediaStreamTrack):
    """Captures frames from a local camera via OpenCV and serves them as a video track."""

    kind = "video"

    def __init__(self, device: int = 0) -> None:
        super().__init__()
        self._cap = cv2.VideoCapture(device)
        if not self._cap.isOpened():
            raise RuntimeError(f"Cannot open camera device {device}")
        self._timestamp = 0

    async def recv(self) -> VideoFrame:
        pts, time_base = await self.next_timestamp()

        ret, frame_bgr = self._cap.read()
        if not ret:
            # Return a black frame if camera read fails
            frame_bgr = np.zeros((480, 640, 3), dtype=np.uint8)

        frame_rgb = cv2.cvtColor(frame_bgr, cv2.COLOR_BGR2RGB)
        video_frame = VideoFrame.from_ndarray(frame_rgb, format="rgb24")
        video_frame.pts = pts
        video_frame.time_base = time_base
        return video_frame

    def stop(self) -> None:
        super().stop()
        if self._cap.isOpened():
            self._cap.release()


class VideoCallApp:
    """Main video call application."""

    def __init__(self, args: argparse.Namespace) -> None:
        self.args = args
        self.signal: NoLagSignal | None = None
        self.room: SignalRoom | None = None
        self.peer_connections: dict[str, PeerConnectionEntry] = {}
        self.camera_track: CameraTrack | None = None
        self.local_frame: np.ndarray | None = None
        self.video_enabled = not args.no_video
        self.audio_muted = False
        self.running = True
        self._loop: asyncio.AbstractEventLoop | None = None

    async def start(self) -> None:
        self._loop = asyncio.get_event_loop()

        # Initialize camera
        if self.video_enabled:
            try:
                self.camera_track = CameraTrack()
                print(f"Camera opened successfully")
            except RuntimeError as e:
                print(f"Warning: {e}. Running without video.")
                self.video_enabled = False

        # Initialize signal client
        options = NoLagSignalOptions(
            metadata={"name": self.args.name},
            app_name=self.args.app,
            url=self.args.url,
            debug=self.args.debug,
        )
        self.signal = NoLagSignal(self.args.token, options)

        # Wire signal events
        self.signal.on("connected", self._on_connected)
        self.signal.on("disconnected", self._on_disconnected)
        self.signal.on("reconnected", self._on_reconnected)
        self.signal.on("error", self._on_error)
        self.signal.on("peer_online", self._on_peer_online)
        self.signal.on("peer_offline", self._on_peer_offline)

        print(f"Connecting as '{self.args.name}'...")
        await self.signal.connect()

        # Join room
        self.room = await self.signal.join_room(self.args.room)
        self.room.on("signal", self._on_signal)
        self.room.on("peer_joined", self._on_peer_joined)
        self.room.on("peer_left", self._on_peer_left)
        print(f"Joined room: {self.args.room}")

        # Check for existing peers
        existing = self.room.get_peers()
        for peer in existing:
            name = (peer.metadata or {}).get("name", "Unknown")
            print(f"  Found peer: {name} ({peer.peer_id[:8]})")
            await self._initiate_if_higher(peer)

        # Run display loop
        await self._display_loop()

    async def stop(self) -> None:
        self.running = False

        # Close all peer connections
        for entry in list(self.peer_connections.values()):
            if self.room:
                await self.room.send_bye(entry.peer_id)
            await entry.pc.close()
        self.peer_connections.clear()

        # Stop camera
        if self.camera_track:
            self.camera_track.stop()

        # Disconnect signal
        if self.signal:
            self.signal.disconnect()

        cv2.destroyAllWindows()
        print("Disconnected.")

    # -- Signal event handlers --

    def _on_connected(self) -> None:
        peer_id = self.signal.local_peer.peer_id if self.signal and self.signal.local_peer else "?"
        print(f"Connected! Peer ID: {peer_id[:8]}")

    def _on_disconnected(self, reason: str = "") -> None:
        print(f"Disconnected: {reason}")

    def _on_reconnected(self) -> None:
        print("Reconnected!")

    def _on_error(self, error: Exception) -> None:
        print(f"Error: {error}")

    def _on_peer_online(self, peer: Peer) -> None:
        name = (peer.metadata or {}).get("name", "Unknown")
        print(f"Peer online: {name} ({peer.peer_id[:8]})")

    def _on_peer_offline(self, peer: Peer) -> None:
        name = (peer.metadata or {}).get("name", "Unknown")
        print(f"Peer offline: {name} ({peer.peer_id[:8]})")

    def _on_peer_joined(self, peer: Peer) -> None:
        name = (peer.metadata or {}).get("name", "Unknown")
        print(f"Peer joined room: {name} ({peer.peer_id[:8]})")
        asyncio.ensure_future(self._initiate_if_higher(peer))

    def _on_peer_left(self, peer: Peer) -> None:
        name = (peer.metadata or {}).get("name", "Unknown")
        print(f"Peer left room: {name} ({peer.peer_id[:8]})")
        asyncio.ensure_future(self._remove_peer(peer.peer_id))

    def _on_signal(self, message: SignalMessage) -> None:
        handlers = {
            "offer": self._handle_offer,
            "answer": self._handle_answer,
            "ice-candidate": self._handle_ice_candidate,
            "bye": self._handle_bye,
        }
        handler = handlers.get(message.type)
        if handler:
            asyncio.ensure_future(handler(message.from_peer_id, message.payload))

    # -- WebRTC helpers --

    def _create_peer_connection(self, peer_id: str) -> PeerConnectionEntry:
        from aiortc import RTCConfiguration, RTCIceServer

        config = RTCConfiguration(
            iceServers=[RTCIceServer(urls=STUN_SERVERS)]
        )
        pc = RTCPeerConnection(config)
        entry = PeerConnectionEntry(peer_id=peer_id, pc=pc)

        # Get display name from room peer info
        if self.room:
            peer = self.room.get_peer(peer_id)
            if peer and peer.metadata:
                entry.display_name = peer.metadata.get("name", peer_id[:8])
            else:
                entry.display_name = peer_id[:8]

        @pc.on("track")
        def on_track(track: MediaStreamTrack) -> None:
            if track.kind == "video":
                entry.video_track = track
                asyncio.ensure_future(self._consume_video(entry))
            print(f"Received {track.kind} track from {entry.display_name}")

        @pc.on("icecandidate")
        async def on_icecandidate(candidate: RTCIceCandidate | None) -> None:
            if candidate and self.room:
                await self.room.send_ice_candidate(peer_id, {
                    "candidate": candidate.to_sdp() if hasattr(candidate, "to_sdp") else str(candidate),
                    "sdpMid": candidate.sdpMid,
                    "sdpMLineIndex": candidate.sdpMLineIndex,
                })

        @pc.on("connectionstatechange")
        async def on_state_change() -> None:
            state = pc.connectionState
            print(f"Connection to {entry.display_name}: {state}")
            if state in ("failed", "closed"):
                await self._remove_peer(peer_id)

        self.peer_connections[peer_id] = entry
        return entry

    async def _initiate_if_higher(self, peer: Peer) -> None:
        """Glare resolution: only initiate if our peerId is higher."""
        if not self.signal or not self.signal.local_peer:
            return
        local_id = self.signal.local_peer.peer_id
        if local_id > peer.peer_id:
            print(f"Initiating call to {peer.peer_id[:8]} (we have higher ID)")
            await self._call_peer(peer.peer_id)

    async def _call_peer(self, peer_id: str) -> None:
        entry = self._create_peer_connection(peer_id)

        # Add local tracks
        if self.camera_track and self.video_enabled:
            entry.pc.addTrack(self.camera_track)

        # Create and send offer
        offer = await entry.pc.createOffer()
        await entry.pc.setLocalDescription(offer)

        if self.room:
            await self.room.send_offer(peer_id, {
                "type": offer.type,
                "sdp": offer.sdp,
            })

    async def _handle_offer(self, from_peer_id: str, payload: dict[str, Any]) -> None:
        # Glare resolution: if we already have a connection and our ID is higher, ignore
        if from_peer_id in self.peer_connections:
            if self.signal and self.signal.local_peer:
                if self.signal.local_peer.peer_id > from_peer_id:
                    print(f"Ignoring offer from {from_peer_id[:8]} (glare, we have higher ID)")
                    return
            # Close existing connection before accepting new offer
            await self._remove_peer(from_peer_id)

        entry = self._create_peer_connection(from_peer_id)

        # Add local tracks
        if self.camera_track and self.video_enabled:
            entry.pc.addTrack(self.camera_track)

        # Set remote description (the offer)
        offer = RTCSessionDescription(sdp=payload.get("sdp", ""), type=payload.get("type", "offer"))
        await entry.pc.setRemoteDescription(offer)

        # Create and send answer
        answer = await entry.pc.createAnswer()
        await entry.pc.setLocalDescription(answer)

        if self.room:
            await self.room.send_answer(from_peer_id, {
                "type": answer.type,
                "sdp": answer.sdp,
            })

    async def _handle_answer(self, from_peer_id: str, payload: dict[str, Any]) -> None:
        entry = self.peer_connections.get(from_peer_id)
        if not entry:
            print(f"Received answer from unknown peer {from_peer_id[:8]}")
            return

        answer = RTCSessionDescription(sdp=payload.get("sdp", ""), type=payload.get("type", "answer"))
        await entry.pc.setRemoteDescription(answer)

    async def _handle_ice_candidate(self, from_peer_id: str, payload: dict[str, Any]) -> None:
        entry = self.peer_connections.get(from_peer_id)
        if not entry:
            return

        candidate_str = payload.get("candidate", "")
        if not candidate_str:
            return

        try:
            candidate = RTCIceCandidate(
                sdpMid=payload.get("sdpMid", ""),
                sdpMLineIndex=payload.get("sdpMLineIndex", 0),
                candidate=candidate_str if isinstance(candidate_str, str) else str(candidate_str),
            )
            await entry.pc.addIceCandidate(candidate)
        except Exception as e:
            if self.args.debug:
                print(f"ICE candidate error: {e}")

    async def _handle_bye(self, from_peer_id: str, payload: dict[str, Any]) -> None:
        print(f"Peer {from_peer_id[:8]} sent bye")
        await self._remove_peer(from_peer_id)

    async def _remove_peer(self, peer_id: str) -> None:
        entry = self.peer_connections.pop(peer_id, None)
        if entry:
            await entry.pc.close()
            cv2.destroyWindow(f"Peer: {entry.display_name}")

    # -- Video display --

    async def _consume_video(self, entry: PeerConnectionEntry) -> None:
        """Read frames from a remote video track and store the latest."""
        track = entry.video_track
        if not track:
            return
        try:
            while self.running:
                frame = await asyncio.wait_for(track.recv(), timeout=5.0)
                img = frame.to_ndarray(format="bgr24")
                entry.latest_frame = img
        except (asyncio.TimeoutError, Exception):
            pass

    async def _display_loop(self) -> None:
        """Main loop: display video frames and handle keyboard input."""
        print("\nControls: q=quit, v=toggle video, m=toggle mute")
        print("Waiting for peers...\n")

        while self.running:
            # Show local camera feed
            if self.video_enabled and self.camera_track and self.camera_track._cap.isOpened():
                ret, frame = self.camera_track._cap.read()
                if ret:
                    # Add label
                    label = f"You ({self.args.name})"
                    cv2.putText(frame, label, (10, 30), cv2.FONT_HERSHEY_SIMPLEX, 0.8, (0, 255, 0), 2)
                    if self.audio_muted:
                        cv2.putText(frame, "MUTED", (10, 60), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (0, 0, 255), 2)
                    cv2.imshow("You", frame)

            # Show remote peer video feeds
            for entry in list(self.peer_connections.values()):
                if entry.latest_frame is not None:
                    frame = entry.latest_frame.copy()
                    cv2.putText(frame, entry.display_name, (10, 30), cv2.FONT_HERSHEY_SIMPLEX, 0.8, (0, 255, 0), 2)
                    cv2.imshow(f"Peer: {entry.display_name}", frame)

            # Handle keyboard input
            key = cv2.waitKey(1) & 0xFF
            if key == ord("q"):
                print("Quitting...")
                self.running = False
                break
            elif key == ord("v"):
                self.video_enabled = not self.video_enabled
                state = "on" if self.video_enabled else "off"
                print(f"Video: {state}")
            elif key == ord("m"):
                self.audio_muted = not self.audio_muted
                state = "muted" if self.audio_muted else "unmuted"
                print(f"Audio: {state}")

            # Yield to event loop
            await asyncio.sleep(0.033)  # ~30fps


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="NoLag Signal CLI Video Call")
    parser.add_argument("--token", required=True, help="NoLag actor token")
    parser.add_argument("--app", required=True, help="NoLag app slug")
    parser.add_argument("--room", default="call-room", help="Room name (default: call-room)")
    parser.add_argument("--name", default="User", help="Display name (default: User)")
    parser.add_argument("--url", default=None, help="Broker URL (uses SDK default if not set)")
    parser.add_argument("--no-video", action="store_true", help="Disable camera (audio only)")
    parser.add_argument("--debug", action="store_true", help="Enable debug logging")
    return parser.parse_args()


async def main() -> None:
    args = parse_args()

    if args.debug:
        logging.basicConfig(level=logging.DEBUG)

    app = VideoCallApp(args)
    try:
        await app.start()
    except KeyboardInterrupt:
        print("\nInterrupted.")
    finally:
        await app.stop()


if __name__ == "__main__":
    asyncio.run(main())
