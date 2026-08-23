import { detectMimiCommand, mergeTranscript } from './commands.js';
import { MicrophoneCapture, PcmOutputPlayer } from './audio.js';

const MODEL = 'gemini-3.1-flash-live-preview';
const VOICE_NAME = 'Kore';
const TOKEN_ENDPOINT = '/api/live-token';
const WS_ENDPOINT = 'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContentConstrained';

const LANGUAGES = [
  ['vi', '🇻🇳', 'Tiếng Việt'],
  ['zh-CN', '🇨🇳', 'Tiếng Trung (Giản thể)'],
  ['zh-TW', '🇹🇼', 'Tiếng Trung (Phồn thể)'],
  ['en', '🇺🇸', 'Tiếng Anh'],
  ['ja', '🇯🇵', 'Tiếng Nhật'],
  ['ko', '🇰🇷', 'Tiếng Hàn'],
  ['th', '🇹🇭', 'Tiếng Thái'],
  ['id', '🇮🇩', 'Tiếng Indonesia'],
  ['ms', '🇲🇾', 'Tiếng Malay'],
  ['fr', '🇫🇷', 'Tiếng Pháp'],
  ['de', '🇩🇪', 'Tiếng Đức'],
  ['es', '🇪🇸', 'Tiếng Tây Ban Nha'],
  ['pt-BR', '🇧🇷', 'Tiếng Bồ Đào Nha'],
  ['it', '🇮🇹', 'Tiếng Ý'],
  ['ru', '🇷🇺', 'Tiếng Nga'],
  ['ar', '🇸🇦', 'Tiếng Ả Rập'],
  ['hi', '🇮🇳', 'Tiếng Hindi'],
  ['tr', '🇹🇷', 'Tiếng Thổ Nhĩ Kỳ'],
  ['nl', '🇳🇱', 'Tiếng Hà Lan'],
  ['pl', '🇵🇱', 'Tiếng Ba Lan'],
  ['sv', '🇸🇪', 'Tiếng Thụy Điển'],
  ['da', '🇩🇰', 'Tiếng Đan Mạch'],
  ['no', '🇳🇴', 'Tiếng Na Uy'],
  ['fi', '🇫🇮', 'Tiếng Phần Lan'],
  ['cs', '🇨🇿', 'Tiếng Séc'],
  ['uk', '🇺🇦', 'Tiếng Ukraina'],
  ['fil', '🇵🇭', 'Tiếng Filipino'],
  ['he', '🇮🇱', 'Tiếng Hebrew'],
];

const LED_GLOSSARY = [
  'LED display', 'màn hình LED', 'LED显示屏', 'pixel pitch', 'P1.25', 'P1.5', 'P1.8', 'P2', 'P2.5', 'P2.6', 'P2.9', 'P3', 'P4',
  'module', 'cabinet', 'receiving card', 'sending card', 'HUB board', 'scan mode', 'refresh rate', 'grayscale', 'brightness', 'nit', 'nits',
  'SMD', 'COB', 'GOB', 'driver IC', 'power supply', 'front maintenance', 'rear maintenance', 'indoor', 'outdoor', 'rental screen',
  'fixed installation', 'NovaStar', 'Nova', 'Colorlight', 'Huidu', '3840Hz', '7680Hz', 'ICN2053', 'ICND', 'Nationstar', 'Kinglight'
];

const els = {
  lang1: document.querySelector('#lang1'),
  lang2: document.querySelector('#lang2'),
  startBtn: document.querySelector('#startBtn'),
  startLabel: document.querySelector('#startLabel'),
  status: document.querySelector('#status'),
  statusDot: document.querySelector('#statusDot'),
  statusText: document.querySelector('#statusText'),
  commandHint: document.querySelector('#commandHint'),
  micBars: [...document.querySelectorAll('.mic-bar')],
  errorBox: document.querySelector('#errorBox'),
  errorText: document.querySelector('#errorText'),
  dismissError: document.querySelector('#dismissError'),
  installHint: document.querySelector('#installHint'),
};

const state = {
  running: false,
  connecting: false,
  ws: null,
  mic: null,
  player: null,
  transcriptBuffer: '',
  lastInputChunk: '',
  lastCommandAt: 0,
  playGate: false,
  translationHasOutput: false,
  translationTimeout: null,
  wakeLock: null,
  lang1: null,
  lang2: null,
  outputTranscript: '',
};

function languageByCode(code) {
  const found = LANGUAGES.find(([langCode]) => langCode === code);
  return found ? { code: found[0], flag: found[1], name: found[2] } : { code, flag: '🌐', name: code };
}

function populateLanguages() {
  for (const select of [els.lang1, els.lang2]) {
    select.innerHTML = '';
    for (const [code, flag, name] of LANGUAGES) {
      const option = document.createElement('option');
      option.value = code;
      option.textContent = `${flag}  ${name}`;
      select.append(option);
    }
  }
  els.lang1.value = 'vi';
  els.lang2.value = 'zh-CN';
}

function setStatus(kind, text) {
  els.status.dataset.kind = kind;
  els.statusText.textContent = text;
  els.statusDot.classList.toggle('pulse', ['listening', 'translating', 'speaking', 'connecting'].includes(kind));
}

function showError(message) {
  els.errorText.textContent = message;
  els.errorBox.hidden = false;
}

function hideError() {
  els.errorBox.hidden = true;
}

function updateMicMeter(level = 0) {
  const normalized = Math.max(0, Math.min(1, level));
  els.micBars.forEach((bar, index) => {
    const threshold = (index + 1) / (els.micBars.length + 1);
    const scale = normalized > threshold ? 1 : 0.35;
    bar.style.transform = `scaleY(${scale})`;
  });
}

async function requestWakeLock() {
  if (!('wakeLock' in navigator)) return;
  try {
    state.wakeLock = await navigator.wakeLock.request('screen');
  } catch {
    // Non-fatal: iOS may refuse in low-power mode or some browser states.
  }
}

async function releaseWakeLock() {
  try { await state.wakeLock?.release(); } catch {}
  state.wakeLock = null;
}

function buildSystemInstruction() {
  const l1 = state.lang1;
  const l2 = state.lang2;
  return `
You are Mimi, a professional human-style interpreter for a two-person face-to-face conversation.

LANGUAGE PAIR
- Person 1 language: ${l1.name} (${l1.code})
- Person 2 language: ${l2.name} (${l2.code})

CRITICAL TRANSPORT RULE
- Live microphone audio is listening/transcription context only.
- NEVER speak, answer, acknowledge, translate, or react to ordinary live microphone audio by itself.
- The client will send a private internal text instruction beginning exactly with [MIMI_EXECUTE].
- ONLY when that internal instruction arrives may you produce spoken audio.
- When you do speak, output ONLY the translated utterance. No introduction, no explanation, no quotation marks, no "Mimi says", no extra comment.

INTERPRETING RULES
1. Translate meaning naturally, as a skilled human interpreter would. Do not translate word-by-word when that sounds unnatural.
2. Preserve the speaker's intent, directness, humor, politeness level, emotion, and business meaning. Adapt pronouns/register naturally for the target language without changing the intent.
3. Understand colloquial Vietnamese, especially Southern Vietnamese usage such as "xài", "hông", "mắc", "tao bao", and equivalent local/slang expressions in other languages from context.
4. Understand mixed-language technical speech. Keep brand names, model names, product codes and established English industry terms when that is how professionals actually speak.
5. Be strong on LED-display terminology: ${LED_GLOSSARY.join(', ')}.
6. Preserve every number, quantity, price, currency, dimension, voltage, refresh rate, date, model code, proper name and brand exactly. Never invent or round a number.
7. Never answer a question on behalf of the speaker. If the source says "Sản phẩm của mày có gì tốt hơn thằng kia?", translate that question; do not answer it.
8. Never add advice, opinions, apologies, context or facts that the speaker did not say.
9. If the internal instruction contains [UNCLEAR_CRITICAL], briefly ask the target listener to repeat the unclear critical detail instead of guessing.
10. For Vietnamese output: sound like a natural adult woman from Southern Vietnam, warm, clear and professional, with a natural Southern/Saigon style if the selected voice supports it. Do not sound like a newsreader or robot.
11. Keep spoken output concise and natural. Do not make a short casual sentence unnecessarily formal or long.

COMMAND SEMANTICS USED BY THE APP
- "Mimi nói" means Person 1 -> Person 2.
- "Mimi dịch" means Person 2 -> Person 1.
The app detects these commands and sends you [MIMI_EXECUTE]; do not execute directly from hearing the command in live audio.
`.trim();
}

function buildExecutionPrompt(type, sourceText) {
  const source = type === 'SPEAK' ? state.lang1 : state.lang2;
  const target = type === 'SPEAK' ? state.lang2 : state.lang1;
  return `
[MIMI_EXECUTE]
SOURCE_LANGUAGE: ${source.name} (${source.code})
TARGET_LANGUAGE: ${target.name} (${target.code})
SOURCE_TEXT:
${sourceText}

Translate SOURCE_TEXT naturally and faithfully into TARGET_LANGUAGE. Speak only the translation. Preserve all numbers, technical terms, brands, product codes and meaning. Do not answer the content and do not add commentary.
`.trim();
}

async function fetchEphemeralToken() {
  const response = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    cache: 'no-store',
    body: JSON.stringify({ model: MODEL }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.token) {
    throw new Error(data.error || 'Không lấy được Gemini ephemeral token từ backend.');
  }
  return data.token;
}

function sendJson(payload) {
  if (state.ws?.readyState !== WebSocket.OPEN) return false;
  state.ws.send(JSON.stringify(payload));
  return true;
}

function sendAudio(base64Pcm) {
  if (!state.running || state.playGate || state.ws?.readyState !== WebSocket.OPEN) return;
  sendJson({
    realtimeInput: {
      audio: {
        data: base64Pcm,
        mimeType: 'audio/pcm;rate=16000',
      },
    },
  });
}

async function connectGemini() {
  const token = await fetchEphemeralToken();
  const url = `${WS_ENDPOINT}?access_token=${encodeURIComponent(token)}`;

  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    state.ws = ws;
    let settled = false;

    const fail = (error) => {
      if (!settled) {
        settled = true;
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    };

    ws.onopen = () => {
      const setupMessage = {
        setup: {
          model: `models/${MODEL}`,
          generationConfig: {
            responseModalities: ['AUDIO'],
            speechConfig: {
              voiceConfig: {
                prebuiltVoiceConfig: { voiceName: VOICE_NAME },
              },
            },
          },
          systemInstruction: {
            parts: [{ text: buildSystemInstruction() }],
          },
          realtimeInputConfig: {
            automaticActivityDetection: {
              disabled: false,
              startOfSpeechSensitivity: 'START_SENSITIVITY_LOW',
              endOfSpeechSensitivity: 'END_SENSITIVITY_LOW',
              prefixPaddingMs: 80,
              silenceDurationMs: 520,
            },
          },
          inputAudioTranscription: {
            adaptationPhrases: ['Mimi nói', 'Mimi dịch', 'Mi Mi nói', 'Mi Mi dịch', ...LED_GLOSSARY.slice(0, 40)],
            customVocabulary: ['Mimi', ...LED_GLOSSARY],
          },
          outputAudioTranscription: {},
        },
      };
      ws.send(JSON.stringify(setupMessage));
    };

    ws.onmessage = async (event) => {
      try {
        const raw = typeof event.data === 'string' ? event.data : await event.data.text();
        const response = JSON.parse(raw);

        if (response.setupComplete && !settled) {
          settled = true;
          resolve();
          return;
        }

        await handleServerMessage(response);
      } catch (error) {
        console.error('Mimi message handling error:', error);
      }
    };

    ws.onerror = () => fail(new Error('Không kết nối được Gemini Live API.'));

    ws.onclose = (event) => {
      if (!settled) fail(new Error(`Gemini đóng kết nối (${event.code}).`));
      if (state.running && !state.connecting) {
        setStatus('error', 'Mất kết nối Gemini');
        showError('Kết nối Gemini đã bị đóng. Bấm KẾT THÚC rồi BẮT ĐẦU lại để tạo phiên mới.');
      }
    };
  });
}

async function handleServerMessage(response) {
  const content = response.serverContent;
  if (!content) return;

  if (content.inputTranscription?.text && state.running && !state.playGate) {
    const merged = mergeTranscript(
      state.transcriptBuffer,
      content.inputTranscription.text,
      state.lastInputChunk,
    );
    state.transcriptBuffer = merged.buffer;
    state.lastInputChunk = merged.lastChunk;
    maybeHandleCommand();
  }

  if (content.outputTranscription?.text && state.playGate) {
    state.translationHasOutput = true;
    state.outputTranscript += content.outputTranscription.text;
  }

  if (content.modelTurn?.parts) {
    for (const part of content.modelTurn.parts) {
      if (part.inlineData?.data && state.playGate) {
        state.translationHasOutput = true;
        await state.player.enqueueBase64Pcm16(part.inlineData.data, 24000);
      }
    }
  }

  if (content.interrupted && state.playGate) {
    // We suppress mic transmission while Mimi speaks, but keep this as a safety net.
    state.player.stopAll();
  }

  if (content.turnComplete && state.playGate && state.translationHasOutput) {
    await finishTranslation();
  }
}

function maybeHandleCommand() {
  const now = Date.now();
  if (now - state.lastCommandAt < 2500) return;

  const command = detectMimiCommand(state.transcriptBuffer);
  if (!command) return;

  const sourceText = (command.sourceText || '').trim();
  if (!sourceText) return;

  state.lastCommandAt = now;
  executeTranslation(command.type, sourceText).catch((error) => {
    console.error(error);
    recoverFromTranslationError(error.message || 'Không dịch được.');
  });
}

async function executeTranslation(type, sourceText) {
  if (state.playGate || !state.running) return;

  state.playGate = true;
  state.translationHasOutput = false;
  state.outputTranscript = '';
  state.transcriptBuffer = '';
  state.lastInputChunk = '';
  state.mic.pauseSending();
  state.player.resetTurn();
  clearTimeout(state.translationTimeout);

  setStatus('translating', 'Mimi đang phiên dịch...');
  els.startLabel.textContent = 'ĐANG DỊCH';
  document.body.classList.add('is-translating');

  const prompt = buildExecutionPrompt(type, sourceText);
  if (!sendJson({ realtimeInput: { text: prompt } })) {
    throw new Error('Kết nối Gemini chưa sẵn sàng.');
  }

  state.translationTimeout = setTimeout(() => {
    if (state.playGate && !state.translationHasOutput) {
      recoverFromTranslationError('Mimi chưa nhận được bản dịch. Hãy thử nói lại rồi gọi lệnh lần nữa.');
    }
  }, 18000);
}

async function finishTranslation() {
  clearTimeout(state.translationTimeout);
  setStatus('speaking', 'Mimi đang nói...');
  els.startLabel.textContent = 'MIMI ĐANG NÓI';

  await state.player.waitUntilDrained(140);
  if (!state.running) return;

  state.playGate = false;
  state.translationHasOutput = false;
  state.transcriptBuffer = '';
  state.lastInputChunk = '';
  state.outputTranscript = '';
  state.mic.resumeSending();
  document.body.classList.remove('is-translating');
  els.startLabel.textContent = 'KẾT THÚC';
  setStatus('listening', 'Mimi đang nghe...');
}

function recoverFromTranslationError(message) {
  clearTimeout(state.translationTimeout);
  state.player?.stopAll();
  state.playGate = false;
  state.translationHasOutput = false;
  state.transcriptBuffer = '';
  state.lastInputChunk = '';
  state.mic?.resumeSending();
  document.body.classList.remove('is-translating');
  els.startLabel.textContent = state.running ? 'KẾT THÚC' : 'BẮT ĐẦU';
  setStatus(state.running ? 'listening' : 'ready', state.running ? 'Mimi đang nghe...' : 'Sẵn sàng lắng nghe');
  showError(message);
}

async function startMimi() {
  if (state.running || state.connecting) return;
  hideError();

  const l1 = languageByCode(els.lang1.value);
  const l2 = languageByCode(els.lang2.value);
  if (l1.code === l2.code) {
    showError('Hãy chọn hai ngôn ngữ khác nhau.');
    return;
  }

  state.lang1 = l1;
  state.lang2 = l2;
  state.connecting = true;
  els.startBtn.disabled = true;
  els.lang1.disabled = true;
  els.lang2.disabled = true;
  els.startLabel.textContent = 'ĐANG KẾT NỐI';
  setStatus('connecting', 'Đang kết nối Mimi...');

  try {
    state.player = new PcmOutputPlayer({
      onStart: () => setStatus('speaking', 'Mimi đang nói...'),
    });
    // Prime the audio context inside the user's click gesture path for iPhone Safari.
    await state.player.ensureContext();

    state.mic = new MicrophoneCapture({
      gateEnabled: true,
      onPcmChunk: sendAudio,
      onLevel: updateMicMeter,
      onError: (error) => console.error('Mic processing:', error),
    });

    await state.mic.start();
    await connectGemini();

    state.running = true;
    state.connecting = false;
    state.transcriptBuffer = '';
    state.lastInputChunk = '';
    state.playGate = false;
    state.lastCommandAt = 0;
    els.startBtn.disabled = false;
    els.startLabel.textContent = 'KẾT THÚC';
    els.startBtn.classList.add('running');
    setStatus('listening', 'Mimi đang nghe...');
    await requestWakeLock();
  } catch (error) {
    console.error(error);
    state.connecting = false;
    await stopMimi({ keepError: true });
    showError(error.message || 'Không thể khởi động Mimi.');
  }
}

async function stopMimi({ keepError = false } = {}) {
  clearTimeout(state.translationTimeout);
  state.running = false;
  state.connecting = false;
  state.playGate = false;
  state.translationHasOutput = false;
  state.transcriptBuffer = '';
  state.lastInputChunk = '';
  state.outputTranscript = '';

  try {
    if (state.ws?.readyState === WebSocket.OPEN) {
      state.ws.send(JSON.stringify({ realtimeInput: { audioStreamEnd: true } }));
      state.ws.close(1000, 'Mimi stopped');
    }
  } catch {}
  state.ws = null;

  state.player?.stopAll();
  await state.mic?.stop().catch(() => {});
  state.mic = null;
  await releaseWakeLock();
  updateMicMeter(0);

  els.lang1.disabled = false;
  els.lang2.disabled = false;
  els.startBtn.disabled = false;
  els.startBtn.classList.remove('running');
  els.startLabel.textContent = 'BẮT ĐẦU';
  document.body.classList.remove('is-translating');
  setStatus('ready', 'Sẵn sàng lắng nghe');
  if (!keepError) hideError();
}

els.startBtn.addEventListener('click', async () => {
  if (state.running || state.connecting) await stopMimi();
  else await startMimi();
});

els.dismissError.addEventListener('click', hideError);

document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState === 'visible' && state.running && !state.wakeLock) {
    await requestWakeLock();
  }
});

window.addEventListener('pagehide', () => {
  try { state.ws?.close(1000, 'Page hidden'); } catch {}
});

function detectStandalone() {
  const standalone = window.matchMedia?.('(display-mode: standalone)').matches || window.navigator.standalone;
  const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
  if (isIOS && !standalone) els.installHint.hidden = false;
}

async function registerServiceWorker() {
  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    try { await navigator.serviceWorker.register('./service-worker.js'); } catch (error) {
      console.warn('Service worker:', error);
    }
  }
}

populateLanguages();
detectStandalone();
registerServiceWorker();
setStatus('ready', 'Sẵn sàng lắng nghe');
