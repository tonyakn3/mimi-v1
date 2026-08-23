import { detectTrailingCommand, expectedForSide, stripTrailingCommand } from './commands.js';
import { MicrophoneCapture, PcmOutputPlayer, bytesToBase64 } from './audio.js';

const MODEL = 'gemini-3.1-flash-live-preview';
const VOICE_NAME = 'Leda';
const TOKEN_ENDPOINT = '/api/live-token';
const COMMAND_ENDPOINT = '/api/detect-command';
const WS_ENDPOINT = 'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContentConstrained';

const LANGUAGES = [
  ['vi', '🇻🇳', 'Tiếng Việt'], ['zh-CN', '🇨🇳', 'Tiếng Trung (Giản thể)'], ['zh-TW', '🇹🇼', 'Tiếng Trung (Phồn thể)'],
  ['en', '🇺🇸', 'Tiếng Anh'], ['ja', '🇯🇵', 'Tiếng Nhật'], ['ko', '🇰🇷', 'Tiếng Hàn'], ['th', '🇹🇭', 'Tiếng Thái'],
  ['id', '🇮🇩', 'Tiếng Indonesia'], ['ms', '🇲🇾', 'Tiếng Malay'], ['fr', '🇫🇷', 'Tiếng Pháp'], ['de', '🇩🇪', 'Tiếng Đức'],
  ['es', '🇪🇸', 'Tiếng Tây Ban Nha'], ['pt-BR', '🇧🇷', 'Tiếng Bồ Đào Nha'], ['it', '🇮🇹', 'Tiếng Ý'], ['ru', '🇷🇺', 'Tiếng Nga'],
  ['ar', '🇸🇦', 'Tiếng Ả Rập'], ['hi', '🇮🇳', 'Tiếng Hindi'], ['tr', '🇹🇷', 'Tiếng Thổ Nhĩ Kỳ'], ['nl', '🇳🇱', 'Tiếng Hà Lan'],
  ['pl', '🇵🇱', 'Tiếng Ba Lan'], ['fil', '🇵🇭', 'Tiếng Filipino'],
];

const LED_GLOSSARY = [
  'LED display', 'màn hình LED', 'LED显示屏', 'pixel pitch', 'module', 'cabinet', 'receiving card', 'sending card', 'HUB board',
  'scan mode', 'refresh rate', 'grayscale', 'brightness', 'nits', 'SMD', 'COB', 'GOB', 'driver IC', 'power supply',
  'front maintenance', 'rear maintenance', 'indoor', 'outdoor', 'rental screen', 'fixed installation', 'NovaStar', 'Nova',
  'Colorlight', 'Huidu', '3840Hz', '7680Hz', 'ICN2053', 'Nationstar', 'Kinglight', 'P1.25', 'P1.5', 'P1.8', 'P2', 'P2.5', 'P2.6', 'P2.9', 'P3', 'P4',
];

const els = {
  lang1: document.querySelector('#lang1'), lang2: document.querySelector('#lang2'), startBtn: document.querySelector('#startBtn'),
  startLabel: document.querySelector('#startLabel'), status: document.querySelector('#status'), statusDot: document.querySelector('#statusDot'),
  statusText: document.querySelector('#statusText'), micBars: [...document.querySelectorAll('.mic-bar')], errorBox: document.querySelector('#errorBox'),
  errorText: document.querySelector('#errorText'), dismissError: document.querySelector('#dismissError'), installHint: document.querySelector('#installHint'),
};

const state = {
  running: false, connecting: false, ws: null, mic: null, player: null, currentSide: 1,
  transcriptBuffer: '', lastInputChunk: '', beforeUtteranceTranscript: '', playGate: false,
  translationHasOutput: false, translationTimeout: null, activeCommandType: null, wakeLock: null,
  fallbackBusy: false, queuedFallback: null, lastCommandAt: 0, lastAudioFlushAt: 0,
  lang1: null, lang2: null,
};

function languageByCode(code) {
  const found = LANGUAGES.find(([value]) => value === code);
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

function updateMicMeter(level = 0) {
  const value = Math.max(0, Math.min(1, level));
  els.micBars.forEach((bar, index) => { bar.style.transform = `scaleY(${value > (index + 1) / (els.micBars.length + 1) ? 1 : 0.35})`; });
}

function showError(message) { els.errorText.textContent = message; els.errorBox.hidden = false; }
function hideError() { els.errorBox.hidden = true; }
function compact(text, max = 84) { const s = String(text || '').replace(/\s+/g, ' ').trim(); return s.length > max ? `…${s.slice(-(max - 1))}` : s; }

function mergeTranscript(buffer, chunk, lastChunk) {
  const next = String(chunk || '').replace(/\s+/g, ' ').trim();
  if (!next) return { buffer, lastChunk };
  let current = String(buffer || '').trim();
  if (!current) return { buffer: next, lastChunk: next };
  if (current.endsWith(next)) return { buffer: current, lastChunk: next };
  if (lastChunk && current.endsWith(lastChunk) && next.startsWith(lastChunk)) {
    current = `${current.slice(0, -lastChunk.length)}${next}`.trim();
    return { buffer: current, lastChunk: next };
  }
  if (next.startsWith(current)) return { buffer: next, lastChunk: next };
  return { buffer: `${current} ${next}`.replace(/\s+/g, ' ').trim(), lastChunk: next };
}

function clearLocalTurn() {
  state.transcriptBuffer = '';
  state.lastInputChunk = '';
  state.beforeUtteranceTranscript = '';
  state.queuedFallback = null;
}

function expectedType() { return state.currentSide === 2 ? 'REVERSE' : 'SPEAK'; }
function expectedPhrase() { return expectedForSide(state.currentSide).phrase; }

function buildSystemInstruction() {
  return `
You are Mimi, a professional two-person face-to-face interpreter.
Person 1 language: ${state.lang1.name} (${state.lang1.code}).
Person 2 language: ${state.lang2.name} (${state.lang2.code}).

ABSOLUTE TRANSPORT RULE:
- Microphone audio is listening context only. NEVER answer, translate, acknowledge, or speak merely because a person stops talking.
- Produce spoken audio ONLY after receiving a private text message beginning exactly with [MIMI_EXECUTE].
- Every [MIMI_EXECUTE] message contains the ONLY source text you may translate for that turn. IGNORE all older audio, transcripts and conversation history when translating it.
- Speak ONLY the translation. No intro, no explanation, no quotation marks, no extra words.

INTERPRETING STYLE:
- Translate naturally like a skilled human interpreter, not word-for-word.
- Preserve intent, directness, politeness, humor and emotion without adding information.
- Understand casual/local Vietnamese, especially Southern usage such as xài, hông, mắc, tao bao, and mixed-language speech.
- Understand professional LED-display terminology: ${LED_GLOSSARY.join(', ')}.
- Preserve every number, price, currency, quantity, dimension, frequency, model, product code, brand and proper name exactly. Never guess a critical number.
- Never answer a question on behalf of the speaker. Translate the question itself.

VOICE:
- Use a youthful young-adult female vocal character, approximately 18–20 in feel, never childlike.
- When speaking Vietnamese, use a natural Southern Vietnam / Saigon style if the selected voice supports it: warm, casual-professional and human.
- Speak a little slower than normal conversation, roughly 8–12% slower in perceived pace, with natural rhythm and pitch. Do NOT stretch syllables or sound like slow motion.
- For other languages, keep the same youthful female, warm interpreter style and slightly relaxed pace.
`.trim();
}

function buildExecutionPrompt(type, sourceText) {
  const source = type === 'SPEAK' ? state.lang1 : state.lang2;
  const target = type === 'SPEAK' ? state.lang2 : state.lang1;
  return `
[MIMI_EXECUTE]
THIS TURN IS STATELESS. IGNORE ALL EARLIER AUDIO AND HISTORY.
SOURCE_LANGUAGE: ${source.name} (${source.code})
TARGET_LANGUAGE: ${target.name} (${target.code})
SOURCE_TEXT:
${sourceText}

Translate SOURCE_TEXT naturally and faithfully into TARGET_LANGUAGE. Speak ONLY the translation. Preserve numbers, brands, model codes, technical terms and meaning exactly.
`.trim();
}

async function fetchEphemeralToken() {
  const response = await fetch(TOKEN_ENDPOINT, { method: 'POST', headers: { 'Content-Type': 'application/json' }, cache: 'no-store', body: '{}' });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.token) throw new Error(data.error || 'Không lấy được Gemini Live token.');
  return data.token;
}

function sendJson(payload) {
  if (state.ws?.readyState !== WebSocket.OPEN) return false;
  state.ws.send(JSON.stringify(payload)); return true;
}

function sendAudio(base64Pcm) {
  if (!state.running || state.playGate || state.ws?.readyState !== WebSocket.OPEN) return;
  sendJson({ realtimeInput: { audio: { data: base64Pcm, mimeType: 'audio/pcm;rate=16000' } } });
}

function flushAudioTurnFast() {
  if (!state.running || state.playGate || state.ws?.readyState !== WebSocket.OPEN) return;
  const now = Date.now(); if (now - state.lastAudioFlushAt < 300) return; state.lastAudioFlushAt = now;
  sendJson({ realtimeInput: { audioStreamEnd: true } });
}

async function waitForSource(type, snapshot = '', timeoutMs = 700) {
  const side = type === 'REVERSE' ? 2 : 1;
  const snap = snapshot.trim();
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const direct = detectTrailingCommand(state.transcriptBuffer, side);
    if (direct?.sourceText) return direct.sourceText;
    // For the fallback detector, the transcript snapshot taken exactly when the
    // command utterance starts is safer than a partial STT chunk such as "dịch l...".
    if (snap && Date.now() - start > 180) return snap;
    if (!snap) {
      const stripped = stripTrailingCommand(state.transcriptBuffer, side).trim();
      if (stripped && stripped !== expectedForSide(side).phrase) return stripped;
    }
    await new Promise((r) => setTimeout(r, 70));
  }
  return snap;
}

async function executeTranslation(type, sourceText) {
  if (!state.running || state.playGate) return;
  const now = Date.now(); if (now - state.lastCommandAt < 500) return; state.lastCommandAt = now;
  const source = String(sourceText || '').trim();
  if (!source) { setStatus('listening', 'Đã nghe lệnh nhưng chưa chốt được câu nguồn. Hãy nói lại câu rồi ra lệnh.'); return; }

  state.playGate = true;
  state.activeCommandType = type;
  state.translationHasOutput = false;
  state.mic.pauseSending();
  state.player.resetTurn();
  clearTimeout(state.translationTimeout);
  setStatus('translating', type === 'SPEAK' ? 'Đã nhận “Mimi nói” · đang dịch...' : 'Đã nhận “dịch lại” · đang dịch...');
  els.startLabel.textContent = 'ĐANG DỊCH'; document.body.classList.add('is-translating');

  sendJson({ realtimeInput: { audioStreamEnd: true } });
  await new Promise((r) => setTimeout(r, 70));
  if (!sendJson({ realtimeInput: { text: buildExecutionPrompt(type, source) } })) throw new Error('Kết nối Gemini chưa sẵn sàng.');

  state.translationTimeout = setTimeout(() => {
    if (state.playGate && !state.translationHasOutput) recoverFromTranslationError('Mimi chưa trả bản dịch. Hãy thử lại.');
  }, 18000);
}

async function finishTranslation() {
  clearTimeout(state.translationTimeout);
  setStatus('speaking', 'Mimi đang nói...'); els.startLabel.textContent = 'MIMI ĐANG NÓI';
  await state.player.waitUntilDrained(100);
  if (!state.running) return;

  const completedSide = state.currentSide;
  state.currentSide = completedSide === 1 ? 2 : 1;
  state.playGate = false; state.translationHasOutput = false; state.activeCommandType = null;

  // HARD LOCAL RESET: remove every piece of the just-finished turn while keeping
  // the already-open Live connection hot. The next execution prompt explicitly
  // ignores server-side history, so old turns cannot be reused for translation.
  clearLocalTurn();
  await state.mic.resumeSending();
  setTimeout(() => state.mic?.resumeSending().catch(() => {}), 250);
  document.body.classList.remove('is-translating'); els.startLabel.textContent = 'KẾT THÚC';
  setStatus('listening', `Đã xóa lượt Người ${completedSide} · đang nghe Người ${state.currentSide} (${expectedPhrase()})`);
}

async function recoverFromTranslationError(message) {
  clearTimeout(state.translationTimeout); state.player?.stopAll(); state.playGate = false; state.translationHasOutput = false; state.activeCommandType = null;
  clearLocalTurn(); await state.mic?.resumeSending(); document.body.classList.remove('is-translating'); els.startLabel.textContent = state.running ? 'KẾT THÚC' : 'BẮT ĐẦU';
  setStatus(state.running ? 'listening' : 'ready', state.running ? `Mimi đang nghe Người ${state.currentSide}...` : 'Sẵn sàng lắng nghe'); showError(message);
}

async function runFallbackProbe() {
  if (state.fallbackBusy || !state.queuedFallback || !state.running || state.playGate) return;
  state.fallbackBusy = true;
  const probe = state.queuedFallback; state.queuedFallback = null;
  try {
    if (probe.side !== state.currentSide) return;
    const response = await fetch(COMMAND_ENDPOINT, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, cache: 'no-store',
      body: JSON.stringify({ audio: bytesToBase64(probe.pcmBytes), sampleRate: probe.sampleRate, expected: probe.side === 2 ? 'REVERSE' : 'SPEAK' }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || 'Command fallback lỗi.');
    if (!data.detected || state.playGate || probe.side !== state.currentSide) return;
    const type = probe.side === 2 ? 'REVERSE' : 'SPEAK';
    const source = await waitForSource(type, probe.sourceSnapshot, 700);
    await executeTranslation(type, source);
  } catch (error) {
    console.warn('Command fallback:', error.message);
  } finally {
    state.fallbackBusy = false;
    if (state.queuedFallback) runFallbackProbe();
  }
}

function probeCommandAudio(pcmBytes, sampleRate = 16000) {
  if (!state.running || state.playGate) return;
  const bytes = pcmBytes instanceof Uint8Array ? pcmBytes : new Uint8Array(pcmBytes);
  const duration = bytes.byteLength / (sampleRate * 2);
  if (duration < 0.25 || duration > 3.6) return;
  state.queuedFallback = { pcmBytes: bytes.slice(), sampleRate, side: state.currentSide, sourceSnapshot: state.beforeUtteranceTranscript, at: Date.now() };
  runFallbackProbe();
}

function maybeHandleTranscriptCommand() {
  if (!state.running || state.playGate) return;
  const command = detectTrailingCommand(state.transcriptBuffer, state.currentSide);
  if (!command?.sourceText) return;
  executeTranslation(command.type, command.sourceText).catch((error) => recoverFromTranslationError(error.message || 'Không dịch được.'));
}

async function handleServerMessage(response) {
  const content = response.serverContent;
  if (!content) return;

  if (content.inputTranscription?.text && state.running && !state.playGate) {
    const merged = mergeTranscript(state.transcriptBuffer, content.inputTranscription.text, state.lastInputChunk);
    state.transcriptBuffer = merged.buffer; state.lastInputChunk = merged.lastChunk;
    const heard = compact(state.transcriptBuffer); if (heard) setStatus('listening', `Mimi nghe: ${heard}`);
    maybeHandleTranscriptCommand();
  }

  if (content.modelTurn?.parts) {
    for (const part of content.modelTurn.parts) {
      if (part.inlineData?.data && state.playGate) {
        state.translationHasOutput = true;
        await state.player.enqueueBase64Pcm16(part.inlineData.data, 24000);
      }
    }
  }

  if (content.outputTranscription?.text && state.playGate) state.translationHasOutput = true;
  if (content.interrupted && state.playGate) state.player.stopAll();
  if (content.turnComplete && state.playGate && state.translationHasOutput) await finishTranslation();
}

async function connectGemini() {
  const token = await fetchEphemeralToken();
  const url = `${WS_ENDPOINT}?access_token=${encodeURIComponent(token)}`;
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url); state.ws = ws; let settled = false;
    const setupTimer = setTimeout(() => fail(new Error('Gemini Live không trả setupComplete sau 10 giây.')), 10000);
    const fail = (error) => {
      if (!settled) {
        settled = true;
        clearTimeout(setupTimer);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    };
    ws.onopen = () => {
      // Raw Live WebSocket setup follows the current v1beta wire format.
      // responseModalities / speechConfig belong directly in setup (not nested
      // under generationConfig) when using the raw BidiGenerateContent socket.
      ws.send(JSON.stringify({ setup: {
        model: `models/${MODEL}`,
        responseModalities: ['AUDIO'],
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: VOICE_NAME } } },
        systemInstruction: { parts: [{ text: buildSystemInstruction() }] },
        realtimeInputConfig: { automaticActivityDetection: { disabled: false, startOfSpeechSensitivity: 'START_SENSITIVITY_HIGH', endOfSpeechSensitivity: 'END_SENSITIVITY_HIGH', prefixPaddingMs: 100, silenceDurationMs: 520 } },
        inputAudioTranscription: {}, outputAudioTranscription: {},
      } }));
    };
    ws.onmessage = async (event) => {
      try {
        const raw = typeof event.data === 'string' ? event.data : await event.data.text();
        const response = JSON.parse(raw);
        if (response.error) {
          const msg = response.error.message || response.error.status || 'Gemini Live setup lỗi.';
          fail(new Error(msg));
          return;
        }
        if (response.setupComplete && !settled) {
          settled = true;
          clearTimeout(setupTimer);
          resolve();
          return;
        }
        await handleServerMessage(response);
      } catch (error) { console.error('Live message:', error); }
    };
    ws.onerror = () => fail(new Error('Không kết nối được Gemini Live API.'));
    ws.onclose = (event) => {
      if (!settled) fail(new Error(`Gemini đóng kết nối (${event.code}).`));
      else if (state.running) { setStatus('error', 'Mất kết nối Gemini'); showError('Kết nối Gemini Live đã đóng. Bấm KẾT THÚC rồi BẮT ĐẦU lại.'); }
    };
  });
}

async function requestWakeLock() {
  if (!('wakeLock' in navigator)) return;
  try { state.wakeLock = await navigator.wakeLock.request('screen'); } catch {}
}
async function releaseWakeLock() { try { await state.wakeLock?.release(); } catch {} state.wakeLock = null; }

async function startMimi() {
  if (state.running || state.connecting) return;
  hideError();
  state.lang1 = languageByCode(els.lang1.value); state.lang2 = languageByCode(els.lang2.value);
  if (state.lang1.code === state.lang2.code) return showError('Hãy chọn hai ngôn ngữ khác nhau.');
  state.connecting = true; els.startBtn.disabled = true; els.lang1.disabled = true; els.lang2.disabled = true; els.startLabel.textContent = 'ĐANG KẾT NỐI'; setStatus('connecting', 'Đang kết nối Mimi Live...');
  try {
    state.player = new PcmOutputPlayer({ onStart: () => setStatus('speaking', 'Mimi đang nói...') });
    await state.player.ensureContext();
    state.mic = new MicrophoneCapture({
      gateEnabled: false,
      onPcmChunk: sendAudio,
      onLevel: updateMicMeter,
      onSpeechStart: () => { state.beforeUtteranceTranscript = state.transcriptBuffer; },
      onSpeechEnd: flushAudioTurnFast,
      onUtterancePcm: probeCommandAudio,
      onError: (error) => console.error('Mic:', error),
    });
    await state.mic.start(); await connectGemini();
    state.running = true; state.connecting = false; state.currentSide = 1; state.playGate = false; state.lastCommandAt = 0; state.lastAudioFlushAt = 0; clearLocalTurn();
    els.startBtn.disabled = false; els.startBtn.classList.add('running'); els.startLabel.textContent = 'KẾT THÚC';
    setStatus('listening', 'Mimi đang nghe Người 1 · nói xong hãy nói “Mimi nói”'); await requestWakeLock();
  } catch (error) {
    console.error(error); state.connecting = false; await stopMimi({ keepError: true }); showError(error.message || 'Không thể khởi động Mimi.');
  }
}

async function stopMimi({ keepError = false } = {}) {
  clearTimeout(state.translationTimeout); state.running = false; state.connecting = false; state.playGate = false; state.translationHasOutput = false; state.currentSide = 1; state.fallbackBusy = false; state.queuedFallback = null; clearLocalTurn();
  try { if (state.ws?.readyState === WebSocket.OPEN) { state.ws.send(JSON.stringify({ realtimeInput: { audioStreamEnd: true } })); state.ws.close(1000, 'Mimi stopped'); } } catch {}
  state.ws = null; state.player?.stopAll(); await state.mic?.stop().catch(() => {}); state.mic = null; await releaseWakeLock(); updateMicMeter(0);
  els.lang1.disabled = false; els.lang2.disabled = false; els.startBtn.disabled = false; els.startBtn.classList.remove('running'); els.startLabel.textContent = 'BẮT ĐẦU'; document.body.classList.remove('is-translating'); setStatus('ready', 'Sẵn sàng lắng nghe'); if (!keepError) hideError();
}

els.startBtn.addEventListener('click', async () => { if (state.running || state.connecting) await stopMimi(); else await startMimi(); });
els.dismissError.addEventListener('click', hideError);
document.addEventListener('visibilitychange', async () => { if (document.visibilityState === 'visible' && state.running) { if (!state.wakeLock) await requestWakeLock(); await state.mic?.resumeSending().catch(() => {}); } });
window.addEventListener('pagehide', () => { try { state.ws?.close(1000, 'Page hidden'); } catch {} });

function detectStandalone() {
  const standalone = window.matchMedia?.('(display-mode: standalone)').matches || window.navigator.standalone;
  if (/iphone|ipad|ipod/i.test(navigator.userAgent) && !standalone) els.installHint.hidden = false;
}
async function registerServiceWorker() {
  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    try { await navigator.serviceWorker.register('./service-worker.js'); } catch (error) { console.warn('Service worker:', error); }
  }
}

populateLanguages(); detectStandalone(); registerServiceWorker(); setStatus('ready', 'Sẵn sàng lắng nghe');
