# A Voice You Can Interrupt

A small voice-based appointment/booking assistant, "Sam", that demonstrates
**true barge-in**: while Sam is speaking, the moment you start talking he
stops — mid-word if necessary — cancels his in-flight response, and starts
handling your new request. It is not "wait until the AI finishes, then send
the next message."

Built with:

- **Frontend:** React + Vite, Web Audio API / AudioWorklet, native WebSocket
- **Backend:** FastAPI (Python), acting as a thin, stateful relay/proxy
- **Voice/LLM:** OpenAI Realtime API (`gpt-4o-realtime-preview`) — used for
  speech-to-speech, streaming responses, and server-side VAD/turn-detection

---

## 1. Architecture

```
┌────────────────────────────┐        JSON over WebSocket        ┌──────────────────────────────┐        JSON over WebSocket        ┌───────────────────────────┐
│           BROWSER          │  (audio_chunk, ai_audio_delta,    │           BACKEND             │  (input_audio_buffer.append,      │   OpenAI Realtime API     │
│                             │   interrupt, log_event, ...)      │                               │   response.cancel, response.*)    │  (speech-to-speech model, │
│  ┌───────────────────────┐ │ ─────────────────────────────────>│  ┌─────────────────────────┐  │ ─────────────────────────────────>│   server-side VAD)        │
│  │ getUserMedia (mic)    │ │                                    │  │ FastAPI /ws/conversation │  │                                    │                           │
│  └──────────┬────────────┘ │ <─────────────────────────────────│  │  -> RealtimeSession       │  │ <─────────────────────────────────│                           │
│             │ raw PCM      │                                    │  │     (session.py)         │  │                                    │                           │
│  ┌──────────▼────────────┐ │                                    │  └─────────────────────────┘  │                                    │                           │
│  │ AudioWorklet:          │ │                                    │   one Session per client       │                                    │                           │
│  │ downsample -> PCM16    │ │                                    │   connection, owns the          │                                    │                           │
│  │ 24kHz + local RMS VAD  │ │                                    │   upstream OpenAI socket        │                                    │                           │
│  └──────────┬────────────┘ │                                    └──────────────────────────────┘                                    └───────────────────────────┘
│             │ base64 chunks│
│  ┌──────────▼────────────┐ │
│  │ WebSocket client       │ │
│  └──────────┬────────────┘ │
│             │               │
│  ┌──────────▼────────────┐ │
│  │ StreamingPlayer         │ │   <- schedules audio buffers back-to-back on the Web Audio timeline;
│  │ (Web Audio API)         │ │      keeps references to every source node so it can .stop() them all
│  └────────────────────────┘ │      synchronously the instant an "interrupt" message arrives.
│                             │
│  React UI: transcript,      │
│  status badge, debug log,   │
│  latency panel              │
└────────────────────────────┘
```

**Why a backend relay instead of connecting the browser directly to OpenAI?**
The Realtime API requires your `OPENAI_API_KEY` on the connection handshake.
Doing that from the browser would expose the key to anyone who opens dev
tools. The FastAPI backend holds the only copy of the key, opens the upstream
WebSocket to OpenAI on the server side, and relays a simplified event
protocol to the browser.

### Folder structure

```
voice-interrupt-assistant/
├── backend/
│   ├── app/
│   │   ├── main.py        # FastAPI app + WebSocket endpoint
│   │   ├── session.py     # Core relay + interruption/cancellation logic
│   │   └── config.py      # Env-var driven configuration (no hardcoded secrets)
│   ├── requirements.txt
│   └── .env.example
└── frontend/
    ├── public/
    │   └── audio-processor.worklet.js   # mic downsampling + local RMS VAD
    ├── src/
    │   ├── audio/audioUtils.js          # base64<->PCM16, StreamingPlayer
    │   ├── hooks/useConversation.js     # WebSocket protocol + state machine
    │   ├── components/                  # MicButton, Transcript, StatusBadge,
    │   │                                 # DebugPanel, LatencyPanel
    │   ├── App.jsx / App.css / index.css
    │   └── main.jsx
    ├── package.json
    └── .env.example
```

---

## 2. Setup & running locally

### Prerequisites
- Python 3.10+
- Node.js 18+
- An OpenAI API key with Realtime API access

### Backend

```bash
cd backend
python3 -m venv venv
source venv/bin/activate        # Windows: venv\Scripts\activate
pip install -r requirements.txt

cp .env.example .env
# edit .env and set OPENAI_API_KEY=sk-...

python -m app.main              # or: uvicorn app.main:app --reload --port 8000
```

The backend starts on `http://localhost:8000`. Health check: `GET /health`.

### Frontend

```bash
cd frontend
npm install

cp .env.example .env
# VITE_WS_URL=ws://localhost:8000/ws/conversation (default is already correct)

npm run dev
```

Open the printed URL (typically `http://localhost:5173`). Click **Start
Conversation**, allow microphone access, and talk.

> Note: mic access requires a "secure context" — `localhost` is fine; if you
> deploy, you'll need HTTPS/WSS.

---

## 3. How interruption actually works

This is the core of the challenge, so it's worth spelling out precisely.

### Turn detection (VAD)

The backend configures the OpenAI Realtime session with server-side VAD:

```json
"turn_detection": {
  "type": "server_vad",
  "threshold": 0.5,
  "prefix_padding_ms": 300,
  "silence_duration_ms": 650,
  "create_response": true,
  "interrupt_response": true
}
```

- `silence_duration_ms` (650ms by default) is the knob that solves the
  **"um..." vs "that's all" edge case**: OpenAI's VAD only fires
  `input_audio_buffer.speech_stopped` (i.e. "the user is done talking, go
  ahead and respond") after this much continuous silence. A normal
  mid-sentence pause or filler ("the, um...") is almost always shorter than
  this, so the turn is *not* ended prematurely. A pause after a genuinely
  finished sentence ("...that's all.") exceeds it, and the model responds.
- This threshold is deliberately separate from interruption detection.
  **Any** onset of speech — even "wait!" — immediately fires
  `input_audio_buffer.speech_started`, which is what triggers a barge-in.
  There's no silence requirement to *start* an interruption, only to *end*
  a turn. This asymmetry is intentional and matches how humans interrupt
  each other: you don't wait for someone to pause before jumping in, but
  you do wait for them to stop before assuming they're finished.

### The interruption path (`backend/app/session.py`)

1. The browser continuously streams mic audio to the backend over the
   WebSocket as small PCM16 frames (20ms each), regardless of whether Sam is
   currently speaking.
2. The backend forwards every frame upstream via
   `input_audio_buffer.append`.
3. OpenAI's VAD is watching this stream. If it detects speech onset **while
   a response is currently being generated/played**
   (`input_audio_buffer.speech_started` arrives and `ai_speaking == True`),
   the backend treats this as a genuine barge-in and, synchronously, in
   order:
   1. Marks the current `response_id` as cancelled in a local set
      (`cancelled_response_ids`) — this is the **race-condition guard**:
      any `response.audio.delta` / `response.audio_transcript.delta`
      events for that response that are already in flight from OpenAI and
      arrive *after* this point are dropped rather than forwarded to the
      browser or spoken.
   2. Sends `{"type": "interrupt", "response_id": ..., "detect_ts": ...}`
      to the browser **immediately** — before waiting for OpenAI to
      confirm anything. This is what makes the perceived latency low: we
      don't do a round trip to OpenAI before telling the client to shut up.
   3. Sends `response.cancel` upstream, so OpenAI stops generating tokens
      and audio for the abandoned response (saves cost/bandwidth — "stop
      unnecessary upstream processing").
4. The browser's `StreamingPlayer` receives the `interrupt` message and, in
   the same synchronous tick, calls `.stop(0)` on every currently
   scheduled/playing `AudioBufferSourceNode` and clears its queue. Web
   Audio's `.stop()` takes effect essentially immediately (bounded by one
   audio render quantum, a few milliseconds) — there is no "let the current
   buffer finish" behavior.
5. Because the mic stream never stopped, the user's new utterance is
   already being appended to a **fresh** `input_audio_buffer` on OpenAI's
   side. When they stop talking, `speech_stopped` fires, a new
   conversation item + response are created automatically
   (`create_response: true`), and the backend logs `NEW_QUERY_STARTED` /
   `NEW_RESPONSE_STARTED`. No manual "wait for the old request to
   finish" step exists anywhere in this path.

### Preventing race conditions

Two mechanisms specifically address "cancelled responses must not continue
playing":

- **Server-side:** `cancelled_response_ids` is checked before forwarding
  *any* audio or text delta to the browser, so even if OpenAI's
  `response.cancel` doesn't take effect instantly upstream (there's an
  inherent round-trip), stray deltas for the dead response never reach the
  client.
- **Client-side:** `StreamingPlayer.stopImmediately()` doesn't just stop
  scheduling new audio — it forcibly `.stop()`s every node already queued
  on the Web Audio timeline, including ones scheduled slightly in the
  future. Combined with server-side filtering, a cancelled response can
  never be heard, no matter which layer "wins" the race.

### Measuring interruption latency

Latency is measured end-to-end on the **client**, which is the only place
that can observe both ends of the thing we actually care about ("did the
user's voice and the AI's voice actually stop overlapping quickly"):

- `t0` — the browser's own lightweight local RMS-based VAD (in the
  AudioWorklet) marks the moment your mic input crosses an energy threshold
  after being quiet (a rising edge, with a refractory period to avoid
  re-triggering on the same utterance). This is a rough anchor for "when
  did the user start talking," measured with zero network round-trip.
- `t1` — the moment the browser receives the backend's `interrupt` message
  and finishes calling `.stop()` on all active audio nodes (this happens
  synchronously in the WebSocket message handler, so `t1` is effectively
  "message received" time).
- **Latency = `t1 - t0`**, shown live in the Latency panel, with a rolling
  average/best/worst across the session.

This local VAD is used *only* for this timestamp and for an instant
"Listening" UI cue — the actual decision to interrupt is always the
authoritative, server-side OpenAI VAD, so background noise picked up by the
simple local RMS check can never cause a false interruption; it can, at
worst, make one particular latency sample slightly noisy.

### Event log

Every state transition is emitted as a `log_event` message and rendered in
the debug panel, using exactly the vocabulary requested:

`USER_STARTED`, `AI_STARTED`, `USER_INTERRUPTED`, `AI_RESPONSE_CANCELLED`,
`AI_STOPPED`, `NEW_QUERY_STARTED`, `NEW_RESPONSE_STARTED` (plus a few
extras — `USER_STOPPED`, `CLIENT_PLAYBACK_STOPPED`, `WS_DISCONNECTED`,
`ERROR` — for debugging visibility).

---

## 4. Demo script

Run through these in one session to hit every requirement:

1. **Normal conversation.** Click Start, say: *"Book me a dentist
   appointment tomorrow."* Let Sam respond fully. Watch the state badge go
   Listening → Thinking → Speaking → Listening.
2. **Hard interruption.** Ask a longer question, e.g. *"Can you check if
   there's a dentist available sometime next week in the evening?"* While
   Sam is mid-sentence, say loudly: *"Wait! Make that Friday instead."*
   Watch: the state badge flashes **Interrupted**, the debug panel shows
   `USER_STARTED → USER_INTERRUPTED → AI_RESPONSE_CANCELLED → AI_STOPPED`
   within milliseconds of each other, and the latency panel updates.
3. **Immediate new question after interrupting.** Right after interrupting,
   keep talking without pausing: *"...actually, cancel that, book a
   haircut instead."* Sam should address the haircut request, not the
   dentist one — there should be no reference to the abandoned response.
4. **Trailing off without being cut off.** Say, with a natural pause:
   *"I'd like the, um... the appointment for..."* then, after a beat,
   finish with *"...tomorrow morning."* Sam should wait through the pause
   (no `speech_stopped`/response fires during the "um") and only respond
   once you've actually finished the sentence.
5. **Latency readout.** After a couple of interruptions, screenshot / read
   out the Latency panel: last / average / best / worst, in milliseconds.

---

## 5. Failure cases & how they're handled

| Failure case | Handling |
|---|---|
| WebSocket drops mid-conversation | Frontend detects `onclose`, shows "Reconnecting…", and retries with exponential backoff (500ms → 8s cap). A brand-new backend session (and fresh OpenAI connection) is created on reconnect. |
| Backend can't reach OpenAI (bad key, network) | `RealtimeSession.run()` catches the connection error and sends an `error` message to the client instead of crashing the WebSocket handler; UI surfaces it as a visible error banner. |
| User denies microphone permission | `getUserMedia` rejection is caught in `start()`; UI shows "Microphone permission denied or unavailable" and never opens a WebSocket. |
| Stray audio from an already-cancelled response arrives after cancel | Filtered server-side via `cancelled_response_ids` *and* the client only plays audio it's told to — see race-condition section above. |
| User barges in more than once in quick succession | Each `speech_started` re-evaluates `ai_speaking` fresh; a second interruption while a *new* response is playing is handled identically — cancel again, stop again. |
| Very short noise burst mistaken for speech by local VAD | Only affects the latency *measurement* anchor, never triggers an actual interruption (that's gated by OpenAI's own VAD + `ai_speaking` state). |
| Tab closed / component unmounted mid-call | `useEffect` cleanup calls `stop()`, which closes the WebSocket, stops all mic tracks, and closes the AudioContext, so no dangling mic access or open sockets remain. |
| Backend process restarts | Client-side reconnect loop picks it back up automatically once the port is listening again; no manual refresh required. |

---

## 6. Notes / possible extensions

- Swap `gpt-4o-realtime-preview-*` for any future Realtime-capable model by
  changing `OPENAI_REALTIME_MODEL` in `.env` — no code changes needed.
- The "booking" itself is simulated (Sam just confirms details out loud);
  wiring `session.py` to call a real calendar API on a detected
  confirmation intent is a natural next step and wouldn't affect the
  interruption architecture at all.
- `VAD_SILENCE_DURATION_MS` is the single most important tuning knob if you
  want Sam more or less patient with pauses — raise it for slower talkers,
  lower it for snappier turn-taking.
