import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const PUBLIC_DIR = resolve(__dirname, 'public');
const PORT = Number(process.env.PORT || 3000);
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const PUBLIC_ORIGIN = process.env.PUBLIC_ORIGIN || '';
const COMMAND_MODEL = 'gemini-3.1-flash-lite';
const TRANSLATE_MODEL = 'gemini-3.5-flash';
const TTS_MODEL = 'gemini-3.1-flash-tts-preview';
const TTS_VOICE = process.env.MIMI_TTS_VOICE || 'Kore';

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json; charset=utf-8', '.png': 'image/png',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
};

const LED_GLOSSARY = [
  'LED display', 'màn hình LED', 'LED显示屏', 'pixel pitch', 'module', 'cabinet', 'receiving card', 'sending card', 'HUB board',
  'scan mode', 'refresh rate', 'grayscale', 'brightness', 'nits', 'SMD', 'COB', 'GOB', 'driver IC', 'power supply',
  'front maintenance', 'rear maintenance', 'indoor', 'outdoor', 'rental screen', 'fixed installation', 'NovaStar', 'Nova',
  'Colorlight', 'Huidu', '3840Hz', '7680Hz', 'ICN2053', 'Nationstar', 'Kinglight', 'P1.25', 'P1.5', 'P1.8', 'P2', 'P2.5', 'P2.6', 'P2.9', 'P3', 'P4',
];

function headers(extra = {}) {
  return {
    'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Permissions-Policy': 'microphone=(self)',
    'Cross-Origin-Opener-Policy': 'same-origin', ...extra,
  };
}
function json(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, headers({ 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store' }));
  res.end(body);
}
function originAllowed(req) {
  const origin = req.headers.origin; if (!origin) return true;
  if (PUBLIC_ORIGIN) return origin === PUBLIC_ORIGIN;
  const host = req.headers.host; return Boolean(host && (origin === `https://${host}` || origin === `http://${host}`));
}
async function readJsonBody(req, maxBytes = 4_500_000) {
  const chunks = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > maxBytes) throw new Error('BODY_TOO_LARGE'); chunks.push(chunk); }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
}
function pcm16ToWav(pcmBuffer, sampleRate = 16000) {
  const dataLength = pcmBuffer.length - (pcmBuffer.length % 2); const wav = Buffer.alloc(44 + dataLength);
  wav.write('RIFF', 0); wav.writeUInt32LE(36 + dataLength, 4); wav.write('WAVE', 8); wav.write('fmt ', 12); wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(sampleRate, 24); wav.writeUInt32LE(sampleRate * 2, 28);
  wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(dataLength, 40);
  pcmBuffer.copy(wav, 44, 0, dataLength); return wav;
}
function parseAudio(body) {
  const audio = String(body.audio || ''); const sampleRate = Number(body.sampleRate || 16000);
  if (!audio || !Number.isFinite(sampleRate) || sampleRate < 8000 || sampleRate > 48000) throw new Error('INVALID_AUDIO');
  return { pcm: Buffer.from(audio, 'base64'), sampleRate };
}
function languageLabel(value) {
  if (!value || typeof value !== 'object') return 'Unknown';
  return `${String(value.name || value.code || '').slice(0, 80)} (${String(value.code || '').slice(0, 24)})`;
}
function commandPhrase(expected) { return expected === 'REVERSE' ? 'dịch lại' : 'Mimi nói'; }

async function generateContent({ model, prompt, wav, generationConfig }) {
  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': GEMINI_API_KEY },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: prompt }, ...(wav ? [{ inlineData: { mimeType: 'audio/wav', data: wav.toString('base64') } }] : [])] }],
      ...(generationConfig ? { generationConfig } : {}),
    }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data?.error?.message || `Gemini HTTP ${response.status}`);
  return data;
}

async function detectCommand(pcm, sampleRate, expected) {
  if (pcm.length < 700) return { commandDetected: false, heardText: '' };
  const maxBytes = Math.floor(sampleRate * 2 * 7); const tail = pcm.length > maxBytes ? pcm.subarray(pcm.length - maxBytes) : pcm;
  const phrase = commandPhrase(expected);
  const prompt = [
    'You are a strict Vietnamese voice-command recognizer for a two-person interpreter app.',
    `The ONLY valid command in this state is exactly: "${phrase}".`,
    'The phrase may be spoken alone OR at the very end of a longer utterance. It is valid only if there is no meaningful speech after the command.',
    'Ignore punctuation, natural Southern Vietnamese pronunciation, mild room noise, and small pronunciation variations.',
    'Do not trigger merely because individual words appear separately. Do not trigger when the phrase is followed by more conversational content.',
    'Return JSON only. heardText should be a short transcription of the final words you heard.',
  ].join('\n');
  const data = await generateContent({
    model: COMMAND_MODEL, prompt, wav: pcm16ToWav(tail, sampleRate),
    generationConfig: {
      responseMimeType: 'application/json', responseSchema: {
        type: 'OBJECT', properties: { commandDetected: { type: 'BOOLEAN' }, heardText: { type: 'STRING' } },
        required: ['commandDetected', 'heardText'],
      },
    },
  });
  const text = (data?.candidates?.[0]?.content?.parts || []).map((p) => p?.text || '').join('').trim();
  const parsed = JSON.parse(text || '{}');
  return { commandDetected: Boolean(parsed.commandDetected), heardText: String(parsed.heardText || '').slice(0, 160) };
}

async function translateTurn({ pcm, sampleRate, commandPhrase: phrase, sourceLanguage, targetLanguage, direction }) {
  const source = languageLabel(sourceLanguage), target = languageLabel(targetLanguage);
  const prompt = [
    'You are Mimi, a professional human interpreter. This request is completely STATELESS: use ONLY the supplied audio and nothing from any earlier turn.',
    `Direction: ${direction}. Source language: ${source}. Target language: ${target}.`,
    `The audio contains the source speaker's current turn, followed at the end by the Vietnamese control phrase "${phrase}".`,
    `Extract ALL meaningful source speech BEFORE the final control phrase. Remove the control phrase itself. Then translate the extracted source naturally into ${target}.`,
    'Never answer the speaker. Never add explanations, advice, apologies, or information not spoken.',
    'Translate meaning naturally rather than word-for-word. Preserve directness, humor, politeness level, slang, local expressions and business intent.',
    'Understand Southern Vietnamese colloquial speech such as xài, hông, mắc, tao bao, and understand natural local/slang expressions in the other language from context.',
    `LED/technical glossary context: ${LED_GLOSSARY.join(', ')}. Keep brands, model names, product codes and established industry terms natural and accurate.`,
    'Preserve every number, price, currency, quantity, dimension, date, voltage, frequency, model code and proper name exactly. Never invent or round.',
    'If a critical number/model is genuinely unintelligible, set unclearCritical=true rather than guessing.',
    'Return JSON only with sourceText, translationText, unclearCritical.',
  ].join('\n');
  const data = await generateContent({
    model: TRANSLATE_MODEL, prompt, wav: pcm16ToWav(pcm, sampleRate),
    generationConfig: {
      responseMimeType: 'application/json', responseSchema: {
        type: 'OBJECT', properties: {
          sourceText: { type: 'STRING' }, translationText: { type: 'STRING' }, unclearCritical: { type: 'BOOLEAN' },
        }, required: ['sourceText', 'translationText', 'unclearCritical'],
      },
    },
  });
  const text = (data?.candidates?.[0]?.content?.parts || []).map((p) => p?.text || '').join('').trim();
  const parsed = JSON.parse(text || '{}');
  return {
    sourceText: String(parsed.sourceText || '').trim(), translationText: String(parsed.translationText || '').trim(),
    unclearCritical: Boolean(parsed.unclearCritical),
  };
}

async function synthesizeSpeech(text, language) {
  const isVietnamese = String(language?.code || '').toLowerCase().startsWith('vi');
  const profile = isVietnamese
    ? 'Speak as a natural adult Vietnamese woman from Southern Vietnam/Saigon: warm, clear, professional, conversational, natural pace, not a newsreader and not robotic.'
    : `Speak as a natural adult female interpreter in ${languageLabel(language)}: clear, professional, conversational, natural pace.`;
  const prompt = `${profile}\nRead EXACTLY the translation below. Do not add, remove, explain, paraphrase, or introduce it.\n\nTRANSLATION:\n${text}`;
  const data = await generateContent({
    model: TTS_MODEL, prompt,
    generationConfig: {
      responseModalities: ['AUDIO'], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: TTS_VOICE } } },
    },
  });
  const part = (data?.candidates?.[0]?.content?.parts || []).find((p) => p?.inlineData?.data);
  if (!part?.inlineData?.data) throw new Error('Gemini TTS không trả audio.');
  return { audio: part.inlineData.data, sampleRate: 24000 };
}

async function serveStatic(req, res, pathname) {
  let requested = decodeURIComponent(pathname); if (requested === '/') requested = '/index.html';
  const safePath = normalize(requested).replace(/^(\.\.(\/|\\|$))+/, '');
  const filePath = resolve(PUBLIC_DIR, `.${safePath.startsWith('/') ? safePath : `/${safePath}`}`);
  if (!filePath.startsWith(PUBLIC_DIR)) { json(res, 403, { error: 'Forbidden' }); return; }
  try {
    const info = await stat(filePath); const actual = info.isDirectory() ? join(filePath, 'index.html') : filePath; const data = await readFile(actual);
    const ext = extname(actual).toLowerCase();
    res.writeHead(200, headers({ 'Content-Type': MIME[ext] || 'application/octet-stream', 'Content-Length': data.length, 'Cache-Control': /\/icons\//.test(actual) ? 'public, max-age=86400' : 'no-cache, no-store, must-revalidate' })); res.end(data);
  } catch {
    const index = await readFile(join(PUBLIC_DIR, 'index.html')); res.writeHead(200, headers({ 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': index.length, 'Cache-Control': 'no-cache, no-store, must-revalidate' })); res.end(index);
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    if (url.pathname === '/api/health' && req.method === 'GET') {
      json(res, 200, { ok: true, version: '2.0.1', apiKeyConfigured: Boolean(GEMINI_API_KEY), commandModel: COMMAND_MODEL, translateModel: TRANSLATE_MODEL, ttsModel: TTS_MODEL }); return;
    }
    if (url.pathname.startsWith('/api/') && !originAllowed(req)) { json(res, 403, { error: 'Origin không được phép.' }); return; }
    if (url.pathname.startsWith('/api/') && !GEMINI_API_KEY) { json(res, 503, { error: 'Backend chưa có GEMINI_API_KEY.' }); return; }

    if (url.pathname === '/api/detect-command' && req.method === 'POST') {
      try {
        const body = await readJsonBody(req, 1_100_000); const { pcm, sampleRate } = parseAudio(body);
        const expected = body.expected === 'REVERSE' ? 'REVERSE' : 'SPEAK'; const result = await detectCommand(pcm, sampleRate, expected);
        json(res, 200, { ...result, expected, phrase: commandPhrase(expected) });
      } catch (error) { console.error('detect-command:', error.message); json(res, 502, { error: `Không nhận diện được câu lệnh: ${error.message}` }); }
      return;
    }

    if (url.pathname === '/api/translate-turn' && req.method === 'POST') {
      try {
        const body = await readJsonBody(req, 4_600_000); const { pcm, sampleRate } = parseAudio(body);
        const phrase = String(body.commandPhrase || '').slice(0, 40); if (!phrase) throw new Error('MISSING_COMMAND');
        const result = await translateTurn({ pcm, sampleRate, commandPhrase: phrase, sourceLanguage: body.sourceLanguage, targetLanguage: body.targetLanguage, direction: String(body.direction || '') });
        json(res, 200, result);
      } catch (error) { console.error('translate-turn:', error.message); json(res, 502, { error: `Không dịch được lượt nói: ${error.message}` }); }
      return;
    }

    if (url.pathname === '/api/tts' && req.method === 'POST') {
      try {
        const body = await readJsonBody(req, 80_000); const text = String(body.text || '').trim(); if (!text || text.length > 12000) throw new Error('INVALID_TEXT');
        const result = await synthesizeSpeech(text, body.language || {}); json(res, 200, result);
      } catch (error) { console.error('tts:', error.message); json(res, 502, { error: `Không tạo được giọng nói: ${error.message}` }); }
      return;
    }

    if (!['GET', 'HEAD'].includes(req.method || '')) { json(res, 405, { error: 'Method not allowed' }); return; }
    await serveStatic(req, res, url.pathname);
  } catch (error) { console.error(error); json(res, 500, { error: 'Server error' }); }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Mimi V2.0.1 Schema Fix đang chạy tại http://localhost:${PORT}`);
  console.log(`Gemini API key: ${GEMINI_API_KEY ? 'đã cấu hình' : 'CHƯA cấu hình'}`);
  console.log(`Models: command=${COMMAND_MODEL}, translate=${TRANSLATE_MODEL}, tts=${TTS_MODEL}`);
});
