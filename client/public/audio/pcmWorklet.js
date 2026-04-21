// AudioWorklet processor that downsamples the realtime mic stream to 16 kHz
// mono 16-bit PCM and emits fixed-size frames over `port.postMessage`.
//
// Deepgram's live endpoint expects raw PCM little-endian frames; browsers
// commonly capture at 44.1 kHz or 48 kHz, so we resample on the worklet
// thread to keep the main thread free.
//
// Load path: served from /audio/pcmWorklet.js (client/public/audio/).

const TARGET_SAMPLE_RATE = 16000;
// Emit ~100 ms of audio at 16 kHz = 1600 samples per frame.
const FRAME_SAMPLES = 1600;

class PcmDownsampler extends AudioWorkletProcessor {
  constructor() {
    super();
    this._buffer = [];
    this._ratio = sampleRate / TARGET_SAMPLE_RATE;
    this._carry = 0;
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;
    const channel = input[0];
    if (!channel || channel.length === 0) return true;

    // Linear-interpolation downsampler. Produces `targetCount` samples from
    // `channel` based on the fixed ratio between the audio context's rate
    // and the 16 kHz target. Carries fractional index across invocations so
    // long streams don't jitter at frame boundaries.
    let index = this._carry;
    while (index < channel.length) {
      const floor = Math.floor(index);
      const frac = index - floor;
      const a = channel[floor];
      const b = channel[Math.min(floor + 1, channel.length - 1)];
      const sample = a + (b - a) * frac;
      // Clamp to [-1, 1] then convert to 16-bit signed int.
      const clamped = Math.max(-1, Math.min(1, sample));
      this._buffer.push(clamped < 0 ? clamped * 0x8000 : clamped * 0x7FFF);
      index += this._ratio;
    }
    this._carry = index - channel.length;

    while (this._buffer.length >= FRAME_SAMPLES) {
      const slice = this._buffer.splice(0, FRAME_SAMPLES);
      const int16 = new Int16Array(slice.length);
      for (let i = 0; i < slice.length; i++) int16[i] = slice[i] | 0;
      // Transferable: zero-copy handoff to the main thread.
      this.port.postMessage(int16.buffer, [int16.buffer]);
    }
    return true;
  }
}

registerProcessor('pcm-downsampler', PcmDownsampler);
