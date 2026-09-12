// ---- base64 <-> ArrayBuffer helpers -------------------------------------

export function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  if (bytes.length <= chunkSize) {
    return btoa(String.fromCharCode.apply(null, bytes));
  }
  let binary = '';
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

export function base64ToInt16Array(base64) {
  const binary = atob(base64);
  const len = binary.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) bytes[i] = binary.charCodeAt(i);
  return new Int16Array(bytes.buffer);
}

// ---- Streaming PCM16 player ---------------------------------------------
//
// OpenAI streams audio as a sequence of small PCM16 chunks. We schedule each
// chunk back-to-back on the Web Audio timeline so playback is gapless, and
// we keep references to every scheduled AudioBufferSourceNode so that on
// interruption we can call .stop() on all of them in a single synchronous
// pass - this is what makes "AI audio actually stops" effectively
// instantaneous (bounded only by one audio-callback quantum, a few ms).

const INT16_SCALE = 1 / 0x8000;
const LOOKAHEAD_S = 0.006;

export class StreamingPlayer {
  constructor(sampleRate = 24000, ctx = null) {
    this.ownsContext = !ctx;
    this.ctx =
      ctx ||
      new (window.AudioContext || window.webkitAudioContext)({
        sampleRate,
        latencyHint: 'interactive',
      });
    this.sampleRate = sampleRate;
    this.nextStartTime = 0;
    this.activeSources = [];
    this.activeResponseId = null;
    this.onPlaybackStart = null; // callback(responseId)
    this.onQueueDrained = null; // callback()
  }

  async resume() {
    if (this.ctx.state === 'suspended') {
      await this.ctx.resume();
    }
  }

  /** Enqueue a base64 PCM16 chunk belonging to `responseId`. */
  enqueue(base64Pcm16, responseId) {
    if (this.ctx.state === 'suspended') {
      this.ctx.resume();
    }

    const int16 = base64ToInt16Array(base64Pcm16);
    if (int16.length === 0) return;

    const buffer = this.ctx.createBuffer(1, int16.length, this.sampleRate);
    const channel = buffer.getChannelData(0);
    for (let i = 0; i < int16.length; i++) channel[i] = int16[i] * INT16_SCALE;

    const source = this.ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(this.ctx.destination);

    const now = this.ctx.currentTime;
    if (this.nextStartTime < now + LOOKAHEAD_S) {
      this.nextStartTime = now + LOOKAHEAD_S;
    }
    const startAt = this.nextStartTime;

    if (this.activeResponseId !== responseId) {
      this.activeResponseId = responseId;
      if (this.onPlaybackStart) this.onPlaybackStart(responseId);
    }

    source.onended = () => {
      const idx = this.activeSources.indexOf(source);
      if (idx !== -1) this.activeSources.splice(idx, 1);
      if (this.activeSources.length === 0 && this.onQueueDrained) this.onQueueDrained();
    };

    source.start(startAt);
    this.nextStartTime = startAt + buffer.duration;
    this.activeSources.push(source);
  }

  hasQueuedAudio() {
    return this.activeSources.length > 0;
  }

  /** Immediately halt all scheduled/playing audio. Returns nothing async - it's synchronous. */
  stopImmediately() {
    const sources = this.activeSources;
    this.activeSources = [];
    this.nextStartTime = this.ctx.currentTime;
    this.activeResponseId = null;
    for (const src of sources) {
      try {
        src.onended = null;
        src.stop();
        src.disconnect();
      } catch (e) {
        // already stopped - fine
      }
    }
  }

  close() {
    this.stopImmediately();
    if (this.ownsContext) {
      this.ctx.close();
    }
  }
}
