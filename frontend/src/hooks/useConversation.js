import { startTransition, useCallback, useEffect, useRef, useState } from 'react';
import { arrayBufferToBase64, StreamingPlayer } from '../audio/audioUtils';

const WS_URL = import.meta.env.VITE_WS_URL || 'ws://localhost:8000/ws/conversation';

// Local RMS VAD: anchors latency AND stops playback immediately when the
// user barges in. OpenAI often finishes generating audio seconds before it
// has finished playing, so waiting for server VAD alone lets the queued
// answer keep talking. Local stop is what the user actually hears.
const LOCAL_VAD_RMS_THRESHOLD = 0.02;
const LOCAL_VAD_INTERRUPT_RMS = 0.03;
const LOCAL_VAD_REFRACTORY_MS = 800;

const MAX_RECONNECT_DELAY_MS = 8000;

export function useConversation() {
  const [connectionState, setConnectionState] = useState('idle'); // idle | connecting | connected | reconnecting | error
  const [aiState, setAiState] = useState('idle'); // idle | listening | thinking | speaking | interrupted
  const [messages, setMessages] = useState([]); // {id, role, text, final}
  const [debugLog, setDebugLog] = useState([]);
  const [latencyHistory, setLatencyHistory] = useState([]); // ms values
  const [lastLatency, setLastLatency] = useState(null);
  const [errorMessage, setErrorMessage] = useState(null);

  const wsRef = useRef(null);
  const shouldRunRef = useRef(false);
  const reconnectAttemptRef = useRef(0);
  const reconnectTimerRef = useRef(null);

  const audioCtxRef = useRef(null);
  const micStreamRef = useRef(null);
  const workletNodeRef = useRef(null);
  const sourceNodeRef = useRef(null);
  const silentGainRef = useRef(null);

  const playerRef = useRef(null);
  const lastLocalSpeechOnsetRef = useRef(0);
  const belowThresholdSinceRef = useRef(0);

  const currentAiMsgIdRef = useRef(null);
  const currentUserMsgIdRef = useRef(null);
  const readyRef = useRef(false);
  const pendingAiTextRef = useRef('');
  const aiTextRafRef = useRef(null);

  const clearPendingAiText = useCallback(() => {
    if (aiTextRafRef.current != null) {
      cancelAnimationFrame(aiTextRafRef.current);
      aiTextRafRef.current = null;
    }
    pendingAiTextRef.current = '';
  }, []);

  const flushAiText = useCallback(() => {
    aiTextRafRef.current = null;
    const id = currentAiMsgIdRef.current;
    const chunk = pendingAiTextRef.current;
    if (!id || !chunk) return;
    pendingAiTextRef.current = '';
    startTransition(() => {
      setMessages((prev) => {
        const idx = prev.findIndex((m) => m.id === id);
        if (idx === -1) {
          return [...prev, { id, role: 'ai', text: chunk, final: false }];
        }
        const copy = [...prev];
        copy[idx] = { ...copy[idx], text: (copy[idx].text || '') + chunk };
        return copy;
      });
    });
  }, []);

  const pushLog = useCallback((event, meta = {}, ts = Date.now()) => {
    startTransition(() => {
      setDebugLog((prev) => [...prev.slice(-200), { event, meta, ts }]);
    });
  }, []);

  const pushMessage = useCallback((role, text, final, existingId = null) => {
    setMessages((prev) => {
      if (existingId) {
        const idx = prev.findIndex((m) => m.id === existingId);
        if (idx !== -1) {
          const copy = [...prev];
          copy[idx] = { ...copy[idx], text, final };
          return copy;
        }
      }
      const id = existingId || `${role}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      return [...prev, { id, role, text, final }];
    });
  }, []);

  // -------------------------------------------------------------- audio out
  const ensurePlayer = useCallback(() => {
    if (!playerRef.current) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      const ctx =
        audioCtxRef.current ||
        new Ctx({ sampleRate: 24000, latencyHint: 'interactive' });
      audioCtxRef.current = ctx;
      const player = new StreamingPlayer(24000, ctx);
      player.onPlaybackStart = () => setAiState('speaking');
      player.onQueueDrained = () =>
        setAiState((prev) => (prev === 'speaking' ? 'listening' : prev));
      playerRef.current = player;
    }
    return playerRef.current;
  }, []);

  // -------------------------------------------------------------- WS -> app
  const handleServerMessage = useCallback(
    (raw) => {
      const msg = JSON.parse(raw);

      switch (msg.type) {
        case 'ready': {
          readyRef.current = true;
          setConnectionState('connected');
          setAiState('listening');
          reconnectAttemptRef.current = 0;
          ensurePlayer().resume();
          break;
        }

        case 'log_event': {
          pushLog(msg.event, msg.meta, msg.ts);
          if (msg.event === 'USER_STARTED') setAiState((p) => (p === 'speaking' ? p : 'listening'));
          if (msg.event === 'NEW_QUERY_STARTED') setAiState('thinking');
          break;
        }

        case 'interrupt': {
          // Stop leftover playback. Ignore if the player is already idle
          // (speech_started also fires on the user's first turn).
          const player = ensurePlayer();
          if (!player.hasQueuedAudio()) break;
          player.stopImmediately();
          clearPendingAiText();
          setAiState('interrupted');
          currentAiMsgIdRef.current = null;

          const clientStopTs = Date.now();
          const anchor = lastLocalSpeechOnsetRef.current || msg.detect_ts;
          const latency = Math.max(0, clientStopTs - anchor);
          setLastLatency(latency);
          setLatencyHistory((prev) => [...prev.slice(-49), latency]);
          pushLog('CLIENT_PLAYBACK_STOPPED', { latency_ms: latency }, clientStopTs);

          // brief visual "Interrupted" flash, then back to listening
          setTimeout(() => setAiState((p) => (p === 'interrupted' ? 'listening' : p)), 500);
          break;
        }

        case 'user_transcript': {
          if (msg.text && msg.text.trim()) {
            pushMessage('user', msg.text.trim(), true, currentUserMsgIdRef.current);
          }
          currentUserMsgIdRef.current = null;
          break;
        }

        case 'ai_text_delta': {
          if (!currentAiMsgIdRef.current) {
            currentAiMsgIdRef.current = `ai-${msg.response_id || Date.now()}`;
          }
          pendingAiTextRef.current += msg.text || '';
          if (aiTextRafRef.current == null) {
            aiTextRafRef.current = requestAnimationFrame(flushAiText);
          }
          break;
        }

        case 'ai_audio_delta': {
          ensurePlayer().enqueue(msg.audio, msg.response_id);
          break;
        }

        case 'ai_response_done': {
          if (aiTextRafRef.current != null) flushAiText();
          setMessages((prev) => {
            const idx = prev.findIndex((m) => m.id === currentAiMsgIdRef.current);
            if (idx === -1) return prev;
            const copy = [...prev];
            copy[idx] = { ...copy[idx], final: true };
            return copy;
          });
          currentAiMsgIdRef.current = null;
          break;
        }

        case 'error': {
          setErrorMessage(msg.message);
          pushLog('ERROR', { message: msg.message });
          break;
        }

        default:
          break;
      }
    },
    [clearPendingAiText, ensurePlayer, flushAiText, pushLog, pushMessage]
  );

  // -------------------------------------------------------------- WS conn
  const connectWs = useCallback(() => {
    setConnectionState((prev) => (prev === 'connected' ? prev : 'connecting'));
    const ws = new WebSocket(WS_URL);
    wsRef.current = ws;

    ws.onopen = () => {
      // wait for backend "ready" before flipping to connected (it needs to
      // finish handshaking with OpenAI first)
    };

    ws.onmessage = (evt) => handleServerMessage(evt.data);

    ws.onerror = () => {
      setErrorMessage('WebSocket error - check the backend is running.');
    };

    ws.onclose = () => {
      readyRef.current = false;
      if (!shouldRunRef.current) {
        setConnectionState('idle');
        return;
      }
      setConnectionState('reconnecting');
      pushLog('WS_DISCONNECTED', {});
      const delay = Math.min(
        MAX_RECONNECT_DELAY_MS,
        500 * 2 ** reconnectAttemptRef.current
      );
      reconnectAttemptRef.current += 1;
      reconnectTimerRef.current = setTimeout(() => {
        if (shouldRunRef.current) connectWs();
      }, delay);
    };
  }, [handleServerMessage, pushLog]);

  // -------------------------------------------------------------- mic in
  const startMic = useCallback(async () => {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        latency: 0,
      },
    });
    micStreamRef.current = stream;

    const Ctx = window.AudioContext || window.webkitAudioContext;
    const audioCtx =
      audioCtxRef.current ||
      new Ctx({ sampleRate: 24000, latencyHint: 'interactive' });
    audioCtxRef.current = audioCtx;
    if (audioCtx.state === 'suspended') await audioCtx.resume();
    await audioCtx.audioWorklet.addModule('/audio-processor.worklet.js');

    const source = audioCtx.createMediaStreamSource(stream);
    sourceNodeRef.current = source;

    const worklet = new AudioWorkletNode(audioCtx, 'mic-processor', {
      processorOptions: { targetSampleRate: 24000 },
    });
    workletNodeRef.current = worklet;

    worklet.port.onmessage = (evt) => {
      const { pcm, rms } = evt.data;

      // local VAD onset detection (for latency anchoring / UI only)
      const nowTs = Date.now();
      if (rms > LOCAL_VAD_RMS_THRESHOLD) {
        belowThresholdSinceRef.current = 0;
        if (nowTs - lastLocalSpeechOnsetRef.current > LOCAL_VAD_REFRACTORY_MS) {
          lastLocalSpeechOnsetRef.current = nowTs;
          const player = playerRef.current;
          if (player?.hasQueuedAudio() && rms >= LOCAL_VAD_INTERRUPT_RMS) {
            player.stopImmediately();
            clearPendingAiText();
            setAiState('interrupted');
            currentAiMsgIdRef.current = null;
            const stoppedAt = Date.now();
            setLastLatency(Math.max(0, stoppedAt - nowTs));
            setLatencyHistory((prev) => [...prev.slice(-49), Math.max(0, stoppedAt - nowTs)]);
            pushLog('CLIENT_PLAYBACK_STOPPED', { latency_ms: 0, source: 'local_vad' }, stoppedAt);
            if (wsRef.current?.readyState === WebSocket.OPEN) {
              wsRef.current.send(JSON.stringify({ type: 'client_interrupt', detect_ts: nowTs }));
            }
            setTimeout(() => setAiState((p) => (p === 'interrupted' ? 'listening' : p)), 500);
          }
        }
      } else if (!belowThresholdSinceRef.current) {
        belowThresholdSinceRef.current = nowTs;
      }

      if (
        readyRef.current &&
        wsRef.current &&
        wsRef.current.readyState === WebSocket.OPEN
      ) {
        const base64 = arrayBufferToBase64(pcm);
        wsRef.current.send(JSON.stringify({ type: 'audio_chunk', audio: base64 }));
      }
    };

    source.connect(worklet);
    // Worklet has no audible output; connecting to a zero-gain node keeps
    // some browsers from garbage-collecting / suspending the graph.
    const silentGain = audioCtx.createGain();
    silentGain.gain.value = 0;
    silentGainRef.current = silentGain;
    worklet.connect(silentGain).connect(audioCtx.destination);
    ensurePlayer();
  }, [clearPendingAiText, ensurePlayer, pushLog]);

  const stopMic = useCallback(() => {
    workletNodeRef.current?.port.close();
    workletNodeRef.current?.disconnect();
    sourceNodeRef.current?.disconnect();
    silentGainRef.current?.disconnect();
    micStreamRef.current?.getTracks().forEach((t) => t.stop());
    workletNodeRef.current = null;
    sourceNodeRef.current = null;
    silentGainRef.current = null;
    micStreamRef.current = null;
  }, []);

  // -------------------------------------------------------------- public API
  const start = useCallback(async () => {
    setErrorMessage(null);
    setMessages([]);
    setDebugLog([]);
    shouldRunRef.current = true;
    reconnectAttemptRef.current = 0;
    try {
      await startMic();
    } catch (e) {
      setErrorMessage('Microphone permission denied or unavailable.');
      shouldRunRef.current = false;
      return;
    }
    connectWs();
  }, [connectWs, startMic]);

  const stop = useCallback(() => {
    shouldRunRef.current = false;
    clearTimeout(reconnectTimerRef.current);
    clearPendingAiText();
    wsRef.current?.close();
    wsRef.current = null;
    playerRef.current?.close();
    playerRef.current = null;
    stopMic();
    audioCtxRef.current?.close();
    audioCtxRef.current = null;
    setConnectionState('idle');
    setAiState('idle');
  }, [clearPendingAiText, stopMic]);

  useEffect(() => () => stop(), []); // eslint-disable-line react-hooks/exhaustive-deps

  return {
    connectionState,
    aiState,
    messages,
    debugLog,
    latencyHistory,
    lastLatency,
    errorMessage,
    start,
    stop,
  };
}
