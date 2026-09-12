// Runs on the audio rendering thread. Takes mic input at the AudioContext's
// native sample rate, downsamples it to 24kHz PCM16 (what OpenAI Realtime
// expects), and posts fixed-size frames back to the main thread along with
// an RMS energy value used for local barge-in.

class MicProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.targetSampleRate = options.processorOptions?.targetSampleRate || 24000;
    this.ratio = sampleRate / this.targetSampleRate;
    this._resampleCursor = 0;
    this.FRAME_SIZE = 480; // 20ms @ 24kHz
    this._out = new Int16Array(this.FRAME_SIZE);
    this._outIndex = 0;
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;
    const channel = input[0];
    if (!channel || channel.length === 0) return true;

    let cursor = this._resampleCursor;
    let sumSquares = 0;
    const n = channel.length;
    const out = this._out;
    const frameSize = this.FRAME_SIZE;
    const ratio = this.ratio;

    while (cursor < n) {
      const sample = channel[cursor | 0] || 0;
      sumSquares += sample * sample;
      out[this._outIndex++] =
        sample < -1 ? -32768 : sample > 1 ? 32767 : (sample * 0x7fff) | 0;
      cursor += ratio;
      if (this._outIndex >= frameSize) {
        const copy = new Int16Array(out);
        this.port.postMessage(
          { pcm: copy.buffer, rms: Math.sqrt(sumSquares / n) },
          [copy.buffer]
        );
        this._outIndex = 0;
      }
    }
    this._resampleCursor = cursor - n;
    return true;
  }
}

registerProcessor('mic-processor', MicProcessor);
