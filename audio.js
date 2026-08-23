function getAudioContextCtor() {
  return window.AudioContext || window.webkitAudioContext;
}

function rmsOf(buffer) {
  let sum = 0;
  for (let i = 0; i < buffer.length; i += 1) {
    const value = buffer[i];
    sum += value * value;
  }
  return Math.sqrt(sum / Math.max(1, buffer.length));
}

function downsampleBuffer(input, inputRate, outputRate) {
  if (outputRate === inputRate) return new Float32Array(input);
  if (outputRate > inputRate) throw new Error('Output sample rate must be <= input sample rate');

  const ratio = inputRate / outputRate;
  const newLength = Math.round(input.length / ratio);
  const result = new Float32Array(newLength);
  let offsetResult = 0;
  let offsetInput = 0;

  while (offsetResult < result.length) {
    const nextOffsetInput = Math.round((offsetResult + 1) * ratio);
    let accum = 0;
    let count = 0;
    for (let i = offsetInput; i < nextOffsetInput && i < input.length; i += 1) {
      accum += input[i];
      count += 1;
    }
    result[offsetResult] = count ? accum / count : 0;
    offsetResult += 1;
    offsetInput = nextOffsetInput;
  }

  return result;
}

function floatToPcm16(float32) {
  const pcm = new Int16Array(float32.length);
  for (let i = 0; i < float32.length; i += 1) {
    const s = Math.max(-1, Math.min(1, float32[i]));
    pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return pcm;
}

function concatUint8(chunks = []) {
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

export function bytesToBase64(bytes) {
  const uint8 = bytes instanceof Uint8Array
    ? bytes
    : new Uint8Array(bytes.buffer || bytes);
  const chunkSize = 0x8000;
  let binary = '';
  for (let i = 0; i < uint8.length; i += chunkSize) {
    const chunk = uint8.subarray(i, Math.min(i + chunkSize, uint8.length));
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

export function base64ToBytes(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export class MicrophoneCapture {
  constructor({ onPcmChunk, onLevel, onSpeechStart, onSpeechEnd, onUtterancePcm, onError, gateEnabled = true } = {}) {
    this.onPcmChunk = onPcmChunk;
    this.onLevel = onLevel;
    this.onSpeechStart = onSpeechStart;
    this.onSpeechEnd = onSpeechEnd;
    this.onUtterancePcm = onUtterancePcm;
    this.onError = onError;
    this.gateEnabled = gateEnabled;
    this.stream = null;
    this.audioContext = null;
    this.sourceNode = null;
    this.processorNode = null;
    this.highpassNode = null;
    this.compressorNode = null;
    this.silentGain = null;
    this.running = false;
    this.sendEnabled = true;
    this.noiseFloor = 0.0025;
    this.speechHangoverUntil = 0;
    this.speechActive = false;
    this.preRollChunks = [];
    this.utteranceChunks = [];
  }

  async start() {
    if (this.running) return;
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('Trình duyệt này không hỗ trợ microphone web.');
    }

    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        channelCount: 1,
      },
      video: false,
    });

    const AudioContextCtor = getAudioContextCtor();
    if (!AudioContextCtor) throw new Error('Thiết bị không hỗ trợ Web Audio API.');

    this.audioContext = new AudioContextCtor({ latencyHint: 'interactive' });
    if (this.audioContext.state === 'suspended') await this.audioContext.resume();

    this.sourceNode = this.audioContext.createMediaStreamSource(this.stream);

    // Removes rumble/air-conditioner energy below normal speech fundamentals.
    this.highpassNode = this.audioContext.createBiquadFilter();
    this.highpassNode.type = 'highpass';
    this.highpassNode.frequency.value = 90;
    this.highpassNode.Q.value = 0.7;

    // Gentle dynamics control so soft speech is usable without over-amplifying noise.
    this.compressorNode = this.audioContext.createDynamicsCompressor();
    this.compressorNode.threshold.value = -30;
    this.compressorNode.knee.value = 18;
    this.compressorNode.ratio.value = 3;
    this.compressorNode.attack.value = 0.01;
    this.compressorNode.release.value = 0.22;

    // ScriptProcessor is deprecated, but remains the most broadly compatible
    // capture path across current Safari/iOS versions without a separate worklet file.
    this.processorNode = this.audioContext.createScriptProcessor(4096, 1, 1);
    this.silentGain = this.audioContext.createGain();
    this.silentGain.gain.value = 0;

    this.processorNode.onaudioprocess = (event) => {
      try {
        if (!this.running) return;
        const input = event.inputBuffer.getChannelData(0);
        const level = rmsOf(input);
        this.onLevel?.(Math.min(1, level * 8));

        if (!this.sendEnabled) return;

        const now = performance.now();
        const threshold = Math.min(0.012, Math.max(0.0015, this.noiseFloor * 1.35));
        const speaking = level >= threshold;
        let startedNow = false;
        let endedNow = false;

        if (speaking) {
          this.speechHangoverUntil = now + 620;
          if (!this.speechActive) {
            this.speechActive = true;
            startedNow = true;
            // Preserve ~300 ms before speech start so "Mimi" is not clipped.
            this.utteranceChunks = this.preRollChunks.map((chunk) => chunk.slice());
            this.onSpeechStart?.();
          }
        } else if (now > this.speechHangoverUntil) {
          if (this.speechActive) {
            endedNow = true;
            this.speechActive = false;
          }
          this.noiseFloor = (this.noiseFloor * 0.97) + (Math.min(level, 0.025) * 0.03);
        }

        const shouldGate = this.gateEnabled && !speaking && now > this.speechHangoverUntil;
        const prepared = new Float32Array(input);
        if (shouldGate) {
          for (let i = 0; i < prepared.length; i += 1) prepared[i] *= 0.35;
        }
        const resampled = downsampleBuffer(prepared, this.audioContext.sampleRate, 16000);
        const pcm16 = floatToPcm16(resampled);
        const pcmBytes = new Uint8Array(pcm16.buffer.slice(0));

        if (this.speechActive || endedNow || startedNow) {
          this.utteranceChunks.push(pcmBytes);
        }

        if (endedNow) {
          const utterance = concatUint8(this.utteranceChunks);
          this.utteranceChunks = [];
          this.onSpeechEnd?.();
          if (utterance.byteLength > 0) this.onUtterancePcm?.(utterance, 16000);
        }

        if (!this.speechActive) {
          this.preRollChunks.push(pcmBytes);
          // ScriptProcessor 4096 is ~85 ms/chunk at 48 kHz; 4 chunks ≈ 340 ms.
          if (this.preRollChunks.length > 4) this.preRollChunks.shift();
        } else {
          this.preRollChunks = [];
        }

        const base64 = bytesToBase64(pcmBytes);
        this.onPcmChunk?.(base64);
      } catch (error) {
        this.onError?.(error);
      }
    };

    this.sourceNode.connect(this.highpassNode);
    this.highpassNode.connect(this.compressorNode);
    this.compressorNode.connect(this.processorNode);
    this.processorNode.connect(this.silentGain);
    this.silentGain.connect(this.audioContext.destination);

    this.running = true;
  }

  pauseSending() {
    this.sendEnabled = false;
    this.speechActive = false;
    this.speechHangoverUntil = 0;
    this.preRollChunks = [];
    this.utteranceChunks = [];
  }

  async resumeSending() {
    if (!this.running) return;
    const track = this.stream?.getAudioTracks?.()[0];
    if (track) track.enabled = true;

    // iPhone Safari may suspend the capture AudioContext while speaker audio is
    // playing or after the app briefly loses focus. Resume it explicitly before
    // reopening the send gate so the second speaker is heard reliably.
    if (this.audioContext?.state === 'suspended') {
      try { await this.audioContext.resume(); } catch {}
    }

    this.speechActive = false;
    this.speechHangoverUntil = 0;
    this.preRollChunks = [];
    this.utteranceChunks = [];
    this.sendEnabled = true;
  }

  isHealthy() {
    const track = this.stream?.getAudioTracks?.()[0];
    return Boolean(this.running && track && track.readyState === 'live' && this.audioContext?.state !== 'closed');
  }

  async stop() {
    this.running = false;
    this.sendEnabled = false;
    this.preRollChunks = [];
    this.utteranceChunks = [];

    try { this.processorNode?.disconnect(); } catch {}
    try { this.compressorNode?.disconnect(); } catch {}
    try { this.highpassNode?.disconnect(); } catch {}
    try { this.sourceNode?.disconnect(); } catch {}
    try { this.silentGain?.disconnect(); } catch {}

    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;

    if (this.audioContext && this.audioContext.state !== 'closed') {
      await this.audioContext.close();
    }
    this.audioContext = null;
  }
}

export class PcmOutputPlayer {
  constructor({ onStart, onIdle } = {}) {
    this.onStart = onStart;
    this.onIdle = onIdle;
    this.audioContext = null;
    this.nextStartAt = 0;
    this.activeSources = new Set();
    this.hasStartedCurrentTurn = false;
  }

  async ensureContext() {
    if (!this.audioContext) {
      const AudioContextCtor = getAudioContextCtor();
      if (!AudioContextCtor) throw new Error('Thiết bị không hỗ trợ phát audio qua Web Audio.');
      this.audioContext = new AudioContextCtor({ latencyHint: 'interactive' });
    }
    if (this.audioContext.state === 'suspended') await this.audioContext.resume();
  }

  async enqueueBase64Pcm16(base64, sampleRate = 24000) {
    await this.ensureContext();
    const bytes = base64ToBytes(base64);
    const aligned = bytes.byteLength - (bytes.byteLength % 2);
    if (aligned <= 0) return;

    const copy = bytes.slice(0, aligned);
    const pcm = new Int16Array(copy.buffer, copy.byteOffset, aligned / 2);
    const audioBuffer = this.audioContext.createBuffer(1, pcm.length, sampleRate);
    const channel = audioBuffer.getChannelData(0);
    for (let i = 0; i < pcm.length; i += 1) channel[i] = pcm[i] / 32768;

    const source = this.audioContext.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(this.audioContext.destination);

    const now = this.audioContext.currentTime;
    const startAt = Math.max(now + 0.025, this.nextStartAt || 0);
    source.start(startAt);
    this.nextStartAt = startAt + audioBuffer.duration;
    this.activeSources.add(source);

    if (!this.hasStartedCurrentTurn) {
      this.hasStartedCurrentTurn = true;
      this.onStart?.();
    }

    source.onended = () => {
      this.activeSources.delete(source);
    };
  }

  async waitUntilDrained(extraMs = 100) {
    await this.ensureContext();
    const remaining = Math.max(0, (this.nextStartAt - this.audioContext.currentTime) * 1000) + extraMs;
    if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, remaining));
    this.hasStartedCurrentTurn = false;
    this.nextStartAt = this.audioContext.currentTime;
    this.onIdle?.();
  }

  resetTurn() {
    this.hasStartedCurrentTurn = false;
  }

  stopAll() {
    for (const source of this.activeSources) {
      try { source.stop(); } catch {}
    }
    this.activeSources.clear();
    if (this.audioContext) this.nextStartAt = this.audioContext.currentTime;
    this.hasStartedCurrentTurn = false;
  }
}
