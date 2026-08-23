import { MicrophoneCapture, PcmOutputPlayer, bytesToBase64 } from './audio.js';
import { expectedForSide } from './commands.js';

const COMMAND_ENDPOINT = '/api/detect-command';
const TRANSLATE_ENDPOINT = '/api/translate-turn';
const TTS_ENDPOINT = '/api/tts';
const MAX_TURN_AUDIO_BYTES = 16000 * 2 * 75; // ~75 seconds at 16kHz mono PCM16

const LANGUAGES = [
  ['vi', '🇻🇳', 'Tiếng Việt'], ['zh-CN', '🇨🇳', 'Tiếng Trung (Giản thể)'], ['zh-TW', '🇹🇼', 'Tiếng Trung (Phồn thể)'],
  ['en', '🇺🇸', 'Tiếng Anh'], ['ja', '🇯🇵', 'Tiếng Nhật'], ['ko', '🇰🇷', 'Tiếng Hàn'], ['th', '🇹🇭', 'Tiếng Thái'],
  ['id', '🇮🇩', 'Tiếng Indonesia'], ['ms', '🇲🇾', 'Tiếng Malay'], ['fr', '🇫🇷', 'Tiếng Pháp'], ['de', '🇩🇪', 'Tiếng Đức'],
  ['es', '🇪🇸', 'Tiếng Tây Ban Nha'], ['pt-BR', '🇧🇷', 'Tiếng Bồ Đào Nha'], ['it', '🇮🇹', 'Tiếng Ý'], ['ru', '🇷🇺', 'Tiếng Nga'],
  ['ar', '🇸🇦', 'Tiếng Ả Rập'], ['hi', '🇮🇳', 'Tiếng Hindi'], ['tr', '🇹🇷', 'Tiếng Thổ Nhĩ Kỳ'], ['nl', '🇳🇱', 'Tiếng Hà Lan'],
  ['pl', '🇵🇱', 'Tiếng Ba Lan'], ['sv', '🇸🇪', 'Tiếng Thụy Điển'], ['da', '🇩🇰', 'Tiếng Đan Mạch'], ['no', '🇳🇴', 'Tiếng Na Uy'],
  ['fi', '🇫🇮', 'Tiếng Phần Lan'], ['cs', '🇨🇿', 'Tiếng Séc'], ['uk', '🇺🇦', 'Tiếng Ukraina'], ['fil', '🇵🇭', 'Tiếng Filipino'],
];

const els = {
  lang1: document.querySelector('#lang1'), lang2: document.querySelector('#lang2'), startBtn: document.querySelector('#startBtn'),
  startLabel: document.querySelector('#startLabel'), status: document.querySelector('#status'), statusDot: document.querySelector('#statusDot'),
  statusText: document.querySelector('#statusText'), micBars: [...document.querySelectorAll('.mic-bar')], errorBox: document.querySelector('#errorBox'),
  errorText: document.querySelector('#errorText'), dismissError: document.querySelector('#dismissError'), installHint: document.querySelector('#installHint'),
};

const state = {
  running: false, processing: false, currentSide: 1, mic: null, player: null, wakeLock: null,
  lang1: null, lang2: null, turnAudioChunks: [], turnAudioBytes: 0,
  commandProbeBusy: false, queuedProbe: null, lastCommandAt: 0,
};

function languageByCode(code) {
  const found = LANGUAGES.find(([c]) => c === code);
  return found ? { code: found[0], flag: found[1], name: found[2] } : { code, flag: '🌐', name: code };
}

function populateLanguages() {
  for (const select of [els.lang1, els.lang2]) {
    select.innerHTML = '';
    for (const [code, flag, name] of LANGUAGES) {
      const option = document.createElement('option'); option.value = code; option.textContent = `${flag}  ${name}`; select.append(option);
    }
  }
  els.lang1.value = 'vi'; els.lang2.value = 'zh-CN';
}

function setStatus(kind, text) {
  els.status.dataset.kind = kind; els.statusText.textContent = text;
  els.statusDot.classList.toggle('pulse', ['listening', 'translating', 'speaking', 'connecting'].includes(kind));
}

function showError(message) { els.errorText.textContent = message; els.errorBox.hidden = false; }
function hideError() { els.errorBox.hidden = true; }

function updateMicMeter(level = 0) {
  const normalized = Math.max(0, Math.min(1, level));
  els.micBars.forEach((bar, index) => {
    const threshold = (index + 1) / (els.micBars.length + 1);
    bar.style.transform = `scaleY(${normalized > threshold ? 1 : 0.35})`;
  });
}

function clearTurnMemory() {
  state.turnAudioChunks = [];
  state.turnAudioBytes = 0;
  state.queuedProbe = null;
  state.commandProbeBusy = false;
  state.lastCommandAt = 0;
}

function appendTurnAudio(pcmBytes) {
  if (!state.running || state.processing) return;
  const bytes = pcmBytes instanceof Uint8Array ? pcmBytes : new Uint8Array(pcmBytes);
  if (!bytes.byteLength) return;
  const copy = bytes.slice();
  state.turnAudioChunks.push(copy); state.turnAudioBytes += copy.byteLength;
  while (state.turnAudioBytes > MAX_TURN_AUDIO_BYTES && state.turnAudioChunks.length > 1) {
    const removed = state.turnAudioChunks.shift(); state.turnAudioBytes -= removed.byteLength;
  }
}

function currentTurnAudio() {
  const out = new Uint8Array(state.turnAudioBytes); let offset = 0;
  for (const chunk of state.turnAudioChunks) { out.set(chunk, offset); offset += chunk.byteLength; }
  return out;
}

function sideInstruction() {
  const command = expectedForSide(state.currentSide);
  const source = state.currentSide === 1 ? state.lang1 : state.lang2;
  return `Nghe ${command.sourceLabel} (${source.name}) · kết thúc bằng “${command.phrase}”`;
}

async function requestWakeLock() {
  if (!('wakeLock' in navigator)) return;
  try { state.wakeLock = await navigator.wakeLock.request('screen'); } catch {}
}
async function releaseWakeLock() { try { await state.wakeLock?.release(); } catch {} state.wakeLock = null; }

async function classifyCommand(pcmBytes, sampleRate, expectedType) {
  const bytes = pcmBytes instanceof Uint8Array ? pcmBytes : new Uint8Array(pcmBytes);
  if (bytes.byteLength < 800) return { commandDetected: false };
  const response = await fetch(COMMAND_ENDPOINT, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, cache: 'no-store',
    body: JSON.stringify({ audio: bytesToBase64(bytes), sampleRate, expected: expectedType }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || 'Không nhận diện được câu lệnh.');
  return data;
}

function queueCommandProbe(pcmBytes, sampleRate = 16000) {
  if (!state.running || state.processing) return;
  state.queuedProbe = { pcmBytes: pcmBytes.slice(), sampleRate, side: state.currentSide, expected: expectedForSide(state.currentSide) };
  runCommandProbe().catch((error) => console.warn('Command probe:', error));
}

async function runCommandProbe() {
  if (state.commandProbeBusy || !state.queuedProbe || !state.running || state.processing) return;
  const probe = state.queuedProbe; state.queuedProbe = null; state.commandProbeBusy = true;
  try {
    if (probe.side !== state.currentSide) return;
    const result = await classifyCommand(probe.pcmBytes, probe.sampleRate, probe.expected.type);
    if (!state.running || state.processing || probe.side !== state.currentSide) return;
    if (result.commandDetected) {
      const now = Date.now(); if (now - state.lastCommandAt < 700) return; state.lastCommandAt = now;
      setStatus('translating', `Đã nhận lệnh “${probe.expected.phrase}”`);
      await processCurrentTurn(probe.expected.type, probe.expected.phrase);
    }
  } finally {
    state.commandProbeBusy = false;
    if (state.queuedProbe && state.running && !state.processing) queueMicrotask(() => runCommandProbe());
  }
}

async function requestTranslation(audioBytes, type, commandPhrase) {
  const source = type === 'SPEAK' ? state.lang1 : state.lang2;
  const target = type === 'SPEAK' ? state.lang2 : state.lang1;
  const response = await fetch(TRANSLATE_ENDPOINT, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, cache: 'no-store',
    body: JSON.stringify({
      audio: bytesToBase64(audioBytes), sampleRate: 16000, commandPhrase,
      sourceLanguage: source, targetLanguage: target, direction: type,
    }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || 'Không dịch được câu vừa nói.');
  if (!String(data.translationText || '').trim()) throw new Error('Mimi không nghe thấy nội dung cần dịch trước câu lệnh.');
  return data;
}

async function requestTts(text, language) {
  const response = await fetch(TTS_ENDPOINT, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, cache: 'no-store',
    body: JSON.stringify({ text, language }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.audio) throw new Error(data.error || 'Không tạo được giọng nói.');
  return data;
}

async function processCurrentTurn(type, commandPhrase) {
  if (state.processing || !state.running) return;
  const turnAudio = currentTurnAudio();
  if (turnAudio.byteLength < 1200) { showError('Chưa có câu nói để dịch.'); return; }

  state.processing = true; state.queuedProbe = null;
  state.mic.pauseSending();
  document.body.classList.add('is-translating');
  els.startLabel.textContent = 'ĐANG DỊCH';

  try {
    setStatus('translating', 'Mimi đang phiên dịch...');
    const translated = await requestTranslation(turnAudio, type, commandPhrase);
    const target = type === 'SPEAK' ? state.lang2 : state.lang1;
    const tts = await requestTts(translated.translationText, target);

    setStatus('speaking', 'Mimi đang nói...');
    els.startLabel.textContent = 'MIMI ĐANG NÓI';
    state.player.resetTurn();
    await state.player.enqueueBase64Pcm16(tts.audio, Number(tts.sampleRate || 24000));
    await state.player.waitUntilDrained(160);

    // HARD RESET: no transcript, no audio, no server session/context survives this turn.
    clearTurnMemory();
    state.currentSide = type === 'SPEAK' ? 2 : 1;
    state.processing = false;
    document.body.classList.remove('is-translating');
    els.startLabel.textContent = 'KẾT THÚC';
    await state.mic.resumeSending();
    setTimeout(() => state.mic?.resumeSending().catch(() => {}), 280);
    setStatus('listening', `${sideInstruction()} · bộ nhớ lượt trước đã xoá`);
  } catch (error) {
    console.error(error);
    clearTurnMemory();
    state.processing = false;
    document.body.classList.remove('is-translating');
    els.startLabel.textContent = 'KẾT THÚC';
    await state.mic.resumeSending().catch(() => {});
    setStatus('listening', sideInstruction());
    showError(error.message || 'Không xử lý được lượt nói.');
  }
}

async function startMimi() {
  if (state.running) return;
  hideError();
  const lang1 = languageByCode(els.lang1.value), lang2 = languageByCode(els.lang2.value);
  if (lang1.code === lang2.code) { showError('Hãy chọn hai ngôn ngữ khác nhau.'); return; }
  state.lang1 = lang1; state.lang2 = lang2;
  els.startBtn.disabled = true; els.lang1.disabled = true; els.lang2.disabled = true;
  els.startLabel.textContent = 'ĐANG KẾT NỐI'; setStatus('connecting', 'Đang mở microphone...');
  try {
    state.player = new PcmOutputPlayer({ onStart: () => setStatus('speaking', 'Mimi đang nói...') });
    await state.player.ensureContext();
    state.mic = new MicrophoneCapture({
      gateEnabled: false,
      onPcmBytes: appendTurnAudio,
      onPcmChunk: () => {},
      onLevel: updateMicMeter,
      onUtterancePcm: queueCommandProbe,
      onError: (error) => console.error('Mic:', error),
    });
    await state.mic.start();
    clearTurnMemory(); state.currentSide = 1; state.running = true; state.processing = false;
    els.startBtn.disabled = false; els.startLabel.textContent = 'KẾT THÚC'; els.startBtn.classList.add('running');
    setStatus('listening', sideInstruction()); await requestWakeLock();
  } catch (error) {
    console.error(error); await stopMimi({ keepError: true }); showError(error.message || 'Không thể khởi động Mimi.');
  }
}

async function stopMimi({ keepError = false } = {}) {
  state.running = false; state.processing = false; state.currentSide = 1; clearTurnMemory();
  state.player?.stopAll(); await state.mic?.stop().catch(() => {}); state.mic = null; await releaseWakeLock(); updateMicMeter(0);
  els.lang1.disabled = false; els.lang2.disabled = false; els.startBtn.disabled = false; els.startBtn.classList.remove('running');
  els.startLabel.textContent = 'BẮT ĐẦU'; document.body.classList.remove('is-translating'); setStatus('ready', 'Sẵn sàng lắng nghe');
  if (!keepError) hideError();
}

els.startBtn.addEventListener('click', async () => { if (state.running) await stopMimi(); else await startMimi(); });
els.dismissError.addEventListener('click', hideError);
document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState === 'visible' && state.running) { if (!state.wakeLock) await requestWakeLock(); await state.mic?.resumeSending().catch(() => {}); }
});
window.addEventListener('pagehide', () => { if (state.running) state.mic?.pauseSending(); });

function detectStandalone() {
  const standalone = window.matchMedia?.('(display-mode: standalone)').matches || window.navigator.standalone;
  const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent); if (isIOS && !standalone) els.installHint.hidden = false;
}
async function registerServiceWorker() {
  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    try { await navigator.serviceWorker.register('./service-worker.js'); } catch (error) { console.warn('Service worker:', error); }
  }
}

populateLanguages(); detectStandalone(); registerServiceWorker(); setStatus('ready', 'Sẵn sàng lắng nghe');
