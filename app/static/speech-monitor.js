/* libfvad processes 20 ms of mono PCM on the audio rendering thread.
   Includes automatic energy+ZCR fallback if a device forces an unsupported sample rate. */
class SpeechMonitor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const { module, mode } = options.processorOptions;
    this.size = Math.max(160, Math.round(sampleRate / 50));
    this.useFvad = false;
    try {
      const supportedRate = [8000, 16000, 32000, 48000].includes(sampleRate);
      if (supportedRate) {
        this.vad = new WebAssembly.Instance(module).exports;
        this.handle = this.vad.fvad_new();
        if (
          this.handle &&
          this.vad.fvad_set_mode(this.handle, mode) >= 0 &&
          this.vad.fvad_set_sample_rate(this.handle, sampleRate) >= 0
        ) {
          this.ptr = this.vad.malloc(this.size * 2);
          if (this.ptr) {
            this.frame = new Int16Array(this.vad.memory.buffer, this.ptr, this.size);
            this.useFvad = true;
          }
        }
      }
    } catch {
      this.useFvad = false;
    }
    this.offset = 0;
    this.power = 0;
    this.zcr = 0;
    this.prevSample = 0;
    this.frames = 0;
    this.voiceMs = 0;
    this.peak = 0;
    this.floor = 0.002;
    this.port.onmessage = ({ data }) => {
      if (typeof data?.floor === "number" && Number.isFinite(data.floor)) {
        this.floor = data.floor;
      }
    };
  }
  process(inputs) {
    const samples = inputs[0]?.[0];
    if (!samples) return true;
    for (let i = 0; i < samples.length; i++) {
      const sample = samples[i];
      if (this.useFvad) {
        this.frame[this.offset] = Math.round(
          Math.max(-1, Math.min(1, sample)) * 32767,
        );
      }
      if ((sample >= 0 && this.prevSample < 0) || (sample < 0 && this.prevSample >= 0)) {
        this.zcr++;
      }
      this.prevSample = sample;
      this.power += sample * sample;
      this.offset++;
      if (this.offset !== this.size) continue;

      const rms = Math.sqrt(this.power / this.size);
      const zcrRate = this.zcr / this.size;
      let speech = false;
      if (this.useFvad) {
        const res = this.vad.fvad_process(this.handle, this.ptr, this.size);
        speech = res === 1 && rms >= this.floor;
      } else {
        speech =
          rms >= Math.max(0.015, this.floor * 2.5) &&
          zcrRate >= 0.03 &&
          zcrRate <= 0.35;
      }
      if (speech) this.voiceMs += 20;
      this.peak = Math.max(this.peak, rms);
      this.offset = 0;
      this.power = 0;
      this.zcr = 0;
      if (++this.frames === 5) {
        this.port.postMessage({
          at: currentTime * 1000,
          voiceMs: this.voiceMs,
          rms: this.peak,
        });
        this.frames = 0;
        this.voiceMs = 0;
        this.peak = 0;
      }
    }
    return true;
  }
}
registerProcessor("exam-speech-monitor", SpeechMonitor);
