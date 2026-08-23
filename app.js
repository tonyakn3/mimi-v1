import { detectMimiCommand, mergeTranscript, stripCommandFallback } from './commands.js';
import { MicrophoneCapture, PcmOutputPlayer, bytesToBase64 } from './audio.js';

const MODEL = 'gemini-3.1-flash-live-preview';
const VOICE_NAME = 'Kore';
const TOKEN_ENDPOINT = '/api/live-token';
const COMMAND_DETECT_ENDPOINT = '/api/detect-command';
const TURN_RESOLVE_ENDPOINT = '/api/resolve-turn';
const MAX_TURN_AUDIO_BYTES = 16000 * 2 * 60; // keep the latest ~60 seconds of the active human turn
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

const COMMAND_TOOLS = [{
  functionDeclarations: [
    {
      name: 'mimi_speak',
      description: 'Call this function ONLY when the user clearly says the Vietnamese control phrase "Mimi nói". This means translate Person 1 to Person 2. Put the complete source utterance immediately before the command into source_text, excluding the words "Mimi nói". Do not call this for ordinary conversation that merely mentions Mimi.',
      parametersJsonSchema: {
        type: 'object',
        properties: {
          source_text: {
            type: 'string',
            description: 'Complete Person 1 utterance immediately preceding the command, excluding the command itself.'
          }
        },
        required: ['source_text'],
        additionalProperties: false
      }
    },
    {
      name: 'mimi_translate',
      description: 'Call this function ONLY when the user clearly says the Vietnamese control phrase "Mimi dịch". This means translate Person 2 to Person 1. Put the complete source utterance immediately before the command into source_text, excluding the words "Mimi dịch". This command must be recognized even while the conversation language is Chinese or another non-Vietnamese language.',
      parametersJsonSchema: {
        type: 'object',
        properties: {
          source_text: {
            type: 'string',
            description: 'Complete Person 2 utterance immediately preceding the command, excluding the command itself.'
          }
        },
        required: ['source_text'],
        additionalProperties: false
      }
    }
  ]
}];


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
  pendingCommand: null,
  localSpeechActive: false,
  lastAudioFlushAt: 0,
  currentSide: 1,
  activeCommandType: null,
  commandProbeCount: 0,
  commandProbeBusy: false,
  queuedCommandProbe: null,
  commandResolving: false,
  turnAudioChunks: [],
  turnAudioBytes: 0,
};

function clearTurnAudio() {
  state.turnAudioChunks = [];
  state.turnAudioBytes = 0;
}

function appendTurnAudio(pcmBytes) {
  if (!state.running || state.playGate) return;
  const bytes = pcmBytes instanceof Uint8Array ? pcmBytes : new Uint8Array(pcmBytes);
  if (!bytes.byteLength) return;

  const copy = bytes.slice();
  state.turnAudioChunks.push(copy);
  state.turnAudioBytes += copy.byteLength;

  while (state.turnAudioBytes > MAX_TURN_AUDIO_BYTES && state.turnAudioChunks.length > 1) {
    const removed = state.turnAudioChunks.shift();
    state.turnAudioBytes -= removed.byteLength;
  }
}

function currentTurnAudio() {
  if (!state.turnAudioBytes || !state.turnAudioChunks.length) return new Uint8Array(0);
  const out = new Uint8Array(state.turnAudioBytes);
  let offset = 0;
  for (const chunk of state.turnAudioChunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

function expectedCommandType() {
  return state.currentSide === 2 ? 'TRANSLATE' : 'SPEAK';
}

function commandLabel(type) {
  return type === 'TRANSLATE' ? 'Mimi dịch' : 'Mimi nói';
}

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

function compactTranscript(text, max = 88) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (!clean) return '';
  return clean.length > max ? `…${clean.slice(-(max - 1))}` : clean;
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

CRITICAL COMMAND + TRANSPORT RULE
- Live microphone audio is listening/transcription context only. NEVER speak, answer, acknowledge, translate, or react to ordinary live microphone audio by itself.
- The client has a separate state-locked wake-word command engine. It recognizes only a final standalone control phrase: wake word "Mimi" + the expected intent word ("nói" on Person 1 turn, "dịch" on Person 2 turn).
- Do not treat ordinary sentences that merely mention Mimi, nói, or dịch as commands.
- ONLY when the private internal text instruction begins exactly with [MIMI_EXECUTE] may you produce spoken audio.
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
The command engine is client-controlled and state-locked. Spoken output is allowed only after [MIMI_EXECUTE].
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


async function classifyCommandAudio(pcmBytes, sampleRate = 16000, expected = expectedCommandType()) {
  const bytes = pcmBytes instanceof Uint8Array ? pcmBytes : new Uint8Array(pcmBytes);
  if (bytes.byteLength < 1000) {
    return { command: 'NONE', wakeDetected: false, intentDetected: false };
  }

  // V1.8: wake-word + intent detector. The server evaluates "Mimi" and the
  // state-locked final word separately and rejects speech that continues after it.
  const maxBytes = Math.floor(sampleRate * 2 * 5.2);
  const tail = bytes.byteLength > maxBytes ? bytes.subarray(bytes.byteLength - maxBytes) : bytes;

  const response = await fetch(COMMAND_DETECT_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    cache: 'no-store',
    body: JSON.stringify({
      audio: bytesToBase64(tail),
      sampleRate,
      expected,
    }),
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || 'Command detector không phản hồi.');
  return {
    command: data.command === expected ? expected : 'NONE',
    wakeDetected: Boolean(data.wakeDetected),
    intentDetected: Boolean(data.intentDetected),
    speechAfterIntent: Boolean(data.speechAfterIntent),
    boundaryBeforeWake: Boolean(data.boundaryBeforeWake),
    isolatedCommand: Boolean(data.isolatedCommand),
  };
}

async function resolveCurrentTurnAudio(type, sampleRate = 16000) {
  const bytes = currentTurnAudio();
  if (bytes.byteLength < 1000) return '';

  const source = type === 'SPEAK' ? state.lang1 : state.lang2;
  const response = await fetch(TURN_RESOLVE_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    cache: 'no-store',
    body: JSON.stringify({
      audio: bytesToBase64(bytes),
      sampleRate,
      expected: type,
      sourceLanguage: `${source.name} (${source.code})`,
    }),
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || 'Không chốt được câu nguồn.');
  if (!data.commandDetected) return '';
  return stripCommandFallback(String(data.sourceText || '')).trim();
}

async function executeOrPendDetectedCommand(type, label = commandLabel(type)) {
  if (!state.running || state.playGate || state.commandResolving) return;
  if (type !== expectedCommandType()) return;

  const now = Date.now();
  if (now - state.lastCommandAt < 800) return;

  state.commandResolving = true;
  state.lastCommandAt = now;
  setStatus('translating', `Đã nhận lệnh “${label}”`);

  try {
    // V1.8: recover source from the actual PCM of the whole current turn after the command is confirmed.
    // This makes Person 2 -> Person 1 independent of Live transcription order.
    let sourceText = '';
    try {
      sourceText = await resolveCurrentTurnAudio(type, 16000);
    } catch (error) {
      console.warn('Turn audio resolver:', error);
    }

    // Fast fallback when the Live transcript is already complete.
    if (!sourceText) sourceText = stripCommandFallback(state.transcriptBuffer).trim();

    if (!sourceText) {
      state.pendingCommand = { type, at: Date.now(), detector: 'audio' };
      setStatus('listening', `Đã nghe “${label}” · đang chốt câu...`);
      return;
    }

    state.pendingCommand = null;
    await executeTranslation(type, sourceText);
  } catch (error) {
    console.error(error);
    await recoverFromTranslationError(error.message || 'Không dịch được.');
  } finally {
    state.commandResolving = false;
  }
}

async function runQueuedCommandProbe() {
  if (state.commandProbeBusy || !state.queuedCommandProbe || !state.running || state.playGate) return;

  const probe = state.queuedCommandProbe;
  state.queuedCommandProbe = null;
  state.commandProbeBusy = true;
  state.commandProbeCount = 1;

  try {
    // State may have changed while an earlier probe was being processed. Never
    // allow a command from the wrong conversation side to execute.
    if (probe.expected !== expectedCommandType()) return;

    const result = await classifyCommandAudio(probe.pcmBytes, probe.sampleRate, probe.expected);
    if (!state.running || state.playGate || probe.expected !== expectedCommandType()) return;

    if (result.command === probe.expected) {
      setStatus('listening', `Đã nghe “Mimi” → lệnh “${probe.expected === 'TRANSLATE' ? 'dịch' : 'nói'}”`);
      await executeOrPendDetectedCommand(probe.expected, commandLabel(probe.expected));
      return;
    }

    // Diagnostic feedback: this tells us whether iPhone/Gemini heard the wake
    // word but missed the final intent, without ever executing a partial command.
    if (result.wakeDetected) {
      const intent = probe.expected === 'TRANSLATE' ? 'dịch' : 'nói';
      if (!result.intentDetected) {
        setStatus('listening', `Đã nghe “Mimi” · chưa nghe rõ “${intent}”`);
      } else if (result.speechAfterIntent) {
        setStatus('listening', `Nghe thấy “Mimi ${intent}” nhưng còn lời phía sau · không kích hoạt`);
      } else {
        setStatus('listening', `Nghe thấy “Mimi ${intent}” nhưng chưa đủ điều kiện lệnh`);
      }
    }
  } catch (error) {
    console.warn('Wake/intent command detector:', error);
  } finally {
    state.commandProbeBusy = false;
    state.commandProbeCount = 0;
    // If a newer utterance arrived while this request was in flight, process it
    // immediately instead of dropping it. This fixes the V1.7 race where the
    // Chinese source probe could make the following "Mimi dịch" disappear.
    if (state.queuedCommandProbe) queueMicrotask(() => runQueuedCommandProbe());
  }
}

function probeAudioForCommand(pcmBytes, sampleRate = 16000) {
  if (!state.running || state.playGate || state.commandResolving) return;
  const bytes = pcmBytes instanceof Uint8Array ? pcmBytes : new Uint8Array(pcmBytes);
  if (bytes.byteLength < 1000) return;

  const durationSeconds = bytes.byteLength / (sampleRate * 2);
  // A control phrase is short. Long source turns are already stored in the turn
  // buffer and transcribed by Live; skipping them prevents a slow detector call
  // from blocking the short command that follows.
  if (durationSeconds > 6.2) return;

  const expected = expectedCommandType();
  const copy = bytes.slice();

  // Keep the NEWEST utterance while a detector request is busy. In normal use the
  // newest short utterance after a source sentence is exactly "Mimi nói/dịch".
  state.queuedCommandProbe = { pcmBytes: copy, sampleRate, expected, at: Date.now() };
  runQueuedCommandProbe();
}

function maybeFulfillPendingCommand() {
  if (!state.pendingCommand || state.playGate || !state.running) return false;

  const now = Date.now();
  if (now - state.pendingCommand.at > 3200) {
    state.pendingCommand = null;
    return false;
  }

  let sourceText = stripCommandFallback(state.transcriptBuffer).trim();
  if (!sourceText) return false;

  const pending = state.pendingCommand;
  if (pending.type !== expectedCommandType()) { state.pendingCommand = null; return false; }
  state.pendingCommand = null;
  // Do not debounce the pending path here. The command timestamp was already set
  // when the audio detector heard it; waiting for another STT event can otherwise
  // make the command disappear permanently.
  state.lastCommandAt = now;
  setStatus('translating', pending.type === 'SPEAK'
    ? 'Đã nhận lệnh “Mimi nói”'
    : 'Đã nhận lệnh “Mimi dịch”');

  executeTranslation(pending.type, sourceText).catch((error) => {
    console.error(error);
    recoverFromTranslationError(error.message || 'Không dịch được.');
  });
  return true;
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
              startOfSpeechSensitivity: 'START_SENSITIVITY_HIGH',
              endOfSpeechSensitivity: 'END_SENSITIVITY_HIGH',
              prefixPaddingMs: 120,
              // Server fallback. Client-side hybrid VAD below usually flushes sooner.
              silenceDurationMs: 650,
            },
          },
          // Keep this intentionally minimal for maximum Live API compatibility.
          // The command detector below handles "Mimi nói" / "Mimi dịch" locally.
          inputAudioTranscription: {},
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

async function handleToolCall(toolCall) {
  if (!state.running || state.playGate || !toolCall?.functionCalls?.length) return;

  const functionResponses = [];
  let requested = null;

  for (const fc of toolCall.functionCalls) {
    const type = fc.name === 'mimi_speak'
      ? 'SPEAK'
      : fc.name === 'mimi_translate'
        ? 'TRANSLATE'
        : null;

    if (type && type !== expectedCommandType()) {
      functionResponses.push({
        name: fc.name,
        id: fc.id,
        response: { result: 'ignored_wrong_turn' },
      });
      continue;
    }

    if (!type) {
      functionResponses.push({
        name: fc.name,
        id: fc.id,
        response: { result: 'unsupported_tool' },
      });
      continue;
    }

    const fromTool = stripCommandFallback(String(fc.args?.source_text || '')).trim();
    const fromTranscript = stripCommandFallback(state.transcriptBuffer).trim();

    // Prefer input transcription when it already contains real source speech,
    // because it tends to preserve numbers/product codes verbatim. If Gemini's
    // command tool fires before transcription catches up, source_text from the
    // tool is the fallback that makes the reverse direction reliable.
    const sourceText = fromTranscript.length >= 2 ? fromTranscript : fromTool;

    requested = { type, sourceText, name: fc.name };

    functionResponses.push({
      name: fc.name,
      id: fc.id,
      response: { result: 'accepted_wait_for_mimi_execute' },
    });
  }

  // Gemini 3.1 Live function calls are synchronous, so acknowledge immediately
  // to unblock the session before starting the client's translation flow.
  if (functionResponses.length) {
    sendJson({ toolResponse: { functionResponses } });
  }

  if (!requested) return;

  const now = Date.now();
  if (now - state.lastCommandAt < 650) return;
  state.lastCommandAt = now;

  const label = requested.type === 'SPEAK' ? 'Mimi nói' : 'Mimi dịch';
  setStatus('translating', `Đã nhận lệnh “${label}”`);

  // If the tool arrives just ahead of transcription, wait only a fraction of a
  // second. This keeps the command feeling instant while still catching late STT.
  let sourceText = requested.sourceText;
  if (!sourceText) {
    await new Promise((resolve) => setTimeout(resolve, 260));
    sourceText = stripCommandFallback(state.transcriptBuffer).trim();
  }

  if (!sourceText) {
    state.pendingCommand = { type: requested.type, at: Date.now() };
    setStatus('listening', `Đã nghe “${label}” · đang chốt câu...`);
    return;
  }

  executeTranslation(requested.type, sourceText).catch((error) => {
    console.error(error);
    recoverFromTranslationError(error.message || 'Không dịch được.');
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

    // Visible feedback is important on iPhone: it proves the mic + Gemini STT path is alive.
    const heard = compactTranscript(state.transcriptBuffer);
    if (heard) setStatus('listening', `Mimi nghe: ${heard}`);

    if (!maybeFulfillPendingCommand()) maybeHandleCommand();
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
  if (state.playGate || !state.running) return;

  const now = Date.now();
  const command = detectMimiCommand(state.transcriptBuffer);
  if (!command) {
    // If the command transcript arrived before the source transcript, keep waiting
    // briefly for the asynchronous bilingual transcription to catch up.
    if (state.pendingCommand && now - state.pendingCommand.at > 2200) {
      state.pendingCommand = null;
    }
    return;
  }

  if (command.type !== expectedCommandType()) return;

  const sourceText = (command.sourceText || '').trim();
  if (!sourceText) {
    state.pendingCommand = { type: command.type, at: now };
    setStatus('listening', command.type === 'SPEAK'
      ? 'Đã nghe “Mimi nói” · đang chốt câu...'
      : 'Đã nghe “Mimi dịch” · đang chốt câu...');
    return;
  }

  // playGate prevents duplicate execution while a translation is running, so the
  // debounce only needs to suppress repeated STT partials of the same command.
  if (now - state.lastCommandAt < 700) return;

  state.pendingCommand = null;
  state.lastCommandAt = now;
  setStatus('translating', command.type === 'SPEAK' ? 'Đã nhận lệnh “Mimi nói”' : 'Đã nhận lệnh “Mimi dịch”');
  executeTranslation(command.type, sourceText).catch((error) => {
    console.error(error);
    recoverFromTranslationError(error.message || 'Không dịch được.');
  });
}

function flushAudioTurnFast() {
  if (!state.running || state.playGate || state.ws?.readyState !== WebSocket.OPEN) return;
  const now = Date.now();
  if (now - state.lastAudioFlushAt < 350) return;
  state.lastAudioFlushAt = now;
  // Hybrid VAD: Google recommends audioStreamEnd when the client detects that
  // speech has ended. The same Live session may resume receiving audio afterward.
  sendJson({ realtimeInput: { audioStreamEnd: true } });
}

async function executeTranslation(type, sourceText) {
  if (state.playGate || !state.running) return;

  state.playGate = true;
  state.pendingCommand = null;
  state.activeCommandType = type;
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

  // Explicitly close the current mic stream turn before sending the private execution text.
  // This prevents the final spoken command from remaining buffered together with the text trigger.
  sendJson({ realtimeInput: { audioStreamEnd: true } });
  await new Promise((resolve) => setTimeout(resolve, 140));

  const prompt = buildExecutionPrompt(type, sourceText);
  if (!sendJson({ realtimeInput: { text: prompt } })) {
    throw new Error('Kết nối Gemini chưa sẵn sàng.');
  }

  state.translationTimeout = setTimeout(() => {
    if (state.playGate && !state.translationHasOutput) {
      recoverFromTranslationError('Mimi chưa nhận được bản dịch. Hãy thử nói lại rồi gọi lệnh lần nữa.');
    }
  }, 25000);
}

async function finishTranslation() {
  clearTimeout(state.translationTimeout);
  setStatus('speaking', 'Mimi đang nói...');
  els.startLabel.textContent = 'MIMI ĐANG NÓI';

  await state.player.waitUntilDrained(140);
  if (!state.running) return;

  const completedCommand = state.activeCommandType;
  state.playGate = false;
  state.translationHasOutput = false;
  state.pendingCommand = null;
  state.transcriptBuffer = '';
  state.lastInputChunk = '';
  state.outputTranscript = '';
  clearTurnAudio();
  await state.mic.resumeSending();
  // iOS can finish switching its audio route a fraction later; a second resume is
  // cheap and prevents the capture context from staying suspended after playback.
  setTimeout(() => state.mic?.resumeSending().catch(() => {}), 300);
  state.currentSide = completedCommand === 'SPEAK' ? 2 : 1;
  state.activeCommandType = null;
  document.body.classList.remove('is-translating');
  els.startLabel.textContent = 'KẾT THÚC';
  setStatus('listening', state.currentSide === 1 ? 'Mimi đang nghe Người 1...' : 'Mimi đang nghe Người 2...');
}

async function recoverFromTranslationError(message) {
  clearTimeout(state.translationTimeout);
  state.player?.stopAll();
  state.playGate = false;
  state.translationHasOutput = false;
  state.activeCommandType = null;
  state.pendingCommand = null;
  state.transcriptBuffer = '';
  state.lastInputChunk = '';
  clearTurnAudio();
  state.commandResolving = false;
  await state.mic?.resumeSending();
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
      // IMPORTANT: never hard-gate microphone audio on-device. A soft or slightly
      // farther-away "Mimi dịch" must still reach Gemini. Browser noise suppression
      // + Gemini server VAD do the filtering; local VAD is only used as a fast turn hint.
      gateEnabled: false,
      onPcmBytes: appendTurnAudio,
      onPcmChunk: sendAudio,
      onLevel: updateMicMeter,
      onSpeechStart: () => { state.localSpeechActive = true; },
      onSpeechEnd: () => {
        state.localSpeechActive = false;
        flushAudioTurnFast();
      },
      // V1.8 authoritative command path: each finished short utterance goes to a
      // state-locked wake-word + intent detector. A busy detector keeps the newest
      // utterance queued, so the final "Mimi dịch" can never be dropped behind the
      // preceding Chinese source sentence.
      onUtterancePcm: (pcmBytes, sampleRate) => {
        probeAudioForCommand(pcmBytes, sampleRate);
      },
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
    state.lastAudioFlushAt = 0;
    state.pendingCommand = null;
    state.activeCommandType = null;
    state.commandProbeCount = 0;
    state.commandProbeBusy = false;
    state.queuedCommandProbe = null;
    state.commandResolving = false;
    clearTurnAudio();
    state.currentSide = 1;
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
  state.pendingCommand = null;
  state.activeCommandType = null;
  state.commandProbeCount = 0;
  state.commandProbeBusy = false;
  state.queuedCommandProbe = null;
  state.commandResolving = false;
  clearTurnAudio();
  state.currentSide = 1;

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
  if (document.visibilityState === 'visible' && state.running) {
    if (!state.wakeLock) await requestWakeLock();
    await state.mic?.resumeSending().catch(() => {});
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
