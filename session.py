"""
RealtimeSession bridges one browser WebSocket client to one upstream OpenAI
Realtime API WebSocket connection.

This module contains ALL of the interruption ("barge-in") logic:

  * OpenAI's server-side VAD (`turn_detection: server_vad`) watches the
    incoming microphone audio stream and emits
    `input_audio_buffer.speech_started` the moment it is confident the user
    has started talking (after `prefix_padding_ms` of lookback and above
    `threshold` energy) and `input_audio_buffer.speech_stopped` after
    `silence_duration_ms` of trailing silence.

  * If `input_audio_buffer.speech_started` arrives while we are mid-response
    (`ai_speaking` is True), we:
      1. Immediately mark the in-flight response as cancelled (so any audio
         deltas still in flight from OpenAI after this point are dropped -
         this is the race-condition guard).
      2. Send `response.cancel` upstream to stop token/audio generation on
         OpenAI's side (saves cost + upstream bandwidth - "stop unnecessary
         processing").
      3. Tell the browser client to stop audio playback *immediately* -
         the browser does not wait for us to confirm the cancel with OpenAI.

  * `silence_duration_ms` is the key knob for the "um..." vs "that's all"
    edge case: a short pause (< silence_duration_ms) will NOT emit
    speech_stopped, so the user's turn is not ended prematurely. A genuine
    pause after finishing a sentence will exceed the threshold and trigger
    the model to respond.

Every important transition is emitted to the client as a `log_event` message
so the frontend debug panel / latency measurement can render it.
"""
from __future__ import annotations

import asyncio
import json
import logging
import socket
import time
from typing import Optional

import websockets
from fastapi import WebSocket, WebSocketDisconnect

from . import config

logger = logging.getLogger(__name__)


def _format_connect_error(exc: BaseException) -> str:
    if isinstance(exc, TimeoutError):
        return "connection timed out while opening WebSocket to OpenAI"
    status = getattr(exc, "status_code", None)
    detail = str(exc).strip() or repr(exc)
    prefix = f"HTTP {status}: " if status else f"{type(exc).__name__}: "
    return prefix + detail


def now_ms() -> int:
    return int(time.time() * 1000)


class RealtimeSession:
    """One browser client <-> one OpenAI Realtime connection."""

    def __init__(self, client_ws: WebSocket):
        self.client_ws = client_ws
        self.openai_ws: Optional[websockets.WebSocketClientProtocol] = None

        # --- turn / response bookkeeping (race-condition guards) ---
        self.current_response_id: Optional[str] = None
        self.cancelled_response_ids: set[str] = set()
        self.ai_speaking: bool = False
        self.response_in_flight: bool = False
        self.have_seen_first_user_turn: bool = False

        self._closed = False

    # ------------------------------------------------------------------ #
    # Lifecycle
    # ------------------------------------------------------------------ #
    async def _open_openai_socket(self):
        headers = {"Authorization": f"Bearer {config.OPENAI_API_KEY}"}
        attempts = (
            {},
            {"family": socket.AF_INET},
        )
        last_exc: Optional[BaseException] = None
        for extra in attempts:
            try:
                return await websockets.connect(
                    config.OPENAI_REALTIME_URL,
                    extra_headers=headers,
                    max_size=None,
                    open_timeout=20,
                    **extra,
                )
            except Exception as exc:  # noqa: BLE001
                last_exc = exc
                logger.warning(
                    "OpenAI Realtime connect failed (%s): %s",
                    type(exc).__name__,
                    _format_connect_error(exc),
                )
        raise last_exc  # type: ignore[misc]

    async def run(self):
        try:
            self.openai_ws = await self._open_openai_socket()
        except Exception as exc:  # noqa: BLE001
            detail = _format_connect_error(exc)
            logger.exception("Failed to reach OpenAI Realtime API")
            await self._send_client({
                "type": "error",
                "message": f"Failed to reach OpenAI Realtime API: {detail}",
            })
            return

        await self._configure_session()
        await self._send_client({"type": "ready"})

        try:
            await asyncio.gather(
                self._pump_client_to_openai(),
                self._pump_openai_to_client(),
            )
        except WebSocketDisconnect:
            pass
        except websockets.exceptions.ConnectionClosed:
            pass
        finally:
            await self.close()

    async def close(self):
        if self._closed:
            return
        self._closed = True
        if self.openai_ws is not None:
            try:
                await self.openai_ws.close()
            except Exception:  # noqa: BLE001
                pass

    # ------------------------------------------------------------------ #
    # Setup
    # ------------------------------------------------------------------ #
    async def _configure_session(self):
        session_update = {
            "type": "session.update",
            "session": {
                "type": "realtime",
                "model": config.OPENAI_REALTIME_MODEL,
                "output_modalities": ["audio"],
                "instructions": config.BOOKING_ASSISTANT_INSTRUCTIONS,
                "audio": {
                    "input": {
                        "format": {"type": "audio/pcm", "rate": 24000},
                        "transcription": {"model": "whisper-1"},
                        "turn_detection": {
                            "type": "server_vad",
                            "threshold": config.VAD_THRESHOLD,
                            "prefix_padding_ms": config.VAD_PREFIX_PADDING_MS,
                            "silence_duration_ms": config.VAD_SILENCE_DURATION_MS,
                            "create_response": True,
                            "interrupt_response": True,
                        },
                    },
                    "output": {
                        "format": {"type": "audio/pcm", "rate": 24000},
                        "voice": config.VOICE,
                    },
                },
            },
        }
        await self.openai_ws.send(json.dumps(session_update))

    # ------------------------------------------------------------------ #
    # Client (browser) -> OpenAI
    # ------------------------------------------------------------------ #
    async def _pump_client_to_openai(self):
        while True:
            raw = await self.client_ws.receive_text()
            try:
                msg = json.loads(raw)
            except json.JSONDecodeError:
                continue

            mtype = msg.get("type")

            if mtype == "audio_chunk":
                # base64 PCM16 mono 24kHz from the browser mic.
                # Build the JSON by concatenation — json.dumps on a ~1KB
                # chunk 50x/sec is wasted work and adds turn-taking lag.
                audio = msg.get("audio")
                if audio:
                    await self.openai_ws.send(
                        '{"type":"input_audio_buffer.append","audio":"' + audio + '"}'
                    )

            elif mtype == "client_interrupt":
                await self._barge_in(msg.get("detect_ts") or now_ms(), source="local_vad")

            elif mtype == "client_ping":
                await self._send_client({"type": "server_pong", "ts": now_ms()})

    # ------------------------------------------------------------------ #
    # OpenAI -> Client (browser)
    # ------------------------------------------------------------------ #
    async def _pump_openai_to_client(self):
        async for raw in self.openai_ws:
            event = json.loads(raw)
            await self._handle_openai_event(event)

    async def _handle_openai_event(self, event: dict):
        etype = event.get("type")

        # ---- User started talking -------------------------------------
        if etype == "input_audio_buffer.speech_started":
            detect_ts = now_ms()
            await self._log_event("USER_STARTED", {"detect_ts": detect_ts})
            # Always stop leftover playback. Audio is often fully queued
            # before the user hears it, so generation may already be done.
            await self._barge_in(detect_ts, source="server_vad")

        # ---- User stopped talking (server VAD silence threshold hit) ---
        elif etype == "input_audio_buffer.speech_stopped":
            await self._log_event("USER_STOPPED", {})
            if self.have_seen_first_user_turn:
                await self._log_event("NEW_QUERY_STARTED", {})
            self.have_seen_first_user_turn = True

        # ---- Live transcript of what the user said ----------------------
        elif etype == "conversation.item.input_audio_transcription.completed":
            transcript = event.get("transcript", "")
            await self._send_client({"type": "user_transcript", "text": transcript})

        # ---- A new AI response has been created -------------------------
        elif etype == "response.created":
            resp_id = event.get("response", {}).get("id")
            self.current_response_id = resp_id
            self.response_in_flight = True
            if self.have_seen_first_user_turn:
                await self._log_event("NEW_RESPONSE_STARTED", {"response_id": resp_id})

        # ---- AI audio is starting to stream out --------------------------
        elif etype == "response.output_audio.delta":
            resp_id = event.get("response_id")
            if resp_id in self.cancelled_response_ids:
                return  # drop stale audio from an already-cancelled response
            if not self.ai_speaking:
                self.ai_speaking = True
                await self._log_event("AI_STARTED", {"response_id": resp_id})
            await self._send_client({
                "type": "ai_audio_delta",
                "audio": event.get("delta", ""),
                "response_id": resp_id,
            })

        # ---- AI text transcript (subtitle for the audio) -----------------
        elif etype == "response.output_audio_transcript.delta":
            resp_id = event.get("response_id")
            if resp_id in self.cancelled_response_ids:
                return
            await self._send_client({
                "type": "ai_text_delta",
                "text": event.get("delta", ""),
                "response_id": resp_id,
            })

        # ---- Response finished naturally (not interrupted) ---------------
        elif etype == "response.done":
            resp = event.get("response", {})
            resp_id = resp.get("id")
            status = resp.get("status")
            self.response_in_flight = False
            self.ai_speaking = False
            if resp_id not in self.cancelled_response_ids and status not in ("cancelled", "incomplete"):
                await self._send_client({"type": "ai_response_done", "response_id": resp_id, "status": status})
                await self._log_event("AI_STOPPED", {"response_id": resp_id, "reason": "completed"})
            else:
                if resp_id:
                    self.cancelled_response_ids.add(resp_id)
                await self._log_event("AI_STOPPED", {"response_id": resp_id, "reason": status or "cancelled"})

        elif etype == "error":
            await self._send_client({"type": "error", "message": event.get("error", {}).get("message", "unknown error")})

    # ------------------------------------------------------------------ #
    # Helpers
    # ------------------------------------------------------------------ #
    async def _barge_in(self, detect_ts: int, source: str = "server_vad"):
        cancelled_id = self.current_response_id
        already_cancelled = bool(cancelled_id and cancelled_id in self.cancelled_response_ids)
        should_cancel = bool(self.response_in_flight and cancelled_id and not already_cancelled)

        if cancelled_id:
            self.cancelled_response_ids.add(cancelled_id)
        self.ai_speaking = False
        self.response_in_flight = False

        await self._send_client({
            "type": "interrupt",
            "response_id": cancelled_id,
            "detect_ts": detect_ts,
        })

        if should_cancel or already_cancelled:
            await self._log_event("USER_INTERRUPTED", {
                "detect_ts": detect_ts,
                "response_id": cancelled_id,
                "source": source,
            })
            await self._log_event("AI_STOPPED", {"detect_ts": detect_ts, "response_id": cancelled_id})

        if should_cancel:
            try:
                await self.openai_ws.send(json.dumps({"type": "response.cancel"}))
                await self._log_event("AI_RESPONSE_CANCELLED", {"response_id": cancelled_id})
            except Exception:  # noqa: BLE001
                pass

    async def _send_client(self, payload: dict):
        try:
            await self.client_ws.send_text(json.dumps(payload))
        except Exception:  # noqa: BLE001
            pass

    async def _log_event(self, name: str, meta: dict):
        await self._send_client({"type": "log_event", "event": name, "ts": now_ms(), "meta": meta})
